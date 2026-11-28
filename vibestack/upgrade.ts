import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, type VibestackConfig, type VibestackMode } from "./config.ts";
import { doctor, formatDoctorReport, type DoctorReport } from "./doctor.ts";
import { exec, writeWhole } from "./run.ts";
import { GENERATED_AGENT_IGNORES, linkProjectAgents, resolvePackageAssets, setupProjectAgents, SKILL_ROOT, type PackageAssets } from "./skill-links.ts";
import { VITEST_CONFIG } from "./testing/check.ts";

export { linkProjectAgents as linkAgents };

export const MANIFEST_PATH = ".agents/.vibestack-manifest.json";
const MIN_NODE = 26;

const VIBELANG_DEPS = ["effect", "@effect/platform-node", "vibelang-runtime"] as const;
const VIBELANG_DEV_DEPS = ["vibelang", "vibelang-vite", "vite", "vitest", "@effect/vitest", "@types/node", "@antithesishq/bombadil"] as const;
const ALIGNED_PINS = ["effect", "@effect/platform-node", "@effect/vitest", "vibelang", "vibelang-runtime", "vibelang-vite", "vite", "vitest"] as const;

const GITIGNORE_ENTRIES = [
  "gen/",
  ".spec-cache/",
  ".studio/",
  "dist/",
  ".vibe/",
  ".cache/",
  ".turbo/",
  ".alchemy/",
  ".wrangler/",
  "test/__traces__/",
  ...GENERATED_AGENT_IGNORES,
];

export interface ManagedManifest {
  version: string;
  files: Record<string, string>;
}

export interface InitOptions {
  mode?: VibestackMode;
  exclude?: string[];
  yes?: boolean;
  warn?: (message: string) => void;
}

export interface UpgradeOptions {
  version?: string;
  dryRun?: boolean;
  from?: string;
  force?: boolean;
  warn?: (message: string) => void;
}

export interface UpgradeResult {
  fromVersion?: string;
  toVersion: string;
  dryRun: boolean;
  bumped: string[];
  added: string[];
  updated: string[];
  removed: string[];
  conflicts: string[];
  pinned: string[];
  linked: string[];
  doctor?: DoctorReport;
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

function readManifest(root: string): ManagedManifest | undefined {
  const file = path.join(root, MANIFEST_PATH);
  if (!fs.existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ManagedManifest>;
    if (parsed && typeof parsed === "object" && parsed.files && typeof parsed.files === "object") {
      return { version: typeof parsed.version === "string" ? parsed.version : "0.0.0", files: { ...parsed.files } };
    }
  } catch { /* treat unreadable manifest as absent */ }
  return undefined;
}

function writeManifest(root: string, manifest: ManagedManifest) {
  const sorted = Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  writeWhole(path.join(root, MANIFEST_PATH), JSON.stringify({ version: manifest.version, files: sorted }, null, 2) + "\n");
}

function collectManagedAssets(assets: PackageAssets): Map<string, Buffer> {
  const managed = new Map<string, Buffer>();
  const walkSkills = (baseDir: string, rel = "") => {
    const dir = rel ? path.join(baseDir, rel) : baseDir;
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".DS_Store") continue;
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walkSkills(baseDir, nextRel);
      else if (entry.isFile()) {
        managed.set(`${SKILL_ROOT}/${nextRel}`, fs.readFileSync(path.join(dir, entry.name)));
      }
    }
  };
  for (const dir of assets.skillsDirs) walkSkills(dir);

  if (fs.existsSync(assets.claudeSettings)) {
    const parsed = JSON.parse(fs.readFileSync(assets.claudeSettings, "utf8")) as { permissions: { deny: string[]; ask: string[] } };
    const filtered = {
      permissions: {
        ...parsed.permissions,
        deny: parsed.permissions.deny.filter((rule) => !/\/(?:vibestack|packages\/studio|template|examples)\//.test(rule)),
      },
    };
    managed.set(".agents/claude-settings.json", Buffer.from(JSON.stringify(filtered, null, 2) + "\n", "utf8"));
  }

  if (fs.existsSync(assets.specMd)) {
    managed.set("SPEC.md", fs.readFileSync(assets.specMd));
  }
  return managed;
}

