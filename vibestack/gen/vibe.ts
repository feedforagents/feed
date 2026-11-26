// The Effect face of a generated module, in VibeLang: gen/<name>.effect.vibe beside gen/<name>.ts. It is read off the
// generated TypeScript itself, so it cannot say anything that module does not.
import type * as TS from "typescript";
import { tsApi } from "../util.ts";
import { HELPERS } from "./typescript.ts";
import { fail } from "./types.ts";

/** Helpers the generated module exports for its own use (typescript.ts), and the proof obligation of `initial`. */
const INTERNAL = new RegExp(`^(?:${HELPERS.join("|")})_|^initialHolds$`);
/** The adapter's typed failures. */
const FAILURES = ["Rejected", "NotAnEvent", "NotAState", "NotASender"];
/** What the adapter itself exports for a state machine; a spec that binds one of these cannot have an adapter. */
const OWN = [...FAILURES, "Machine", "machine", "machineOver", "stored", "apply", "decodeEvent", "decodeState", "decodeSender"];

/**
 * `text` is gen/<name>.ts. Every constant and function comes back under its own name from a TypeScript `module` body,
 * the one place a `.vibe` file states what a function throws: effect code may then call them bare. They throw nothing
 * the program should handle: the one exception generated code raises, a RangeError past 2^53, is a defect.
 * A state machine also gets typed failures for what `parseEvent`, `parseState` and `enabled` refuse, and a `Machine`
 * service that applies one event at a time to the state where it is kept: in memory (`machine`), in a store
 * (`stored`) or wherever the shell loads and keeps it (`machineOver`).
 */
