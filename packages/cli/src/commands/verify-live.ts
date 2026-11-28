import {
  verifyDeploymentEndpoints,
  type DeploymentReceipt,
  type EndpointCheck,
} from "vibestack/alchemy";
import { defineCommand } from "../runner.ts";

export interface FeedVerificationOptions {
  readonly baseUrl: string;
  readonly commitSha?: string;
  readonly cronSecret?: string;
  readonly includeCron?: boolean;
  readonly secondaryUrls?: readonly string[];
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly timeoutMs?: number;
  readonly assetHash?: string;
  readonly throwOnFailure?: boolean;
  readonly fetch?: typeof globalThis.fetch;
}

export interface FeedVerificationReport {
  readonly ok: boolean;
  readonly primary: DeploymentReceipt;
  readonly secondary: readonly DeploymentReceipt[];
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}

function nonEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1;
}

export function buildFeedVerificationChecks(options: {
  readonly commitSha?: string;
  readonly cronSecret?: string;
  readonly includeCron?: boolean;
} = {}): readonly EndpointCheck[] {
  const checks: EndpointCheck[] = [
    {
      path: "/api/health",
      expectedStatus: 200,
      ...(options.commitSha ? { expectedCommitSha: options.commitSha } : {}),
      expectJson: (parsed) => {
        const record = asRecord(parsed);
        if (!record) return "expected JSON object from /api/health";
        if (record.ok !== true) return "expected ok=true from /api/health";
        if (record.service !== "feed") return `expected service="feed", got ${String(record.service)}`;
        if (record.gameStart !== "run") return `expected gameStart="run", got ${String(record.gameStart)}`;
        return true;
      },
    },
    {
      path: "/",
      expectedStatus: 200,
      bodyIncludes: ['id="root"'],
    },
    {
      path: "/SKILL.md",
      expectedStatus: 200,
      bodyIncludes: ["feed.fun"],
    },
    {
      path: "/skill.md",
      redirect: "manual",
      expectedStatus: 301,
      expectedHeaders: { location: /\/SKILL\.md$/ },
    },
    {
      path: "/llms.txt",
      expectedStatus: 200,
    },
    {
      path: "/how-to-play.md",
      expectedStatus: 200,
    },
    {
      path: "/.well-known/agent-skills/index.json",
      expectedStatus: 200,
      expectJson: (parsed) => nonEmptyArray(asRecord(parsed)?.skills) || "missing skills in discovery index",
    },
    {
      path: "/.well-known/oauth-authorization-server",
      expectedStatus: 200,
      expectJson: (parsed) => {
        const record = asRecord(parsed);
        return (typeof record?.authorization_endpoint === "string" && typeof record?.token_endpoint === "string")
          || "invalid OAuth authorization server metadata";
      },
    },
    {
      path: "/.well-known/oauth-protected-resource",
      expectedStatus: 200,
    },
    {
      path: "/api/feed",
      expectedStatus: 200,
      expectJson: (parsed) => nonEmptyArray(asRecord(parsed)?.items) || "/api/feed returned empty items",
    },
    {
      path: "/api/markets",
      expectedStatus: 200,
      expectJson: (parsed) => {
        const record = asRecord(parsed);
        if (!nonEmptyArray(record?.predictions)) return "/api/markets returned empty predictions";
        if (!nonEmptyArray(record?.perps)) return "/api/markets returned empty perps";
        return true;
      },
    },
    {
      path: "/api/leaderboard",
      expectedStatus: 200,
      expectJson: (parsed) => {
        const record = asRecord(parsed);
        return (Array.isArray(record?.entries) && Array.isArray(record?.leaderboard))
          || "/api/leaderboard missing entries/leaderboard arrays";
      },
    },
    {
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "list_markets", arguments: {} },
      }),
      expectedStatus: 200,
    },
    {
      path: "/mcp",
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "create_post", arguments: { content: "unauth probe" } },
      }),
      expectedStatus: 401,
      expectedHeaders: { "www-authenticate": /.+/ },
    },
  ];

  const cronSecret = options.cronSecret?.trim();
  if (options.includeCron !== false && cronSecret) {
    checks.push(
      {
        path: "/api/cron/minute-tick",
        method: "POST",
        headers: { authorization: `Bearer ${cronSecret}` },
        expectedStatus: 200,
      },
      {
        path: "/api/cron/npc-tick",
        method: "POST",
        headers: { authorization: `Bearer ${cronSecret}` },
        expectedStatus: 200,
      },
    );
  }

  return checks;
}