function updateMarkedBlock(
  filePath: string,
  startMarker: string,
  endMarker: string,
  body: string,
  dryRun = false,
): boolean {
  const previous = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const eol = previous.includes("\r\n") ? "\r\n" : "\n";
  const normalizedBody = body.trim().replace(/\r?\n/g, eol);
  const block = `${startMarker}${eol}${normalizedBody}${eol}${endMarker}`;
  const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const starts = [...previous.matchAll(new RegExp(escapeRegex(startMarker), "g"))];
  const ends = [...previous.matchAll(new RegExp(escapeRegex(endMarker), "g"))];
  if (starts.length !== ends.length || starts.length > 1 || (starts.length === 1 && starts[0].index! > ends[0].index!)) {
    throw new Error(`${path.basename(filePath)}: repair the duplicated or incomplete Vibestack markers first`);
  }
  const updated = starts.length
    ? previous.slice(0, starts[0].index) + block + previous.slice(ends[0].index! + ends[0][0].length)
    : previous.trim() === normalizedBody
      ? `${block}${eol}`
      : `${previous.trimEnd()}${previous.trim() ? eol + eol : ""}${block}${eol}`;
  if (updated === previous) return false;
  if (!dryRun) writeWhole(filePath, updated);
  return true;
}

function updateGitignore(root: string, dryRun = false): boolean {
  const file = path.join(root, ".gitignore");
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const existingLines = new Set(previous.split(/\r?\n/));
  if (!previous.includes("# vibestack:start") && GITIGNORE_ENTRIES.every((entry) => existingLines.has(entry))) {
    return false;
  }
  return updateMarkedBlock(file, "# vibestack:start", "# vibestack:end", GITIGNORE_ENTRIES.join("\n"), dryRun);
}

function toolchainPins(assets: PackageAssets): Record<string, string> {
  const pkg = assets.packageJson as Record<string, Record<string, string> | undefined>;
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
}

function detectMode(root: string): VibestackMode {
  if (fs.existsSync(path.join(root, "vibestack.json"))) return loadConfig(root).mode;
  const pkgFile = path.join(root, "package.json");
  const pkg = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, "utf8")) as Record<string, any> : {};
  if (pkg.vibestack?.mode) return loadConfig(root).mode;
  const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if ("vibelang" in allDeps || "vibelang-runtime" in allDeps) return "vibelang";
  const wsFile = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(wsFile) && /\bvibelang\b/.test(fs.readFileSync(wsFile, "utf8"))) return "vibelang";
  const hasExistingCode = fs.existsSync(path.join(root, "tsconfig.json")) || fs.existsSync(path.join(root, "src"));
  return hasExistingCode ? "typescript" : "vibelang";
}

function updatePostinstall(scripts: Record<string, string>): { changed: boolean; value: string } {
  if (scripts["pnpm:devPreinstall"]?.includes("skill-links")) {
    return { changed: false, value: scripts.postinstall ?? "" };
  }
  const current = scripts.postinstall ?? "";
  if (current === "vibestack link" || /(?:^| && )vibestack link(?:$| && )/.test(current)) {
    return { changed: false, value: current };
  }
  if (/^spec init(?:$| && )/.test(current)) {
    return { changed: true, value: current.replace(/^spec init/, "vibestack link") };
  }
  return { changed: true, value: current ? `${current} && vibestack link` : "vibestack link" };
}

function addMissingScripts(json: Record<string, any>, mode: VibestackMode, isWorkspace: boolean): string[] {
  const scripts: Record<string, string> = { ...(json.scripts ?? {}) };
  const added: string[] = [];
  const coreScripts: [string, string][] = [
    ["check", "spec check"],
    ["gen", "spec gen"],
    ["accept", "spec accept"],
    ["new", "spec new"],
    ["studio", "spec studio"],
  ];
  for (const [name, cmd] of coreScripts) {
    const existing = scripts[name];
    if (!existing) {
      scripts[name] = cmd;
      added.push(name);
    } else if (!existing.includes("spec") && !scripts[`spec:${name}`]) {
      scripts[`spec:${name}`] = cmd;
      added.push(`spec:${name}`);
    }
  }
  if (mode === "vibelang") {
    const modeScripts = isWorkspace
      ? ([["dev", "spec studio"], ["test", "vitest run"]] as const)
      : ([["dev", "spec studio"], ["build", "vibelang"], ["test", "vitest run"]] as const);
    for (const [name, cmd] of modeScripts) {
      if (!scripts[name] || (name === "test" && /no test specified/.test(scripts[name]))) {
        scripts[name] = cmd;
        added.push(name);
      }
    }
  }
  const post = updatePostinstall(scripts);
  if (post.changed) {
    scripts.postinstall = post.value;
    added.push("postinstall");
  }
  if (added.length) json.scripts = scripts;
  return added;
}

