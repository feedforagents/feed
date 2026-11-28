import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StageTarget } from "vibestack/alchemy";
import { defineCommand } from "../runner.ts";
import { verifyFeedDeployment, type FeedVerificationReport } from "./verify-live.ts";

interface DeploySummary {
  readonly action: "plan" | "deploy" | "destroy";
  readonly stage: StageTarget["stage"];
  readonly stageKind: StageTarget["kind"];
  readonly config: string;
  readonly exitCode: number;
  readonly url?: string;
  readonly verification?: FeedVerificationReport;
}

function findAlchemyBin(rootDir: string): string | undefined {
  const name = process.platform === "win32" ? "alchemy.cmd" : "alchemy";
  for (let dir = path.resolve(rootDir); ; ) {
    const candidate = path.join(dir, "node_modules", ".bin", name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function extractDeployedUrl(output: string): string | undefined {
  const matches = output.match(/https?:\/\/[^\s"'<>]+/g);
  if (!matches) return undefined;
  for (const candidate of matches.toReversed()) {
    if (!candidate.includes("alchemy.run") && !candidate.includes("cloudflare.com/client/v4")) {
      return candidate.replace(/[.,);]+$/, "");
    }
  }
  return undefined;
}

function defaultStageUrl(target: StageTarget): string | undefined {
  if (target.kind === "production") return "https://feed.fun";
  if (target.kind === "staging") return "https://staging.feed.fun";
  return undefined;
}

export const deployCommand = defineCommand({
  name: "deploy",
  summary: "Plan, deploy, verify, or destroy Feed Cloudflare infrastructure via Alchemy",
  usage: "pnpm cli deploy [--stage <name>] [--dry-run] [--verify] [--destroy] [--adopt] [--url <url>] [--commit <sha>] [--json]",
  flags: {
    stage: {
      kind: "string",
      short: "s",
      description: "Target stage (defaults to worktree-scoped dev_<user>_<worktree>)",
    },
    "dry-run": {
      kind: "boolean",
      description: "Run `alchemy plan` without mutating cloud resources",
    },
    verify: {
      kind: "boolean",
      description: "Verify live Feed endpoints after deploy (or verify --url directly)",
    },
    destroy: {
      kind: "boolean",
      description: "Destroy resources for the target stage",
    },
    adopt: {
      kind: "boolean",
      description: "Pass --adopt to adopt existing Cloudflare resources",
    },
    url: {
      kind: "string",
      description: "Explicit base URL to verify when running --verify",
    },
    commit: {
      kind: "string",
      description: "Expected COMMIT_SHA to verify against /api/health",
    },
  },
  run: async ({ flags }, ctx) => {
    const { resolveStage } = await import("vibestack/alchemy");
    const configPath = path.join(ctx.rootDir, "alchemy.run.ts");
    const target = resolveStage({ stage: flags.stage, cwd: ctx.rootDir });

    if (flags["dry-run"] && flags.destroy) {
      return { ok: false, message: "Cannot combine --dry-run and --destroy.", exitCode: 2 };
    }

    if (flags.verify && flags.url && !flags.destroy && !flags["dry-run"]) {
      const verification = await verifyFeedDeployment({
        baseUrl: flags.url,
        ...(flags.commit ? { commitSha: flags.commit } : {}),
        throwOnFailure: false,
      });
      const data: DeploySummary = {
        action: "deploy",
        stage: target.stage,
        stageKind: target.kind,
        config: path.relative(ctx.rootDir, configPath),
        exitCode: verification.ok ? 0 : 1,
        url: flags.url,
        verification,
      };
      return verification.ok
        ? { ok: true, data, lines: [`verified ${flags.url} (${String(verification.primary.probes.length)} probe(s) ok)`] }
        : { ok: false, message: `Verification failed for ${flags.url}.`, exitCode: 1, data };
    }

    if (!fs.existsSync(configPath)) {
      return { ok: false, message: `No alchemy.run.ts found in ${ctx.rootDir}.`, exitCode: 1 };
    }

    const alchemyBin = findAlchemyBin(ctx.rootDir);
    if (!alchemyBin) {
      return { ok: false, message: "alchemy binary not found in node_modules/.bin. Run pnpm install.", exitCode: 1 };
    }

    const action: DeploySummary["action"] = flags["dry-run"] ? "plan" : flags.destroy ? "destroy" : "deploy";
    const args = ["--fast-distilled", action, "--stage", target.stage, "--config", configPath];
    if (action === "deploy" && (flags.adopt || target.kind === "staging" || target.kind === "production")) {
      args.push("--adopt");
    }
    if (action !== "plan") args.push("--yes", "--no-input");
    if (ctx.json) args.push("--log-format", "json");

    const captureOutput = ctx.json || (flags.verify && !flags.url && action === "deploy");
    const result = spawnSync(alchemyBin, args, {
      cwd: ctx.rootDir,
      encoding: "utf8",
      env: { ...process.env, ALCHEMY_FAST_DISTILLED: "1", ALCHEMY_STAGE: target.stage },
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    if (captureOutput && !ctx.json) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }

    if (result.error) {
      return { ok: false, message: result.error.message, exitCode: 1 };
    }

    const exitCode = result.status ?? 1;
    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const detectedUrl = flags.url ?? defaultStageUrl(target) ?? extractDeployedUrl(combinedOutput);

    if (exitCode !== 0) {
      const data: DeploySummary = {
        action,
        stage: target.stage,
        stageKind: target.kind,
        config: path.relative(ctx.rootDir, configPath),
        exitCode,
        ...(detectedUrl ? { url: detectedUrl } : {}),
      };
      return {
        ok: false,
        message: `alchemy ${action} for stage "${target.stage}" exited with code ${String(exitCode)}.`,
        exitCode,
        data,
      };
    }

    let verification: FeedVerificationReport | undefined;
    if (flags.verify && action === "deploy") {
      if (!detectedUrl) {
        return {
          ok: false,
          message: "Post-deploy verification requested (--verify), but no deployed URL was detected. Pass --url <url> explicitly.",
          exitCode: 1,
        };
      }
      verification = await verifyFeedDeployment({
        baseUrl: detectedUrl,
        secondaryUrls: target.kind === "production" ? ["https://www.feed.fun"] : [],
        ...(flags.commit ? { commitSha: flags.commit } : {}),
        throwOnFailure: false,
      });
    }

    const data: DeploySummary = {
      action,
      stage: target.stage,
      stageKind: target.kind,
      config: path.relative(ctx.rootDir, configPath),
      exitCode,
      ...(detectedUrl ? { url: detectedUrl } : {}),
      ...(verification ? { verification } : {}),
    };

    if (verification && !verification.ok) {
      return { ok: false, message: `Post-deploy verification failed for ${detectedUrl}.`, exitCode: 1, data };
    }

    return {
      ok: true,
      data,
      lines: [`alchemy ${action} succeeded for stage ${target.stage}${detectedUrl ? ` (${detectedUrl})` : ""}`],
    };
  },
});