export async function verifyFeedDeployment(options: FeedVerificationOptions): Promise<FeedVerificationReport> {
  const checks = buildFeedVerificationChecks({
    ...(options.commitSha ? { commitSha: options.commitSha } : {}),
    ...(options.cronSecret ? { cronSecret: options.cronSecret } : {}),
    ...(options.includeCron !== undefined ? { includeCron: options.includeCron } : {}),
  });

  const primary = await verifyDeploymentEndpoints(options.baseUrl, checks, {
    maxAttempts: options.maxAttempts ?? 12,
    initialDelayMs: options.initialDelayMs ?? 1_500,
    maxDelayMs: options.maxDelayMs ?? 5_000,
    timeoutMs: options.timeoutMs ?? 30_000,
    throwOnFailure: options.throwOnFailure ?? false,
    ...(options.assetHash ? { assetHash: options.assetHash } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const secondary: DeploymentReceipt[] = [];
  for (const secondaryUrl of options.secondaryUrls ?? []) {
    const receipt = await verifyDeploymentEndpoints(
      secondaryUrl,
      [
        {
          path: "/api/health",
          expectedStatus: 200,
          ...(options.commitSha ? { expectedCommitSha: options.commitSha } : {}),
          expectJson: (parsed) => asRecord(parsed)?.ok === true || "expected ok=true from secondary health check",
        },
      ],
      {
        maxAttempts: options.maxAttempts ?? 8,
        initialDelayMs: options.initialDelayMs ?? 1_500,
        maxDelayMs: options.maxDelayMs ?? 4_000,
        timeoutMs: options.timeoutMs ?? 20_000,
        throwOnFailure: options.throwOnFailure ?? false,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      },
    );
    secondary.push(receipt);
  }

  return {
    ok: primary.ok && secondary.every((receipt) => receipt.ok),
    primary,
    secondary,
  };
}

function resolveDefaultUrls(stage: string | undefined, explicitUrl: string | undefined): {
  readonly primaryUrl: string;
  readonly secondaryUrls: readonly string[];
} {
  if (explicitUrl) {
    return { primaryUrl: explicitUrl, secondaryUrls: [] };
  }
  const normalized = stage?.trim().toLowerCase();
  if (normalized === "production" || normalized === "prod") {
    return { primaryUrl: "https://feed.fun", secondaryUrls: ["https://www.feed.fun"] };
  }
  if (normalized === "staging") {
    return { primaryUrl: "https://staging.feed.fun", secondaryUrls: [] };
  }
  return { primaryUrl: "http://127.0.0.1:8787", secondaryUrls: [] };
}

function resolveCronSecretFromEnv(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const direct = env.CRON_SECRET?.trim();
  if (direct) return direct;
  const raw = env.CLOUDFLARE_RUNTIME_SECRETS?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const secret = asRecord(parsed)?.CRON_SECRET;
    return typeof secret === "string" && secret.trim().length > 0 ? secret.trim() : undefined;
  } catch {
    return undefined;
  }
}

export const verifyLiveCommand = defineCommand({
  name: "verify-live",
  summary: "Verify live Feed endpoints, MCP auth boundaries, and cron ticks",
  usage: "pnpm cli verify-live [--stage <staging|production>] [--url <url>] [--commit <sha>] [--skip-cron] [--json]",
  flags: {
    stage: {
      kind: "string",
      short: "s",
      description: "Target deployment stage (staging or production)",
    },
    url: {
      kind: "string",
      description: "Explicit base URL to probe instead of stage default",
    },
    commit: {
      kind: "string",
      description: "Expected COMMIT_SHA reported by /api/health",
    },
    "skip-cron": {
      kind: "boolean",
      description: "Skip authenticated POST /api/cron/* smoke probes",
    },
  },
  run: async ({ flags }) => {
    const { primaryUrl, secondaryUrls } = resolveDefaultUrls(flags.stage, flags.url);
    const commitSha = flags.commit?.trim() || process.env.COMMIT_SHA?.trim() || process.env.GITHUB_SHA?.trim() || undefined;
    const cronSecret = flags["skip-cron"] ? undefined : resolveCronSecretFromEnv(process.env);
    const report = await verifyFeedDeployment({
      baseUrl: primaryUrl,
      secondaryUrls,
      includeCron: !flags["skip-cron"],
      ...(commitSha ? { commitSha } : {}),
      ...(cronSecret ? { cronSecret } : {}),
      throwOnFailure: false,
    });

    const totalProbes = report.primary.probes.length + report.secondary.reduce((sum, item) => sum + item.probes.length, 0);
    const failedProbes = [
      ...report.primary.probes,
      ...report.secondary.flatMap((item) => item.probes),
    ].filter((probe) => !probe.ok);

    if (!report.ok) {
      const detail = failedProbes
        .map((probe) => `${probe.method} ${probe.url}: ${probe.error ?? `HTTP ${String(probe.status)}`}`)
        .join("; ");
      return {
        ok: false,
        message: `Live verification failed (${String(failedProbes.length)}/${String(totalProbes)} failed): ${detail}`,
        exitCode: 1,
        data: report,
      };
    }

    return {
      ok: true,
      data: report,
      lines: [
        `verified ${primaryUrl}${secondaryUrls.length > 0 ? ` (+ ${secondaryUrls.join(", ")})` : ""}: ${String(totalProbes)}/${String(totalProbes)} probes ok`,
      ],
    };
  },
});