export function initProject(root: string, options: InitOptions = {}): string[] {
  const warn = options.warn ?? ((message: string) => console.warn(`note: ${message}`));
  const assets = resolvePackageAssets();
  const mode = options.mode ?? detectMode(root);
  const done: string[] = [];
  const isWorkspace = fs.existsSync(path.join(root, "pnpm-workspace.yaml"));

  if (mode !== "vibelang" || (options.exclude && options.exclude.length > 0)) {
    const configPath = path.join(root, "vibestack.json");
    const existing: VibestackConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    const nextConfig: VibestackConfig = {
      ...existing,
      mode,
      ...(options.exclude?.length ? { spec: { ...(existing.spec ?? {}), exclude: [...new Set([...(existing.spec?.exclude ?? []), ...options.exclude])] } } : {}),
    };
    writeWhole(configPath, JSON.stringify(nextConfig, null, 2) + "\n");
    done.push("vibestack.json");
  }

  if (fs.existsSync(assets.agentsMd)) {
    const procedure = fs.readFileSync(assets.agentsMd, "utf8");
    if (updateMarkedBlock(path.join(root, "AGENTS.md"), "<!-- vibestack:start -->", "<!-- vibestack:end -->", procedure)) {
      done.push("AGENTS.md (Vibestack instructions)");
    }
  }
  if (updateGitignore(root)) done.push(".gitignore");

  const agentAdded = setupProjectAgents(root, warn);
  if (agentAdded.length) done.push(...agentAdded);

  const managed = collectManagedAssets(assets);
  const specTarget = path.join(root, "SPEC.md");
  if (!fs.lstatSync(specTarget, { throwIfNoEntry: false }) && managed.has("SPEC.md")) {
    writeWhole(specTarget, managed.get("SPEC.md")!);
    done.push("SPEC.md");
  }

  if (fs.lstatSync(path.join(root, ".agents"), { throwIfNoEntry: false })?.isDirectory()) {
    const prevManifest = readManifest(root);
    const manifestFiles: Record<string, string> = { ...(prevManifest?.files ?? {}) };
    for (const [rel] of managed) {
      if (manifestFiles[rel]) continue;
      const target = path.join(root, rel);
      if (fs.existsSync(target) && fs.lstatSync(target).isFile()) manifestFiles[rel] = sha256(fs.readFileSync(target));
    }
    const nextManifest: ManagedManifest = { version: assets.version, files: manifestFiles };
    const nextSorted = JSON.stringify({ version: nextManifest.version, files: Object.fromEntries(Object.entries(nextManifest.files).sort(([a], [b]) => a.localeCompare(b))) }, null, 2) + "\n";
    const manifestFile = path.join(root, MANIFEST_PATH);
    const prevRaw = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, "utf8") : undefined;
    if (prevRaw !== nextSorted) {
      writeManifest(root, nextManifest);
      if (!prevManifest) done.push(MANIFEST_PATH);
    }
  }

  const addIfMissing = (file: string, content: () => string) => {
    const target = path.join(root, file);
    if (fs.lstatSync(target, { throwIfNoEntry: false })) return;
    writeWhole(target, content());
    done.push(file);
  };

  if (mode === "vibelang") {
    addIfMissing("tsconfig.json", () => JSON.stringify({
      compilerOptions: { target: "es2023", module: "nodenext", strict: true, skipLibCheck: true, types: ["node"], rootDir: ".", rootDirs: [".", ".vibe/declarations"], outDir: "dist", noEmitOnError: true, rewriteRelativeImportExtensions: true },
      include: ["src", "test", "gen/*.ts", "gen/*.vibe"],
      vibe: { sidecarDir: ".vibe/declarations" },
    }, null, 2) + "\n");
    addIfMissing("vitest.config.ts", () => VITEST_CONFIG);
  }
  if (!fs.existsSync(path.join(root, "spec"))) addIfMissing("spec/index.md", () => "");

  const pkgFile = path.join(root, "package.json");
  const json: Record<string, any> = fs.existsSync(pkgFile) ? JSON.parse(fs.readFileSync(pkgFile, "utf8")) : {};
  const addedScripts = addMissingScripts(json, mode, isWorkspace);
  let manifestChanged = addedScripts.length > 0;
  if (addedScripts.length) done.push(`package.json scripts: ${addedScripts.join(", ")}`);

  if (mode === "vibelang" && !isWorkspace) {
    const pins = toolchainPins(assets);
    const has = { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) };
    const missingDeps = Object.fromEntries(VIBELANG_DEPS.filter((n) => !(n in has) && pins[n]).map((n) => [n, pins[n]]));
    const missingDev = Object.fromEntries(VIBELANG_DEV_DEPS.filter((n) => !(n in has) && pins[n]).map((n) => [n, pins[n]]));
    const needed = [...Object.keys(missingDeps), ...Object.keys(missingDev)];
    if (needed.length) {
      json.dependencies = { ...(json.dependencies ?? {}), ...missingDeps };
      json.devDependencies = { ...(json.devDependencies ?? {}), ...missingDev };
      if (pins["@effect/platform-node"]) {
        json.pnpm = { ...(json.pnpm ?? {}), overrides: { "@effect/platform-node-shared": pins["@effect/platform-node"], ...(json.pnpm?.overrides ?? {}) } };
      }
      manifestChanged = true;
      done.push(`package.json VibeLang toolchain: ${needed.join(", ")} (run pnpm install)`);
    }
  }

  if (json.packageManager === undefined) { json.packageManager = "pnpm@10.24.0"; manifestChanged = true; done.push("package.json packageManager: pnpm@10.24.0"); }
  if (json.engines?.node === undefined) { json.engines = { ...(json.engines ?? {}), node: `>=${MIN_NODE}` }; manifestChanged = true; done.push(`package.json engines.node: >=${MIN_NODE}`); }
  if (json.type === undefined) { json.type = "module"; manifestChanged = true; done.push('package.json "type": "module"'); }
  else if (json.type !== "module") warn(`package.json: "type" is ${JSON.stringify(json.type)}; ES imports in src/ and test/ expect "type": "module"`);

  if (manifestChanged) writeWhole(pkgFile, JSON.stringify(json, null, 2) + "\n");
  return done;
}

