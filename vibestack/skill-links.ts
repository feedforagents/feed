import fs from "node:fs";
import path from "node:path";

export const SKILL_ROOT = ".agents/skills";
export const TOOL_IGNORE_DIRS = ["gen", ".spec-cache", ".studio", "dist", ".vibe", ".cache", ".turbo", ".alchemy", ".wrangler"] as const;
export const GENERATED_AGENT_DIRECTORIES = [".claude", ".codex", ".cursor", ".droid", ".factory", ".gemini", ".grok", ".grokbot", ".muse", ".t3"];
export const GENERATED_AGENT_IGNORES = ["/.claude/", "/CLAUDE.md", ...GENERATED_AGENT_DIRECTORIES.filter((agent) => agent !== ".claude").map((agent) => `/${agent}/skills`)];

export interface PackageAssets {
  pkgRoot: string;
  version: string;
  agentsMd: string;
  specMd: string;
  claudeSettings: string;
  skillsDirs: string[];
  packageJson: Record<string, unknown>;
}

/** Locate bundled Vibestack assets, checking `assets/` in the package first and falling back to the monorepo root in dev. */
export function resolvePackageAssets(basePkgDir = path.resolve(import.meta.dirname, "..")): PackageAssets {
  const pkgRoot = fs.existsSync(path.join(basePkgDir, "package.json")) ? basePkgDir : path.resolve(import.meta.dirname, "..");
  const repoRoot = fs.existsSync(path.join(pkgRoot, SKILL_ROOT)) ? pkgRoot : path.resolve(pkgRoot, "../..");
  const assetsDir = path.join(pkgRoot, "assets");
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")) as Record<string, unknown>;

  const pickFile = (inAssets: string, inRepo: string) =>
    fs.existsSync(path.join(assetsDir, inAssets)) ? path.join(assetsDir, inAssets)
      : fs.existsSync(path.join(pkgRoot, inRepo)) ? path.join(pkgRoot, inRepo)
      : path.join(repoRoot, inRepo);

  const assetSkills = path.join(assetsDir, "skills");
  const repoSkills = path.join(repoRoot, SKILL_ROOT);
  const pkgSkills = path.join(pkgRoot, SKILL_ROOT);
  const skillsDirs: string[] = [];
  if (fs.existsSync(repoSkills) && repoRoot !== pkgRoot) skillsDirs.push(repoSkills);
  if (fs.existsSync(pkgSkills)) skillsDirs.push(pkgSkills);
  if (fs.existsSync(assetSkills)) skillsDirs.push(assetSkills);

  return {
    pkgRoot,
    version: typeof pkgJson.version === "string" ? pkgJson.version : "0.0.0",
    agentsMd: pickFile("AGENTS.md", "AGENTS.md"),
    specMd: pickFile("SPEC.md", "SPEC.md"),
    claudeSettings: pickFile("claude-settings.json", ".agents/claude-settings.json"),
    skillsDirs,
    packageJson: pkgJson,
  };
}

function availableDirectory(directory: string, warn: (message: string) => void): boolean {
  const entry = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!entry || entry.isDirectory()) return true;
  warn(`Preserved ${directory}. Expected a project directory.`);
  return false;
}

function pointsTo(destination: string, source: string): boolean {
  return fs.lstatSync(destination, { throwIfNoEntry: false })?.isSymbolicLink() === true
    && path.resolve(path.dirname(destination), fs.readlinkSync(destination)) === source;
}

/**
 * Fast, postinstall-safe symlink refresher (`vibestack link`).
 * Creates/updates only gitignored local links for AI coding agents and CLAUDE.md.
 * Never mutates package.json, .gitignore, or any tracked project file.
 */
