import { createHash } from "node:crypto";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { installChromium, prepareChromiumShell } from "./chromium.ts";
import { cacheDirectory } from "./config.ts";
import { conformance, type Machine } from "./conform.ts";
import { explore } from "./explore.ts";
import { readSpecs } from "./parse.ts";
import { entry, remembered, steady, type Memory } from "./cache.ts";
import { findBin, onPath, startAttached } from "./run.ts";
import { simulation } from "./simulate.ts";
import { profile, type TestProfile } from "./testing/profile.ts";
import { generated, mirrorGen, typecheckAll } from "./units.ts";
import { codeDirs, packageScripts, type Reported } from "./util.ts";
import type { Model } from "./gen.ts";
import type { Spec } from "./parse.ts";

export interface CommandResult {
  ok: boolean;
  stage: string;
  summary: string;
  detail: string;
  where?: string;
}

export interface SimulationPrepFn {
  (root: string, specs: Spec[], targets: readonly string[], seedParent: string): Promise<{
    results: CommandResult[];
    seedDirectory?: string;
    partialDirectory?: string;
  }>;
}

const formatResult = ({ ok, stage, summary, detail }: CommandResult) =>
  `${stage === "skipped" ? "-" : ok ? "✓" : "✗"} ${stage.padEnd(9)} ${summary}${detail ? "\n" + detail.trimEnd() : ""}`;

const toCommandResult = (dir: string, [ok, stage, summary, detail = "", where]: Reported): CommandResult => ({
  ok,
  stage,
  summary: dir ? `${dir.slice(0, -1)}: ${summary}` : summary,
  detail: ok ? "" : detail,
  ...(dir ? { where: dir.slice(0, -1) } : where ? { where } : {}),
});

interface PhaseEvent {
  root: string;
  phase: string;
  event: "start" | "end";
  elapsedMs: number;
}

export function startPhaseTimings(): () => string {
  const starts = new Map<string, number>();
  const durations = new Map<string, { startMs: number; durationMs: number }>();
  const handler = (message: unknown) => {
    const evt = message as PhaseEvent;
    if (!evt || typeof evt.phase !== "string") return;
    if (evt.event === "start") {
      starts.set(evt.phase, evt.elapsedMs);
    } else if (evt.event === "end") {
      const began = starts.get(evt.phase) ?? evt.elapsedMs;
      durations.set(evt.phase, { startMs: began, durationMs: Math.max(0, evt.elapsedMs - began) });
    }
  };
  subscribe("vibestack:check:phase", handler);
  return () => {
    unsubscribe("vibestack:check:phase", handler);
    if (!durations.size) return "";
    const rows = [...durations.entries()]
      .sort(([, a], [, b]) => a.startMs - b.startMs)
      .map(([phase, { durationMs }]) => `  ${phase.padEnd(12)} ${(durationMs / 1000).toFixed(2)}s`);
    return `\ntimings:\n${rows.join("\n")}`;
  };
}