export function effectAdapter(name: string, source: string, text: string, namespace: string): string {
  const ts = tsApi();
  const file = ts.createSourceFile(`${name}.ts`, text, ts.ScriptTarget.Latest, true);
  const exported = (s: TS.Statement) => ts.canHaveModifiers(s) && !!ts.getModifiers(s)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const types = file.statements.filter((s): s is TS.TypeAliasDeclaration | TS.InterfaceDeclaration => (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && exported(s)).map((s) => s.name.text);
  // A type of another module is spelled <module>_<name> in signatures, as the generated module imports it.
  const foreign = file.statements.filter(ts.isImportDeclaration).flatMap((s) => {
    const names = s.importClause?.namedBindings && ts.isNamedImports(s.importClause.namedBindings) ? s.importClause.namedBindings.elements.filter((e) => e.isTypeOnly) : [];
    return names.length ? [`  import type { ${names.map((e) => `${e.propertyName!.text} as ${e.name.text}`).join(", ")} } from ${s.moduleSpecifier.getText(file)}`] : [];
  });
  const doc = (s: TS.Node) => {
    const said = ts.getJSDocCommentsAndTags(s).filter(ts.isJSDoc).map((d) => ts.getTextOfJSDocComment(d.comment) ?? "").join(" ").replace(/\s+/g, " ").trim();
    return `  /** ${said ? `${said} ` : ""}@throws {never} */`;
  };
  const consts = file.statements.filter((s): s is TS.VariableStatement => ts.isVariableStatement(s) && exported(s)).flatMap((s) =>
    s.declarationList.declarations.map((d) => ({ name: d.name.getText(file), line: `${doc(s)}\n  export const ${d.name.getText(file)}: ${d.type!.getText(file)} = M.${d.name.getText(file)}` })));
  const funs = file.statements.filter((s): s is TS.FunctionDeclaration => ts.isFunctionDeclaration(s) && exported(s) && !INTERNAL.test(s.name!.text));
  const wrapper = (f: TS.FunctionDeclaration) => {
    const params = f.parameters.map((p) => p.getText(file)).join(", ");
    return `${doc(f)}\n  export function ${f.name!.text}(${params}): ${f.type!.getText(file)} { return M.${f.name!.text}(${f.parameters.map((p) => p.name.getText(file)).join(", ")}) }`;
  };
  const names = [...consts.map((c) => c.name), ...funs.map((f) => f.name!.text)];
  const freeze = `snapshot_${name}`;
  const capture = `snapshot_in_${name}`;
  const storedCache = `snapshot_cache_${name}`;
  const step = funs.find((f) => f.name!.text === "step");
  const body = names.length ? [
    `module pure {`,
    `  import * as M from "./${name}.ts"`,
    ...(types.length ? [`  import type { ${types.join(", ")} } from "./${name}.ts"`] : []),
    ...foreign,
    ...consts.map((c) => c.line),
    ...funs.map(wrapper),
    ...(step ? [
      `  /** @throws {never} */`,
      `  export function ${freeze}<A>(value: A): A {`,
      `    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value`,
      `    Object.freeze(value)`,
      `    if (Array.isArray(value)) {`,
      `      for (let i = 0; i < value.length; i++) ${freeze}(value[i])`,
      `    } else {`,
      `      for (const key of Object.keys(value)) ${freeze}((value as Record<string, unknown>)[key])`,
      `    }`,
      `    return value`,
      `  }`,
      `  /** @throws {never} */`,
      `  export function ${capture}<A>(value: A): A {`,
      `    if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value`,
      `    if (Array.isArray(value)) {`,
      `      const copy: unknown[] = new Array(value.length)`,
      `      for (let i = 0; i < value.length; i++) copy[i] = ${capture}(value[i])`,
      `      return Object.freeze(copy) as A`,
      `    }`,
      `    const copy: Record<string, unknown> = {}`,
      `    for (const key of Object.keys(value)) copy[key] = ${capture}((value as Record<string, unknown>)[key])`,
      `    return Object.freeze(copy) as A`,
      `  }`,
    ] : []),
    `}`,
    `import { ${[...names, ...step ? [freeze, capture] : []].join(", ")} } from pure`,
    `export { ${names.join(", ")} }`,
  ] : [];
  const out = [
    `// GENERATED from ${source} by vibestack/spec.ts. Do not edit: change the spec and run \`pnpm gen\`.`,
    `// gen/${name}.ts for Effect code: its definitions as functions that throw nothing${step ? ", and its state machine as typed failures and a service" : ""}.`,
    `export type * from "./${name}.ts"`,
    ``,
    ...body,
  ];
  if (!step) return [...out, ``].join("\n");

  const clash = OWN.find((n) => names.includes(n) || types.includes(n));
  if (clash) fail(`${source}: \`${clash}\` is a name of the generated Effect adapter (gen/${name}.effect.vibe); name the definition otherwise`);
  // A type the module exports is named through it; any other is read off `step`, so that no name of the spec is bound here.
  const typed = (node: TS.TypeNode, otherwise: string) => (types.includes(node.getText(file)) ? `T.${node.getText(file)}` : otherwise);
  const state = typed(step.parameters[0].type!, "Parameters<typeof step>[0]");
  const stepped = typed(step.type!, "ReturnType<typeof step>");
  const sender = step.parameters[2] && typed(step.parameters[2].type!, "Parameters<typeof step>[2]");
  const emits = step.type!.getText(file) !== step.parameters[0].type!.getText(file);
  const by = sender ? `, by: ${sender}` : "";
  const passed = sender ? ", by" : "";
  const guard = `, isCurrent?: (state: ${state}) => boolean`;
  return [
    ...out,
    `import * as KeyValueStore from "effect/persistence/KeyValueStore"`,
    `import { PreventSchedulerYield } from "effect/References"`,
    `import type * as T from "./${name}.ts"`,
    ``,
    `/** The rules do not allow this event in this state${sender ? " from this sender" : ""}. */`,
    `export error Rejected { event: T.Event; state: ${state}${sender ? `; by: ${sender}` : ""} }`,
    `/** An untrusted value that is not an event. */`,
    `export error NotAnEvent { input: unknown }`,
    `/** An untrusted value that is not a state satisfying every \`always\` rule. */`,
    `export error NotAState { input: unknown }`,
    ...(sender ? [`/** An untrusted value that is not a sender. */`, `export error NotASender { input: unknown }`] : []),
    ``,
    `/** \`parseEvent\`, failing where it returns undefined. */`,
    `export effect function decodeEvent(input: unknown): T.Event!NotAnEvent {`,
    `  const event = parseEvent(input)`,
    `  if (event === undefined) throw new NotAnEvent({ input })`,
    `  return ${freeze}(event)`,
    `}`,
    ``,
    `/** \`parseState\`, failing where it returns undefined. */`,
    `export effect function decodeState(input: unknown): ${state}!NotAState {`,
    `  const parsed = parseState(input)`,
    `  if (parsed === undefined) throw new NotAState({ input })`,
    `  return ${freeze}(parsed)`,
    `}`,
    ...(sender ? [
      ``,
      `/** \`parseSender\`, failing where it returns undefined. */`,
      `export effect function decodeSender(input: unknown): ${sender}!NotASender {`,
      `  const parsed = parseSender(input)`,
      `  if (parsed === undefined) throw new NotASender({ input })`,
      `  return ${freeze}(parsed)`,
      `}`,
    ] : []),
    ``,
    `/** \`step\`, failing where \`enabled\` refuses the event instead of leaving the state unchanged. */`,
    `export effect function apply(current: ${state}, event: T.Event${by}): ${stepped}!Rejected {`,
    `  if (!enabled(current, event${passed})) throw new Rejected({ event, state: current${passed} })`,
    `  return step(current, event${passed})`,
    `}`,
    ``,
    `/** The state, and the one way to change it: an event the rules allow, applied before the next is looked at. */`,
    `export service Machine {`,
    // VibeLang derives a key from the nearest package.json's name, and gen/package.json has none (genDir in units.ts).
    // The package and the spec together name a machine: two packages may each have spec/index.md.
    `  static readonly key = ${JSON.stringify(`${namespace}/${source}#Machine`)}`,
    `  /** The state the Machine was made with, or the last one an event sent to it led to; then each one an event sent to it leads to. */`,
    `  readonly changes: Stream.Stream<${state}>`,
    `  /** The state as it is kept now. */`,
    `  get(): ${state}!!`,
    `  /** An event already parsed. An optional source check runs under the writer immediately before saving. A value from outside goes through \`receive\`. */`,
    `  send(event: T.Event${by}${guard}): ${stepped}!Rejected`,
    `  receive(input: unknown${by}): ${stepped}!(NotAnEvent | Rejected)`,
    `}`,
    ``,
    `/**`,
    ` * A Machine over a state kept elsewhere: \`load\` reads it and \`keep\` writes it. Each event is applied to what \`load\``,
    ` * reads when it is sent, so that a state another writer kept since is stepped from, never written over, and the state`,
    ` * it leads to goes to \`keep\` before \`send\` returns. It fails as the first \`load\` does; where a later \`load\` fails`,
    ` * or \`keep\` dies, \`send\` dies and the state stays as it was. It never shares a state with its callers.`,
    ` */`,
    `export effect function machineOver<E>(load: () => ${state}!E, keep: (next: ${state}) => void!!): Machine.Shape!E {`,
    `  const shown = try SubscriptionRef.make(${capture}(try load()))`,
    `  effect function send(event: T.Event${by}${guard}): ${stepped}!Rejected {`,
    `    const input = ${capture}({ event${passed} })`,
    `    uninterruptible {`,
    `      return try SubscriptionRef.modifyEffect(shown, effect () => {`,
    `        const current = ${capture}(try orDie(load()))`,
    `        const next = ${freeze}(try apply(current, input.event${sender ? ", input.by" : ""}))`,
    `        const nextState = ${emits ? "next.state" : "next"}`,
    `        const save = effect {`,
    `          if (isCurrent && !isCurrent(current)) throw new Rejected({ ...input, state: current })`,
    `          try keep(nextState)`,
    `        }`,
    `        try (isCurrent ? Effect.provideService(save, PreventSchedulerYield, true) : save)`,
    `        return [next, nextState] as const`,
    `      })`,
    `    }`,
    `  }`,
    `  return {`,
    `    changes: SubscriptionRef.changes(shown),`,
    `    effect get() { return ${capture}(try orDie(load())) },`,
    `    send,`,
    `    effect receive(input: unknown${by}) { return try send(try decodeEvent(input)${passed}) }`,
    `  }`,
    `}`,
    ``,
    `/** A Machine in memory, from \`initial\` or a state \`decodeState\` returned. */`,
    `export function machine(start: ${state} = initial) {`,
    `  return Layer.effect(Machine, effect {`,
    `    const kept = try Ref.make(start === initial ? ${freeze}(start) : ${capture}(start))`,
    `    return try machineOver(() => Ref.get(kept), (next) => Ref.set(kept, next))`,
    `  })`,
    `}`,
    ``,
    `const ${storedCache} = new WeakMap<object, Map<string, { readonly raw: string; readonly state: ${state} }>>()`,
    ``,
    `/**`,
    ` * A Machine kept in the KeyValueStore under \`key\`, as JSON: each event is applied to what is stored there when it`,
    ` * is sent, read through \`decodeState\`, or to \`start\` where nothing is, so that a state another page or program`,
    ` * stored since is stepped from, never written over. What is stored and is not a state fails the layer with NotAState,`,
    ` * and a later \`send\` dies on it, so that it is never written over either. Each state an event leads to is stored`,
    ` * before \`send\` returns: where the store does not take it, \`send\` dies and the state stays as it was.`,
    ` */`,
    `export function stored(key: string, start: ${state} = initial) {`,
    `  return Layer.effect(Machine, effect {`,
    `    const store = try KeyValueStore.KeyValueStore`,
    `    const fallback = start === initial ? ${freeze}(start) : ${capture}(start)`,
    `    let entries = ${storedCache}.get(store)`,
    `    if (entries === undefined) {`,
    `      entries = new Map()`,
    `      ${storedCache}.set(store, entries)`,
    `    }`,
    `    const cache = entries`,
    `    effect function load() {`,
    `      const found = try store.get(key)`,
    `      if (found === undefined) {`,
    `        cache.delete(key)`,
    `        return fallback`,
    `      }`,
    `      const cached = cache.get(key)`,
    `      if (cached !== undefined && cached.raw === found) return cached.state`,
    `      const decoded = try decodeState(try Effect.try({ try: () => JSON.parse(found) as unknown, catch: () => new NotAState({ input: found }) }))`,
    `      cache.set(key, { raw: found, state: decoded })`,
    `      return decoded`,
    `    }`,
    `    effect function keep(next: ${state}) {`,
    `      const cached = cache.get(key)`,
    `      if (cached !== undefined && Object.is(cached.state, next)) return`,
    `      const raw = JSON.stringify(next)`,
    `      if (cached !== undefined && cached.raw === raw) {`,
    `        cache.set(key, { raw, state: next })`,
    `        return`,
    `      }`,
    `      try orDie(store.set(key, raw))`,
    `      cache.set(key, { raw, state: next })`,
    `    }`,
    `    return try machineOver(load, keep)`,
    `  })`,
    `}`,
    ``,
  ].join("\n");
}