export function linkProjectAgents(project: string, warn: (message: string) => void = () => {}): string[] {
  const canonical = path.join(project, SKILL_ROOT);
  const linked: string[] = [];
  const record = (file: string) => linked.push(path.relative(project, file).split(path.sep).join("/"));

  function ensureLink(source: string, destination: string, type: "dir" | "file") {
    if (pointsTo(destination, source)) return;
    if (source === canonical && pointsTo(destination, path.join(project, ".claude/skills"))) fs.unlinkSync(destination);
    if (!fs.lstatSync(destination, { throwIfNoEntry: false })) {
      const parent = path.dirname(destination);
      fs.mkdirSync(parent, { recursive: true });
      try {
        fs.symlinkSync(path.relative(parent, source), destination, type);
        record(destination);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        if (!pointsTo(destination, source)) warn(`Preserved ${destination}. Expected a link to ${source}.`);
      }
    } else warn(`Preserved ${destination}. Expected a link to ${source}.`);
  }

  if (fs.lstatSync(canonical, { throwIfNoEntry: false })?.isDirectory()) {
    const skills = fs.readdirSync(canonical, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")
        && fs.statSync(path.join(canonical, entry.name, "SKILL.md"), { throwIfNoEntry: false })?.isFile())
      .map((entry) => entry.name).sort();
    const settingsPath = path.join(project, ".agents/claude-settings.json");
    for (const agent of GENERATED_AGENT_DIRECTORIES) {
      const parent = path.join(project, agent);
      if (!availableDirectory(parent, warn)) continue;
      const destination = path.join(parent, "skills");
      if (fs.lstatSync(destination, { throwIfNoEntry: false })?.isDirectory()) {
        for (const name of skills) ensureLink(path.join(canonical, name), path.join(destination, name), "dir");
      } else ensureLink(canonical, destination, "dir");
      if (agent === ".claude" && fs.existsSync(settingsPath)) ensureLink(settingsPath, path.join(parent, "settings.json"), "file");
    }
  }

  const agentsFile = path.join(project, "AGENTS.md");
  const claudeFile = path.join(project, "CLAUDE.md");
  if (fs.existsSync(agentsFile)) {
    const existing = fs.lstatSync(claudeFile, { throwIfNoEntry: false });
    if (!existing) {
      fs.symlinkSync("AGENTS.md", claudeFile, "file");
      linked.push("CLAUDE.md");
    } else if (existing.isSymbolicLink() && !pointsTo(claudeFile, agentsFile)) {
      warn(`Preserved ${claudeFile}. Expected a link to AGENTS.md.`);
    }
  }

  return linked;
}