export async function runConformanceCommand(root: string, moduleName?: string, mode: TestProfile = "normal"): Promise<boolean> {
  const specs = readSpecs(root);
  const { seed } = profile(mode);
  const memory: Memory = { root, fresh: mode === "nightly", used: new Set() };
  const machines = new Map<string, Machine>();
  const cache = cacheDirectory(root);
  fs.mkdirSync(cache, { recursive: true });
  const loaded = fs.mkdtempSync(path.join(cache, "conformance-"));
  const results: CommandResult[] = [];

  try {
    await steady(async () => {
      const models = new Map<string, Model>();
      const typed = typecheckAll(memory, specs, root);
      fs.writeFileSync(path.join(loaded, "package.json"), '{"type":"module"}\n');
      for (const spec of specs) {
        const ir = await typed.get(spec.name)!;
        const model = generated(root, spec, ir, models);
        models.set(spec.name, model);
        const file = path.join(loaded, `${spec.name}.ts`);
        fs.writeFileSync(file, model.ts);
        if (moduleName && spec.name !== moduleName) continue;
        if (!model.stateType || !model.transitions.length) continue;
        const domain = await import(pathToFileURL(file).href);
        const sim = await simulation(memory, spec, specs, model, domain, seed);
        if (sim.tested) machines.set(model.name, { domain, model, found: sim.tested });
        for (const row of sim.said) {
          if (!row.ok) results.push(row);
        }
      }
      mirrorGen(root, specs);
      if (moduleName && !machines.has(moduleName)) {
        const known = [...models.keys()].join(", ");
        throw new Error(`no simulatable state machine named "${moduleName}" (available: ${known || "none"})`);
      }
      const wrote = new Map<string, string>();
      for (const dir of codeDirs(root)) {
        const scripts = packageScripts(path.join(root, dir));
        const rows = await conformance(
          path.join(root, dir),
          machines,
          scripts,
          (key, ran, keep) => remembered(memory, entry(root, "traces", [dir, key]), ran, keep),
          wrote,
          mode,
        );
        for (const r of rows) results.push(toCommandResult(dir, r));
      }
    });
  } finally {
    fs.rmSync(loaded, { recursive: true, force: true });
  }

  for (const r of results) console.log(formatResult(r));
  return results.every((r) => r.ok);
}

export async function runExploreCommand(root: string, mode: TestProfile = "normal"): Promise<boolean> {
  const memory: Memory = { root, fresh: mode === "nightly", used: new Set() };
  const results: CommandResult[] = [];

  await steady(async () => {
    for (const dir of codeDirs(root)) {
      const rows = await explore(
        path.join(root, dir),
        (key, ran, keep) => remembered(memory, entry(root, "explore", [dir, key]), ran, keep),
        mode,
        root,
      );
      for (const r of rows) results.push(toCommandResult(dir, r));
    }
  });

  if (!results.length) {
    console.log("- explore   no explorable pages found");
    return true;
  }
  for (const r of results) console.log(formatResult(r));
  return results.every((r) => r.ok);
}

function readFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1] && !args[i + 1].startsWith("-")) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

function parseShardWeights(file: string): Record<string, number> {
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${file}: shard weights must be a JSON object mapping spec names or paths to positive numbers`);
  }
  const weights: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${file}: weight for "${key}" must be a positive finite number`);
    }
    weights[key] = value;
  }
  return weights;
}

function specShardWeight(spec: Spec, weights?: Readonly<Record<string, number>>): number {
  const configured = weights?.[spec.name] ?? weights?.[spec.file];
  if (configured !== undefined) return configured;
  return Math.max(1, spec.rules.length * 2 + spec.imports.length + Math.ceil(spec.qnt.split("\n").length / 40));
}

function assignSimulationShard(
  specs: readonly Spec[],
  shard: number,
  shards: number,
  weights?: Readonly<Record<string, number>>,
): { readonly modules: string[]; readonly estimatedWeight: number } {
  const bins = Array.from({ length: shards }, () => ({ weight: 0, specs: [] as Spec[] }));
  const ordered = [...specs].sort(
    (a, b) => specShardWeight(b, weights) - specShardWeight(a, weights)
      || a.file.localeCompare(b.file, "en")
      || a.name.localeCompare(b.name, "en"),
  );
  for (const spec of ordered) {
    let target = bins[0]!;
    for (let i = 1; i < bins.length; i++) {
      if (bins[i]!.weight < target.weight) target = bins[i]!;
    }
    target.weight += specShardWeight(spec, weights);
    target.specs.push(spec);
  }
  const chosen = bins[shard - 1]!;
  return {
    modules: chosen.specs.map(({ name }) => name),
    estimatedWeight: Number(chosen.weight.toFixed(2)),
  };
}

