import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dafnyVersion } from "./cache.ts";
import { evaluatorIdentity } from "./installed.ts";
import { cachedDafnyDir, exec, findBin, findDafny, onPath } from "./run.ts";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface DoctorOptions {
  installDafny?: boolean;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const DAFNY_VERSION = "4.11.0";
const MIN_NODE = 26;
const AGENT_DIRS = [".claude", ".codex", ".cursor", ".droid", ".factory", ".gemini", ".grok", ".grokbot", ".muse", ".t3"];

function dafnyReleaseAsset(): string {
  const key = `${process.platform}:${process.arch}`;
  const assets: Record<string, string> = {
    "darwin:arm64": `dafny-${DAFNY_VERSION}-arm64-osx-14.zip`,
    "darwin:x64": `dafny-${DAFNY_VERSION}-x64-osx-13.zip`,
    "linux:x64": `dafny-${DAFNY_VERSION}-x64-ubuntu-22.04.zip`,
    "linux:arm64": `dafny-${DAFNY_VERSION}-arm64-ubuntu-22.04.zip`,
    "win32:x64": `dafny-${DAFNY_VERSION}-x64-windows-2022.zip`,
  };
  const asset = assets[key];
  if (!asset) throw new Error(`no official Dafny ${DAFNY_VERSION} release asset for ${key}`);
  return asset;
}

export async function installDafny(): Promise<string> {
  const asset = dafnyReleaseAsset();
  const url = `https://github.com/dafny-lang/dafny/releases/download/v${DAFNY_VERSION}/${asset}`;
  const targetDir = cachedDafnyDir();
  const binName = process.platform === "win32" ? "dafny.exe" : "dafny";
  const targetBin = path.join(targetDir, binName);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "vibestack-dafny-"));
  const archive = path.join(staging, asset);
  const extracted = path.join(staging, "out");
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) throw new Error(`failed to download ${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(archive, bytes);
    fs.mkdirSync(extracted, { recursive: true });
    const unzip = process.platform === "win32"
      ? await exec("powershell", ["-NoProfile", "-Command", `Expand-Archive -Path '${archive}' -DestinationPath '${extracted}' -Force`], staging)
      : await exec("unzip", ["-q", archive, "-d", extracted], staging);
    if (unzip.status !== 0 || unzip.stopped) {
      throw new Error(`failed to extract ${asset}: ${unzip.stderr || unzip.stdout || unzip.stopped}`);
    }
    const inner = path.join(extracted, "dafny");
    const sourceDir = fs.existsSync(path.join(inner, binName)) ? inner : extracted;
    if (!fs.existsSync(path.join(sourceDir, binName))) {
      throw new Error(`extracted ${asset} did not contain ${binName}`);
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    if (process.platform !== "win32") {
      fs.chmodSync(targetBin, 0o755);
      const z3Dir = path.join(targetDir, "z3", "bin");
      if (fs.existsSync(z3Dir)) {
        for (const entry of fs.readdirSync(z3Dir)) {
          const file = path.join(z3Dir, entry);
          if (fs.statSync(file).isFile()) fs.chmodSync(file, 0o755);
        }
      }
    }
    const verify = await exec(targetBin, ["--version"], targetDir);
    if (verify.status !== 0) throw new Error(`installed Dafny failed to run: ${verify.stderr || verify.stdout}`);
    return targetBin;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function checkPnpm(root: string): Promise<DoctorCheck> {
  const pnpm = onPath("pnpm");
  if (!pnpm) return { name: "pnpm", status: "fail", detail: "pnpm not found on PATH" };
  const res = await exec(pnpm, ["--version"], root).catch(() => undefined);
  if (!res || res.status !== 0) return { name: "pnpm", status: "fail", detail: `pnpm at ${pnpm} failed to run` };
  return { name: "pnpm", status: "ok", detail: `${res.stdout.trim()} (${pnpm})` };
}

async function checkDafny(install: boolean): Promise<DoctorCheck> {
  let dafny = findDafny();
  if (!dafny && install) {
    try {
      dafny = await installDafny();
    } catch (error) {
      return { name: "dafny", status: "fail", detail: `install failed: ${(error as Error).message}` };
    }
  }
  if (!dafny) {
    return {
      name: "dafny",
      status: "fail",
      detail: `Dafny 4.11 not found on PATH or in ${cachedDafnyDir()} (run \`vibestack doctor --install-dafny\`)`,
    };
  }
  const checked = await dafnyVersion();
  if (checked.problem) {
    if (install && !dafny.startsWith(cachedDafnyDir())) {
      try {
        const installed = await installDafny();
        return { name: "dafny", status: "ok", detail: `installed Dafny ${DAFNY_VERSION} at ${installed}` };
      } catch (error) {
        return { name: "dafny", status: "fail", detail: `install failed: ${(error as Error).message}` };
      }
    }
    return { name: "dafny", status: "fail", detail: checked.problem };
  }
  return { name: "dafny", status: "ok", detail: `${checked.version} (${dafny})` };
}