export function setupProjectAgents(project: string, warn: (message: string) => void): string[] {
  const assets = resolvePackageAssets();
  const canonical = path.join(project, SKILL_ROOT);
  const added: string[] = [];
  const record = (file: string) => added.push(path.relative(project, file).split(path.sep).join("/"));

  function migrate(source: string, destination: string) {
    if (pointsTo(source, destination) && fs.existsSync(destination)) return;
    if (fs.lstatSync(source).isSymbolicLink()) {
      warn(`Preserved ${source}. Expected skill content, not a redirected path.`);
      return;
    }
    if (pointsTo(destination, source)) fs.unlinkSync(destination);
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (!existing) {
      fs.renameSync(source, destination);
      record(destination);
    } else {
      const entry = fs.lstatSync(source);
      if (entry.isDirectory() && existing.isDirectory()) {
        for (const name of fs.readdirSync(source)) migrate(path.join(source, name), path.join(destination, name));
        if (!fs.readdirSync(source).length) fs.rmdirSync(source);
      } else if (entry.isFile() && existing.isFile() && fs.readFileSync(source).equals(fs.readFileSync(destination))) fs.unlinkSync(source);
      else warn(`Preserved ${source} and ${destination}. Conflicting skill content.`);
    }
  }

  function addSkillsFrom(sourceBase: string, rel = "") {
    const source = rel ? path.join(sourceBase, rel) : sourceBase;
    const destination = rel ? path.join(canonical, rel) : canonical;
    if (source === destination || !fs.existsSync(source)) return;
    const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
    if (existing && !existing.isDirectory()) return;
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      if (entry.name === ".DS_Store") continue;
      const nextRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) addSkillsFrom(sourceBase, nextRel);
      else if (entry.isFile() && !fs.lstatSync(path.join(canonical, nextRel), { throwIfNoEntry: false })) {
        fs.mkdirSync(destination, { recursive: true });
        fs.copyFileSync(path.join(source, entry.name), path.join(canonical, nextRel));
        record(path.join(canonical, nextRel));
      }
    }
  }

  const claudeDirectory = path.join(project, ".claude");
  const prevSkills = path.join(claudeDirectory, "skills");
  const hasAgents = availableDirectory(path.dirname(canonical), warn);
  if (hasAgents && pointsTo(canonical, prevSkills) && fs.lstatSync(claudeDirectory, { throwIfNoEntry: false })?.isDirectory()
    && fs.lstatSync(prevSkills, { throwIfNoEntry: false })?.isDirectory()) {
    fs.unlinkSync(canonical);
    fs.renameSync(prevSkills, canonical);
    record(canonical);
  }
  const hasCanonical = hasAgents && availableDirectory(canonical, warn);
  if (hasCanonical) {
    fs.mkdirSync(canonical, { recursive: true });
    if (fs.lstatSync(claudeDirectory, { throwIfNoEntry: false })?.isDirectory() && fs.lstatSync(prevSkills, { throwIfNoEntry: false })?.isDirectory()) {
      for (const name of fs.readdirSync(prevSkills)) migrate(path.join(prevSkills, name), path.join(canonical, name));
      const remaining = fs.readdirSync(prevSkills);
      if (remaining.every((name) => pointsTo(path.join(prevSkills, name), path.join(canonical, name)))) {
        for (const name of remaining) fs.unlinkSync(path.join(prevSkills, name));
        fs.rmdirSync(prevSkills);
      }
    }
    for (const name of fs.readdirSync(canonical)) {
      const destination = path.join(canonical, name);
      const source = path.join(prevSkills, name);
      if (pointsTo(destination, source) && !fs.existsSync(source)) fs.unlinkSync(destination);
    }
    for (const dir of assets.skillsDirs) addSkillsFrom(dir);
    const settings = ".agents/claude-settings.json";
    if (!fs.lstatSync(path.join(project, settings), { throwIfNoEntry: false }) && fs.existsSync(assets.claudeSettings)) {
      const { permissions } = JSON.parse(fs.readFileSync(assets.claudeSettings, "utf8")) as { permissions: { deny: string[]; ask: string[] } };
      fs.writeFileSync(path.join(project, settings), JSON.stringify({ permissions: { ...permissions, deny: permissions.deny.filter((rule) => !/\/(?:vibestack|packages\/studio|template|examples)\//.test(rule)) } }, null, 2) + "\n");
      added.push(settings);
    }
  }

  const claude = path.join(project, "CLAUDE.md");
  const entry = fs.lstatSync(claude, { throwIfNoEntry: false });
  const own = entry?.isFile() ? fs.readFileSync(claude, "utf8") : undefined;
  if (fs.existsSync(path.join(project, "AGENTS.md"))) {
    if (own?.trim() === "" || own?.trim() === "@AGENTS.md") {
      fs.unlinkSync(claude);
      fs.symlinkSync("AGENTS.md", claude, "file");
      added.push("CLAUDE.md (symlink to AGENTS.md)");
    } else if (own !== undefined && !/^@AGENTS\.md\s*$/m.test(own)) {
      const eol = own.includes("\r\n") ? "\r\n" : "\n";
      fs.writeFileSync(claude, `${own.trimEnd()}${eol}${eol}@AGENTS.md${eol}`);
      added.push("CLAUDE.md (imports AGENTS.md)");
    }
  }

  added.push(...linkProjectAgents(project, warn));
  return added;
}

if (import.meta.main) {
  const cwd = process.cwd();
  const target = fs.existsSync(path.join(cwd, ".agents/skills")) ? cwd : path.resolve(import.meta.dirname, "../../..");
  linkProjectAgents(target, (message) => process.stderr.write(`Agent setup: ${message}\n`));
}