async function runCiPrecomputeSimulations(root: string, args: string[], prepareSimulationReceipts: SimulationPrepFn): Promise<number> {
  const shard = Number(readFlag(args, "--shard") ?? process.env.SHARD ?? "1");
  const shards = Number(readFlag(args, "--shards") ?? process.env.SHARDS ?? "1");
  if (!Number.isInteger(shard) || !Number.isInteger(shards) || shard < 1 || shards < 1 || shard > shards) {
    throw new Error(`invalid shard parameters: shard=${shard}, shards=${shards}`);
  }
  const weightsArg = readFlag(args, "--weights");
  const weights = weightsArg ? parseShardWeights(path.resolve(root, weightsArg)) : undefined;
  const listOnly = args.includes("--list");
  const specs = readSpecs(root);
  const assignment = assignSimulationShard(specs, shard, shards, weights);
  if (listOnly) {
    console.log(JSON.stringify({ shard, shards, totalSpecs: specs.length, estimatedWeight: assignment.estimatedWeight, modules: assignment.modules }));
    return 0;
  }

  const outParent = path.resolve(root, readFlag(args, "--out") ?? process.env.RUNNER_TEMP ?? os.tmpdir());
  const githubOutput = readFlag(args, "--github-output") ?? process.env.GITHUB_OUTPUT;
  const cacheDir = cacheDirectory(root);
  const aggregate = (name: string) => /^simulate-[a-f0-9]{24}\.json\.(?:zst|gz)$/.test(name);
  const listSimulations = () => fs.existsSync(cacheDir)
    ? fs.globSync("simulate-*.json.*", { cwd: cacheDir })
      .filter((name) => aggregate(name) && fs.lstatSync(path.join(cacheDir, name)).isFile())
    : [];
  const fileDigest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  const restored = new Map<string, string>();
  for (const name of listSimulations()) {
    try { restored.set(name, fileDigest(path.join(cacheDir, name))); } catch { /* ignore unreadable */ }
  }

  const names = assignment.modules;
  fs.mkdirSync(outParent, { recursive: true });
  const { results, seedDirectory, partialDirectory } = await prepareSimulationReceipts(root, specs, names, outParent);
  const checkpoint = seedDirectory ?? partialDirectory;
  let transfer = checkpoint ?? fs.mkdtempSync(path.join(outParent, "simulation-delta-"));

  if (!checkpoint) {
    for (const name of listSimulations()) {
      if (!restored.has(name)) fs.copyFileSync(path.join(cacheDir, name), path.join(transfer, name));
    }
  } else if (process.env.CACHE_PREFIX && githubOutput) {
    const contents = fs.readdirSync(checkpoint).sort().map((name) => [name, fileDigest(path.join(checkpoint, name))]);
    if (contents.some(([name, hash]) => aggregate(name) && restored.get(name) !== hash)) {
      const fingerprint = createHash("sha256").update(JSON.stringify(contents)).digest("hex");
      const prefix = `${process.env.CACHE_PREFIX}${fingerprint}-`;
      if (!(process.env.RESTORED_KEY ?? "").startsWith(prefix)) {
        const key = `${prefix}${process.env.GITHUB_RUN_ID ?? "0"}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`;
        const staged = path.join(outParent, "cached-simulation-receipts");
        try {
          fs.rmSync(staged, { recursive: true, force: true });
          fs.renameSync(checkpoint, staged);
          transfer = staged;
          fs.appendFileSync(githubOutput, `cache-key=${key}\ncache-prefix=${prefix}\n`);
        } catch (error) {
          console.log(`::warning::Could not stage the simulation cache: ${(error as Error).message}`);
        }
      }
    }
  }

  if (githubOutput) fs.appendFileSync(githubOutput, `directory=${transfer}\n`);
  const failed = results.filter(({ ok }) => !ok);
  for (const row of failed) console.log(formatResult(row));
  const kind = seedDirectory ? "complete seed" : partialDirectory ? "partial seed" : "new aggregate";
  console.log(`shard ${shard} of ${shards}: ${names.length} specs, ${results.length} results, ${fs.readdirSync(transfer).length} ${kind} entries, ${failed.length} failed`);
  return failed.length ? 1 : 0;
}

