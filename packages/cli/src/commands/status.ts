import fs from "node:fs";
import path from "node:path";
import { defineCommand } from "../runner.ts";

interface PackageSummary {
  readonly name: string;
  readonly path: string;
  readonly scripts: readonly string[];
  readonly hasGen: boolean;
}

interface WorkspaceStatus {
  readonly project: string;
  readonly rootGen: boolean;
  readonly specs: readonly string[];
  readonly packages: readonly PackageSummary[];
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function readScriptNames(manifest: Record<string, unknown>): readonly string[] {
  const scripts = manifest.scripts;
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return [];
  return Object.keys(scripts).sort();
}

function listSpecs(rootDir: string): readonly string[] {
  const specDir = path.join(rootDir, "spec");
  if (!fs.existsSync(specDir)) return [];
  return fs
    .globSync("**/*.md", { cwd: specDir })
    .map((rel) => `spec/${rel.split(path.sep).join("/")}`)
    .sort();
}

function listWorkspacePackages(rootDir: string): readonly PackageSummary[] {
  const results: PackageSummary[] = [];
  for (const container of ["apps", "packages"] as const) {
    const containerDir = path.join(rootDir, container);
    if (!fs.existsSync(containerDir)) continue;
    const entries = fs
      .readdirSync(containerDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const pkgDir = path.join(containerDir, entry.name);
      const manifest = readJsonRecord(path.join(pkgDir, "package.json"));
      if (!manifest) continue;
      const relPath = `${container}/${entry.name}`;
      const name = typeof manifest.name === "string" && manifest.name.length > 0 ? manifest.name : relPath;
      results.push({
        name,
        path: relPath,
        scripts: readScriptNames(manifest),
        hasGen: fs.existsSync(path.join(pkgDir, "gen")),
      });
    }
  }
  return results;
}

function formatStatus(status: WorkspaceStatus): readonly string[] {
  const nameWidth = Math.max(7, ...status.packages.map((pkg) => pkg.name.length)) + 2;
  const pathWidth = Math.max(4, ...status.packages.map((pkg) => pkg.path.length)) + 2;
  const lines = [
    `${status.project}  specs:${String(status.specs.length)}  packages:${String(status.packages.length)}  gen:${status.rootGen ? "present" : "absent"}`,
  ];
  for (const pkg of status.packages) {
    const scripts = pkg.scripts.length > 0 ? pkg.scripts.join(", ") : "-";
    lines.push(`  ${pkg.name.padEnd(nameWidth)}${pkg.path.padEnd(pathWidth)}[${scripts}]`);
  }
  return lines;
}

export const statusCommand = defineCommand({
  name: "status",
  summary: "Inspect workspace packages, specs, and generated outputs",
  usage: "pnpm cli status [--package <name|path>] [--json]",
  flags: {
    package: {
      kind: "string",
      short: "p",
      description: "Filter to one workspace package by name or relative path",
    },
  },
  run: ({ flags }, ctx) => {
    const rootManifest = readJsonRecord(path.join(ctx.rootDir, "package.json"));
    const project = typeof rootManifest?.name === "string" ? rootManifest.name : path.basename(ctx.rootDir);
    const allPackages = listWorkspacePackages(ctx.rootDir);
    const packages = flags.package
      ? allPackages.filter((pkg) => pkg.name === flags.package || pkg.path === flags.package)
      : allPackages;

    if (flags.package && packages.length === 0) {
      const available = allPackages.map((pkg) => pkg.name).join(", ") || "none";
      return {
        ok: false,
        message: `Unknown workspace package "${flags.package}". Available: ${available}.`,
      };
    }

    const data: WorkspaceStatus = {
      project,
      rootGen: fs.existsSync(path.join(ctx.rootDir, "gen")),
      specs: listSpecs(ctx.rootDir),
      packages,
    };
    return { ok: true, data, lines: formatStatus(data) };
  },
});