function resolveLocalPackage(root: string, fromPath: string): { spec: string; dir?: string } {
  const resolved = path.resolve(root, fromPath);
  if (!fs.existsSync(resolved)) throw new Error(`--from path does not exist: ${resolved}`);
  if (fs.statSync(resolved).isFile()) return { spec: `file:${path.relative(root, resolved) || resolved}` };
  const nestedPkg = path.join(resolved, "packages", "vibestack");
  const pkgDir = fs.existsSync(path.join(nestedPkg, "package.json")) ? nestedPkg : resolved;
  if (!fs.existsSync(path.join(pkgDir, "package.json"))) {
    throw new Error(`--from directory does not contain a vibestack package.json: ${resolved}`);
  }
  const rel = path.relative(root, pkgDir).split(path.sep).join("/");
  return { spec: `file:${rel.startsWith(".") ? rel : `./${rel}`}`, dir: pkgDir };
}

function replaceYamlPin(content: string, section: "catalog" | "overrides", pkg: string, nextValue: string): { text: string; changed: boolean } {
  const lines = content.split("\n");
  let inSection = false;
  let changed = false;
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(`^(\\s+)(["']?${escaped}["']?):\\s*(.+?)\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[A-Za-z0-9_-]+:\s*$/.test(line)) {
      inSection = line.trim() === `${section}:`;
      continue;
    }
    if (!inSection || !line.startsWith(" ")) continue;
    const match = keyPattern.exec(line);
    if (!match) continue;
    if (match[3].replace(/^["']|["']$/g, "") !== nextValue) {
      lines[i] = `${match[1]}${match[2]}: ${nextValue}`;
      changed = true;
    }
    break;
  }
  return { text: lines.join("\n"), changed };
}

function bumpVibestackSpec(root: string, targetSpec: string, dryRun: boolean): string[] {
  const bumped: string[] = [];
  const wsFile = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(wsFile)) {
    const raw = fs.readFileSync(wsFile, "utf8");
    const updated = replaceYamlPin(raw, "catalog", "vibestack", targetSpec);
    if (updated.changed) {
      if (!dryRun) writeWhole(wsFile, updated.text);
      bumped.push(`pnpm-workspace.yaml catalog.vibestack -> ${targetSpec}`);
      return bumped;
    }
  }
  const pkgFile = path.join(root, "package.json");
  if (fs.existsSync(pkgFile)) {
    const json = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["devDependencies", "dependencies"] as const) {
      if (json[field] && "vibestack" in json[field] && json[field].vibestack !== "catalog:") {
        if (json[field].vibestack !== targetSpec) {
          json[field].vibestack = targetSpec;
          if (!dryRun) writeWhole(pkgFile, JSON.stringify(json, null, 2) + "\n");
          bumped.push(`package.json ${field}.vibestack -> ${targetSpec}`);
        }
        return bumped;
      }
    }
    json.devDependencies = { ...(json.devDependencies ?? {}), vibestack: targetSpec };
    if (!dryRun) writeWhole(pkgFile, JSON.stringify(json, null, 2) + "\n");
    bumped.push(`package.json devDependencies.vibestack -> ${targetSpec}`);
  }
  return bumped;
}

function alignToolchainPins(root: string, assets: PackageAssets, dryRun: boolean): string[] {
  const pins = toolchainPins(assets);
  const pinned: string[] = [];
  const wsFile = path.join(root, "pnpm-workspace.yaml");
  if (fs.existsSync(wsFile)) {
    let raw = fs.readFileSync(wsFile, "utf8");
    let modified = false;
    for (const pkg of ALIGNED_PINS) {
      if (!pins[pkg]) continue;
      const next = replaceYamlPin(raw, "catalog", pkg, pins[pkg]);
      if (next.changed) {
        raw = next.text;
        modified = true;
        pinned.push(`catalog.${pkg} -> ${pins[pkg]}`);
      }
    }
    if (pins["@effect/platform-node"]) {
      const next = replaceYamlPin(raw, "overrides", "@effect/platform-node-shared", pins["@effect/platform-node"]);
      if (next.changed) {
        raw = next.text;
        modified = true;
        pinned.push(`overrides.@effect/platform-node-shared -> ${pins["@effect/platform-node"]}`);
      }
    }
    if (modified && !dryRun) writeWhole(wsFile, raw);
  }
  const pkgFile = path.join(root, "package.json");
  if (fs.existsSync(pkgFile)) {
    const json = JSON.parse(fs.readFileSync(pkgFile, "utf8")) as Record<string, any>;
    let modified = false;
    for (const field of ["dependencies", "devDependencies"] as const) {
      if (!json[field]) continue;
      for (const pkg of ALIGNED_PINS) {
        const cur = json[field][pkg];
        if (cur && cur !== "catalog:" && pins[pkg] && cur !== pins[pkg]) {
          json[field][pkg] = pins[pkg];
          modified = true;
          pinned.push(`${field}.${pkg} -> ${pins[pkg]}`);
        }
      }
    }
    if (modified && !dryRun) writeWhole(pkgFile, JSON.stringify(json, null, 2) + "\n");
  }
  return pinned;
}

function pruneEmptyDirs(root: string, startDir: string) {
  let dir = startDir;
  const stop = path.join(root, ".agents");
  while (dir.startsWith(stop) && dir !== stop) {
    try {
      if (fs.readdirSync(dir).length > 0) break;
      fs.rmdirSync(dir);
    } catch { break; }
    dir = path.dirname(dir);
  }
}

export async function upgradeProject(root: string, options: UpgradeOptions = {}): Promise<UpgradeResult> {
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const warn = options.warn ?? ((message: string) => console.warn(`note: ${message}`));
  const prevManifest = readManifest(root);
  const bumped: string[] = [];

  let localSourceDir: string | undefined;
  if (options.from) {
    const local = resolveLocalPackage(root, options.from);
    localSourceDir = local.dir;
    bumped.push(...bumpVibestackSpec(root, local.spec, dryRun));
  } else if (options.version) {
    bumped.push(...bumpVibestackSpec(root, options.version, dryRun));
  } else {
    bumped.push(...bumpVibestackSpec(root, "latest", dryRun));
  }

  if (!dryRun && bumped.length > 0) {
    const installed = await exec("pnpm", ["install"], root);
    if (installed.status !== 0 || installed.stopped) {
      throw new Error(`pnpm install failed: ${installed.stderr || installed.stdout || installed.stopped}`);
    }
  }

  const installedPkgDir = path.join(root, "node_modules", "vibestack");
  const assetBase = localSourceDir ?? (fs.existsSync(path.join(installedPkgDir, "package.json")) ? installedPkgDir : undefined);
  const assets = resolvePackageAssets(assetBase);
  const managed = collectManagedAssets(assets);
  const prevFiles = prevManifest?.files ?? {};
  const nextFiles: Record<string, string> = {};

  const added: string[] = [];
  const updated: string[] = [];
  const removed: string[] = [];
  const conflicts: string[] = [];

  for (const [rel, content] of managed) {
    const target = path.join(root, rel);
    const nextHash = sha256(content);
    const prevHash = prevFiles[rel];
    if (!fs.existsSync(target)) {
      if (!dryRun) writeWhole(target, content);
      added.push(rel);
      nextFiles[rel] = nextHash;
      continue;
    }
    const currentHash = sha256(fs.readFileSync(target));
    if (currentHash === nextHash) {
      nextFiles[rel] = nextHash;
      continue;
    }
    const unmodified = prevHash !== undefined && currentHash === prevHash;
    if (unmodified || force) {
      if (!dryRun) writeWhole(target, content);
      updated.push(rel);
      nextFiles[rel] = nextHash;
    } else {
      conflicts.push(rel);
      nextFiles[rel] = prevHash ?? currentHash;
      warn(`Preserved locally modified ${rel} (pass --force to overwrite)`);
    }
  }

  for (const [rel, prevHash] of Object.entries(prevFiles)) {
    if (managed.has(rel)) continue;
    const target = path.join(root, rel);
    if (!fs.existsSync(target)) continue;
    const currentHash = sha256(fs.readFileSync(target));
    if (currentHash === prevHash || force) {
      if (!dryRun) {
        fs.rmSync(target, { force: true });
        pruneEmptyDirs(root, path.dirname(target));
      }
      removed.push(rel);
    } else {
      conflicts.push(`${rel} (obsolete upstream, locally modified)`);
      nextFiles[rel] = prevHash;
      warn(`Preserved obsolete locally modified ${rel} (pass --force to remove)`);
    }
  }

  if (fs.existsSync(assets.agentsMd)) {
    const procedure = fs.readFileSync(assets.agentsMd, "utf8");
    if (updateMarkedBlock(path.join(root, "AGENTS.md"), "<!-- vibestack:start -->", "<!-- vibestack:end -->", procedure, dryRun)) {
      updated.push("AGENTS.md (Vibestack instructions)");
    }
  }
  if (updateGitignore(root, dryRun)) updated.push(".gitignore");

  if (!dryRun) writeManifest(root, { version: assets.version, files: nextFiles });

  const config = loadConfig(root);
  const pinned = config.mode === "vibelang" ? alignToolchainPins(root, assets, dryRun) : [];
  if (!dryRun && pinned.length > 0) {
    const synced = await exec("pnpm", ["install"], root);
    if (synced.status !== 0 || synced.stopped) {
      warn(`pnpm install after catalog pin update exited ${synced.status}`);
    }
  }

  const linked = dryRun ? [] : linkProjectAgents(root, warn);
  const doctorReport = dryRun ? undefined : await doctor(root);

  return {
    fromVersion: prevManifest?.version,
    toVersion: assets.version,
    dryRun,
    bumped,
    added,
    updated,
    removed,
    conflicts,
    pinned,
    linked,
    doctor: doctorReport,
  };
}

export function formatUpgradeResult(result: UpgradeResult): string {
  const lines: string[] = [];
  const prefix = result.dryRun ? "[dry-run] " : "";
  lines.push(`${prefix}vibestack upgrade ${result.fromVersion ? `${result.fromVersion} -> ` : ""}${result.toVersion}`);
  if (result.bumped.length) lines.push(`  bumped: ${result.bumped.join(", ")}`);
  if (result.added.length) lines.push(`  added (${result.added.length}): ${result.added.join(", ")}`);
  if (result.updated.length) lines.push(`  updated (${result.updated.length}): ${result.updated.join(", ")}`);
  if (result.removed.length) lines.push(`  removed (${result.removed.length}): ${result.removed.join(", ")}`);
  if (result.pinned.length) lines.push(`  aligned pins: ${result.pinned.join(", ")}`);
  if (result.conflicts.length) lines.push(`  conflicts preserved (${result.conflicts.length}): ${result.conflicts.join(", ")}`);
  if (result.linked.length) lines.push(`  linked (${result.linked.length}): ${result.linked.join(", ")}`);
  if (!result.bumped.length && !result.added.length && !result.updated.length && !result.removed.length && !result.pinned.length && !result.conflicts.length) {
    lines.push("  everything is already up to date");
  }
  if (result.doctor) {
    lines.push("");
    lines.push(formatDoctorReport(result.doctor));
  }
  return lines.join("\n");
}