export async function runCiCommand(root: string, args: string[], prepareSimulationReceipts: SimulationPrepFn): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "precompute-simulations") {
    return runCiPrecomputeSimulations(root, rest, prepareSimulationReceipts);
  }
  if (sub === "chromium") {
    const mode = rest[0] ?? "both";
    if (mode === "--prepare-shell") {
      if (!await prepareChromiumShell()) await installChromium("both", root);
      return 0;
    }
    if (mode !== "both" && mode !== "full" && mode !== "shell") {
      throw new Error(`spec ci chromium: expected both, full, shell, or --prepare-shell (got ${mode})`);
    }
    await installChromium(mode, root);
    return 0;
  }
  throw new Error("usage: spec ci <precompute-simulations|chromium> [options]");
}

function attachAndPropagateExit(exe: string, args: string[], cwd: string, label: string) {
  const child = startAttached(exe, args, cwd);
  child.once("error", (error) => {
    console.error(`${label} could not be started: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

export function launchStudio(root: string, args: string[]) {
  const envPath = process.env.VIBESTACK_STUDIO_PATH;
  if (envPath) {
    const resolved = path.resolve(envPath);
    if (resolved.endsWith(".js") || resolved.endsWith(".mjs") || resolved.endsWith(".ts")) {
      attachAndPropagateExit(process.execPath, [resolved, ...args], root, "studio");
    } else {
      attachAndPropagateExit(resolved, args, root, "studio");
    }
    return;
  }

  const built = import.meta.filename.endsWith(".js");
  const vendoredStudio = path.join(import.meta.dirname, "studio/src", built ? "main.js" : "main.vibe");
  if (fs.existsSync(vendoredStudio)) {
    const loader = built
      ? []
      : ["--import", pathToFileURL(createRequire(path.join(import.meta.dirname, "studio/package.json")).resolve("vibelang/register")).href];
    attachAndPropagateExit(process.execPath, [...loader, vendoredStudio, ...args], root, "studio");
    return;
  }

  const siblingServer = path.resolve(import.meta.dirname, "../../studio/dist/server.mjs");
  if (fs.existsSync(siblingServer)) {
    attachAndPropagateExit(process.execPath, [siblingServer, ...args], root, "studio");
    return;
  }

  const localBin = findBin("vibestack-studio", root);
  if (localBin) {
    attachAndPropagateExit(localBin, args, root, "studio");
    return;
  }

  const globalBin = onPath("vibestack-studio");
  if (globalBin) {
    attachAndPropagateExit(globalBin, args, root, "studio");
    return;
  }

  if (onPath("pnpm")) {
    attachAndPropagateExit("pnpm", ["dlx", "vibestack-studio@latest", ...args], root, "studio");
  } else {
    attachAndPropagateExit("npx", ["--yes", "vibestack-studio@latest", ...args], root, "studio");
  }
}

export function launchCreate(root: string, args: string[]) {
  const siblingDist = path.resolve(import.meta.dirname, "../../create-vibestack/dist/cli.js");
  const siblingSrc = path.resolve(import.meta.dirname, "../../create-vibestack/src/cli.ts");
  if (fs.existsSync(siblingDist)) {
    attachAndPropagateExit(process.execPath, [siblingDist, ...args], root, "create-vibestack");
    return;
  }
  if (fs.existsSync(siblingSrc)) {
    attachAndPropagateExit(process.execPath, [siblingSrc, ...args], root, "create-vibestack");
    return;
  }

  const localBin = findBin("create-vibestack", root);
  if (localBin) {
    attachAndPropagateExit(localBin, args, root, "create-vibestack");
    return;
  }

  const globalBin = onPath("create-vibestack");
  if (globalBin) {
    attachAndPropagateExit(globalBin, args, root, "create-vibestack");
    return;
  }

  if (onPath("pnpm")) {
    attachAndPropagateExit("pnpm", ["dlx", "create-vibestack@latest", ...args], root, "create-vibestack");
  } else {
    attachAndPropagateExit("npx", ["--yes", "create-vibestack@latest", ...args], root, "create-vibestack");
  }
}