function checkQuint(root: string): DoctorCheck {
  const quint = findBin("quint", root);
  if (!quint) return { name: "quint", status: "fail", detail: "quint CLI not found; run pnpm install" };
  const evaluator = evaluatorIdentity(root);
  if (!evaluator) {
    return { name: "quint", status: "warn", detail: `CLI found (${quint}), Rust evaluator not yet cached (will download on first check)` };
  }
  return { name: "quint", status: "ok", detail: `CLI and Rust evaluator ready (${quint})` };
}

async function checkChromium(): Promise<DoctorCheck> {
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    if (exe && fs.existsSync(exe)) return { name: "chromium", status: "ok", detail: exe };
    return { name: "chromium", status: "warn", detail: "Chromium not installed (optional unless running browser tests/explore; run `spec ci chromium`)" };
  } catch {
    return { name: "chromium", status: "warn", detail: "Playwright not installed (optional unless running browser tests/explore)" };
  }
}

function checkSkillLinks(root: string): DoctorCheck {
  const canonical = path.join(root, ".agents/skills");
  if (!fs.existsSync(canonical)) {
    return { name: "skills", status: "warn", detail: ".agents/skills not present (run `vibestack init`)" };
  }
  const missing: string[] = [];
  for (const agent of AGENT_DIRS) {
    const dest = path.join(root, agent, "skills");
    if (!fs.lstatSync(dest, { throwIfNoEntry: false })) missing.push(`${agent}/skills`);
  }
  const claudeMd = path.join(root, "CLAUDE.md");
  if (fs.existsSync(path.join(root, "AGENTS.md")) && !fs.lstatSync(claudeMd, { throwIfNoEntry: false })) {
    missing.push("CLAUDE.md");
  }
  if (missing.length) {
    return { name: "skills", status: "warn", detail: `missing links: ${missing.join(", ")} (run \`vibestack link\`)` };
  }
  return { name: "skills", status: "ok", detail: `all ${AGENT_DIRS.length} agent skill links present` };
}

function checkManifest(root: string): DoctorCheck {
  const manifestFile = path.join(root, ".agents/.vibestack-manifest.json");
  if (!fs.existsSync(manifestFile)) {
    return { name: "manifest", status: "warn", detail: ".agents/.vibestack-manifest.json not present (run `vibestack init` to track managed assets)" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { version?: string; files?: Record<string, string> };
    if (!parsed || typeof parsed !== "object" || !parsed.files || typeof parsed.files !== "object") {
      return { name: "manifest", status: "fail", detail: ".agents/.vibestack-manifest.json is malformed" };
    }
    const modified: string[] = [];
    const missing: string[] = [];
    for (const [rel, expectedHash] of Object.entries(parsed.files)) {
      const full = path.join(root, rel);
      if (!fs.existsSync(full)) {
        missing.push(rel);
      } else {
        const currentHash = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        if (currentHash !== expectedHash) modified.push(rel);
      }
    }
    if (missing.length) {
      return { name: "manifest", status: "warn", detail: `v${parsed.version ?? "?"}: ${missing.length} managed file(s) missing (${missing.slice(0, 3).join(", ")})` };
    }
    if (modified.length) {
      return { name: "manifest", status: "ok", detail: `v${parsed.version ?? "?"}: ${Object.keys(parsed.files).length} tracked (${modified.length} locally customized)` };
    }
    return { name: "manifest", status: "ok", detail: `v${parsed.version ?? "?"}: ${Object.keys(parsed.files).length} managed files clean` };
  } catch (error) {
    return { name: "manifest", status: "fail", detail: `.agents/.vibestack-manifest.json: ${(error as Error).message}` };
  }
}

export async function doctor(root: string, options: DoctorOptions = {}): Promise<DoctorReport> {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const nodeCheck: DoctorCheck = nodeMajor >= MIN_NODE
    ? { name: "node", status: "ok", detail: `v${process.versions.node} (${process.execPath})` }
    : { name: "node", status: "fail", detail: `v${process.versions.node} found; requires Node >=${MIN_NODE}` };

  const [pnpmCheck, dafnyCheck, chromiumCheck] = await Promise.all([
    checkPnpm(root),
    checkDafny(Boolean(options.installDafny)),
    checkChromium(),
  ]);

  const checks: DoctorCheck[] = [
    nodeCheck,
    pnpmCheck,
    dafnyCheck,
    checkQuint(root),
    chromiumCheck,
    checkSkillLinks(root),
    checkManifest(root),
  ];
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  return report.checks.map((c) => `${icon[c.status]} ${c.name.padEnd(10)} ${c.detail}`).join("\n");
}
