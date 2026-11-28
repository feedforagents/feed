import { createHmac } from "node:crypto";
import path from "node:path";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { makeBucketState } from "alchemy/State/BucketState";
import { State, StateStoreError } from "alchemy/State/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Scope from "effect/Scope";
import {
  assertStageGuard,
  hashAssetDirectory,
  makeR2BucketObjects,
  resolveStage,
  type StageTarget,
} from "vibestack/alchemy";
import { verifyFeedDeployment } from "./packages/cli/src/index.ts";

const appDir = path.resolve(import.meta.dirname, "apps/app");
const webDistDir = path.join(appDir, "dist/web");
const workerEntry = path.join(appDir, "dist/server/worker.js");

const FEED_ZONE_ID = "08739bb9c9b30960640ff2dc106c3361";
const PROD_HYPERDRIVE_ID = "5d4f76cda3ea4a12990460442c657442";
const STAGING_HYPERDRIVE_ID = "e379cb0027b449588ee8eee7250ceffa";

const FEED_WORKER_FIRST_ROUTES = [
  "/api/*",
  "/mcp",
  "/oauth/*",
  "/.well-known/*",
  "/SKILL.md",
  "/skill.md",
  "/llms.txt",
  "/how-to-play.md",
] as const;

const FEED_CRONS = [
  "* * * * *",
  "*/2 * * * *",
  "*/5 * * * *",
] as const;

const LOCAL_DEV_HYPERDRIVE_ORIGIN = {
  scheme: "postgresql" as const,
  host: "localhost",
  port: 5433,
  database: "feed",
  user: "feed",
  password: Redacted.make("feed_dev_password"),
};

interface FeedStageConfig {
  readonly workerName?: string;
  readonly domain?: {
    readonly name: string;
    readonly aliases?: string[];
    readonly zoneId: string;
  };
  readonly hyperdriveId?: string;
  readonly uploadsBucketName?: string;
  readonly deploymentEnv: "localnet" | "staging" | "production";
  readonly publicUrl?: string;
  readonly smsMode: "loopback" | "twilio";
  readonly emailMode: "loopback" | "cloudflare";
  readonly emailFrom: string;
  readonly crons: readonly string[];
  readonly secondaryVerifyUrls: readonly string[];
  readonly runLiveVerify: boolean;
}

function resolveStageConfig(target: StageTarget): FeedStageConfig {
  switch (target.kind) {
    case "production":
      return {
        workerName: "feed-web-production",
        domain: {
          name: "feed.fun",
          aliases: ["www.feed.fun"],
          zoneId: FEED_ZONE_ID,
        },
        hyperdriveId: PROD_HYPERDRIVE_ID,
        uploadsBucketName: "feed-uploads-production",
        deploymentEnv: "production",
        publicUrl: "https://feed.fun",
        smsMode: "twilio",
        emailMode: "cloudflare",
        emailFrom: "Feed <login@feed.fun>",
        crons: FEED_CRONS,
        secondaryVerifyUrls: ["https://www.feed.fun"],
        runLiveVerify: true,
      };
    case "staging":
      return {
        workerName: "feed-web-staging",
        domain: {
          name: "staging.feed.fun",
          zoneId: FEED_ZONE_ID,
        },
        hyperdriveId: STAGING_HYPERDRIVE_ID,
        uploadsBucketName: "feed-uploads-staging",
        deploymentEnv: "staging",
        publicUrl: "https://staging.feed.fun",
        smsMode: "twilio",
        emailMode: "cloudflare",
        emailFrom: "Feed Staging <login@feed.fun>",
        crons: FEED_CRONS,
        secondaryVerifyUrls: [],
        runLiveVerify: true,
      };
    case "preview":
      return {
        workerName: `feed-web-pr-${String(target.pr)}`,
        hyperdriveId: process.env.PREVIEW_HYPERDRIVE_ID?.trim() || STAGING_HYPERDRIVE_ID,
        uploadsBucketName: `feed-uploads-pr-${String(target.pr)}`,
        deploymentEnv: "staging",
        smsMode: "twilio",
        emailMode: "cloudflare",
        emailFrom: "Feed Preview <login@feed.fun>",
        crons: [],
        secondaryVerifyUrls: [],
        runLiveVerify: true,
      };
    case "dev":
    case "test":
      return {
        deploymentEnv: "localnet",
        smsMode: "loopback",
        emailMode: "loopback",
        emailFrom: "Feed Dev <login@feed.fun>",
        crons: [],
        secondaryVerifyUrls: [],
        runLiveVerify: false,
      };
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

function resolveStateLayer() {
  return Layer.unwrap(
    Effect.gen(function* () {
      const stageName = yield* Alchemy.Stage;
      const stageTarget = resolveStage({ stage: stageName, cwd: import.meta.dirname });
      if (stageTarget.kind === "dev" || stageTarget.kind === "test") {
        return Alchemy.localState();
      }
      if (process.env.ALCHEMY_STATE_STORE === "cloudflare") {
        return Cloudflare.state({
          ...(process.env.CLOUDFLARE_ACCOUNT_ID ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID } : {}),
        });
      }
      const bucket = process.env.R2_STATE_BUCKET?.trim();
      const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
      const accessKeyId = process.env.R2_STATE_ACCESS_KEY_ID?.trim();
      const secretAccessKey = process.env.R2_STATE_SECRET_ACCESS_KEY?.trim();
      if (bucket && accountId && accessKeyId && secretAccessKey) {
        const objects = makeR2BucketObjects<StateStoreError>(
          { kind: "s3", accountId, bucket, accessKeyId, secretAccessKey },
          {
            tryPromise: Effect.tryPromise,
            makeError: ({ message, cause, status }) =>
              new StateStoreError({
                message,
                ...(cause ? { cause } : {}),
                ...(status !== undefined ? { http: { status } } : {}),
              }),
          },
        );
        return Layer.effect(
          State,
          Effect.gen(function* () {
            const context = yield* Effect.context();
            const scope = yield* Effect.scope;
            const make = makeBucketState({
              id: "r2",
              label: "Cloudflare R2",
              prefix: process.env.R2_STATE_PREFIX ?? `alchemy/feed/${stageTarget.stage}/`,
              objects: Effect.succeed(objects),
            }).pipe(Scope.provide(scope), Effect.provideContext(context));
            return yield* Effect.cached(make);
          }),
        );
      }
      return Alchemy.localState();
    }),
  );
}

function collectManagedRuntimeSecrets(
  targetEnv: "localnet" | "staging" | "production",
): Record<string, Redacted.Redacted<string>> {
  if (targetEnv === "localnet") return {};
  const rawBlob = process.env.CLOUDFLARE_RUNTIME_SECRETS?.trim();
  const cronSecret = process.env.CRON_SECRET?.trim();
  const surplusApiKey = process.env.SURPLUS_API_KEY?.trim();
  if (!rawBlob && !cronSecret && !surplusApiKey) return {};

  const parsed: Record<string, string> = {};
  if (rawBlob) {
    const decoded = JSON.parse(rawBlob) as unknown;
    if (typeof decoded === "object" && decoded !== null && !Array.isArray(decoded)) {
      for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim() !== "" && key !== "DATABASE_URL" && key !== "GAME_START") {
          parsed[key] = value;
        }
      }
    }
  }
  if (cronSecret && !parsed.CRON_SECRET) parsed.CRON_SECRET = cronSecret;
  if (surplusApiKey && !parsed.SURPLUS_API_KEY) parsed.SURPLUS_API_KEY = surplusApiKey;

  const masterKey = parsed.AGENT_ENCRYPTION_KEY || parsed.STEWARD_JWT_SECRET || parsed.CRON_SECRET || "";
  if (masterKey) {
    if (!parsed.AUTH_DIGEST_KEY) {
      parsed.AUTH_DIGEST_KEY = createHmac("sha256", masterKey)
        .update(`feed:${targetEnv}:auth-digest-key:v1`)
        .digest("hex");
    }
    if (!parsed.OAUTH_SIGNING_SECRET) {
      parsed.OAUTH_SIGNING_SECRET = createHmac("sha256", masterKey)
        .update(`feed:${targetEnv}:oauth-signing-secret:v1`)
        .digest("hex");
    }
  }

  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, Redacted.make(value)]),
  );
}

function resolveCronSecret(): string | undefined {
  const direct = process.env.CRON_SECRET?.trim();
  if (direct) return direct;
  const raw = process.env.CLOUDFLARE_RUNTIME_SECRETS?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.CRON_SECRET === "string" && parsed.CRON_SECRET.trim() !== ""
      ? parsed.CRON_SECRET.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

const VerifyFeedDeploy = Alchemy.Action(
  "VerifyFeedDeploy",
  (input: {
    readonly workerName: string;
    readonly workerUrl: string | undefined;
    readonly url: string | undefined;
    readonly assetHash: string;
    readonly commitSha: string | undefined;
    readonly secondaryUrls: readonly string[];
  }) =>
    Effect.tryPromise(async () => {
      const targetUrl = input.url ?? input.workerUrl;
      if (!targetUrl) throw new Error(`Deployed Feed worker ${input.workerName} did not return a URL`);
      const cronSecret = resolveCronSecret();
      return verifyFeedDeployment({
        baseUrl: targetUrl,
        secondaryUrls: input.secondaryUrls,
        assetHash: input.assetHash,
        ...(input.commitSha ? { commitSha: input.commitSha } : {}),
        ...(cronSecret ? { cronSecret } : {}),
        throwOnFailure: true,
      });
    }),
);

export default Alchemy.Stack(
  "Feed",
  {
    providers: Cloudflare.providers(),
    state: resolveStateLayer(),
  },
  Effect.gen(function* () {
    const stageName = yield* Alchemy.Stage;
    const stageTarget = resolveStage({ stage: stageName, cwd: import.meta.dirname });
    const cfg = resolveStageConfig(stageTarget);

    assertStageGuard(stageTarget, {
      resourceIds: {
        workerName: cfg.workerName,
        hyperdriveId: cfg.hyperdriveId,
        uploadsBucketName: cfg.uploadsBucketName,
      },
      domains: cfg.domain ? [cfg.domain.name, ...(cfg.domain.aliases ?? [])] : [],
      productionIds: [PROD_HYPERDRIVE_ID, "feed-uploads-production", "feed-web-production"],
      productionDomains: ["feed.fun", "www.feed.fun"],
    });

    const uploads = yield* Cloudflare.R2.Bucket("Uploads", {
      ...(cfg.uploadsBucketName ? { name: cfg.uploadsBucketName } : {}),
    }).pipe(Alchemy.AdoptPolicy.adopt(true), Alchemy.RemovalPolicy.retain());

    const email = yield* Cloudflare.Email.SendEmail("Email");

    const commitSha = process.env.COMMIT_SHA?.trim() || process.env.GITHUB_SHA?.trim() || undefined;
    const managedSecrets = collectManagedRuntimeSecrets(cfg.deploymentEnv);
    const assets = hashAssetDirectory(webDistDir);

    const workerEnv: Cloudflare.WorkerBindingProps = {
      UPLOADS: uploads,
      EMAIL: email,
      DEPLOYMENT_ENV: cfg.deploymentEnv,
      SMS_MODE: cfg.smsMode,
      EMAIL_MODE: cfg.emailMode,
      EMAIL_FROM: cfg.emailFrom,
      SURPLUS_BASE_URL: "https://api.surplusintelligence.ai/v1",
      SURPLUS_MODEL: "gpt-4o-mini",
      NPC_LLM_DAILY_BUDGET_USD: "100",
      NPC_MAX_STEPS_PER_TICK: "4",
      GAME_START: "run",
      ...managedSecrets,
    };
    if (cfg.hyperdriveId) {
      workerEnv.HYPERDRIVE = Cloudflare.Hyperdrive.lookup("FeedHyperdrive", {
        hyperdriveId: cfg.hyperdriveId,
        dev: LOCAL_DEV_HYPERDRIVE_ORIGIN,
      });
    } else if (process.env.DATABASE_URL?.trim()) {
      workerEnv.DATABASE_URL = process.env.DATABASE_URL.trim();
    }
    if (cfg.publicUrl) {
      workerEnv.PUBLIC_APP_URL = cfg.publicUrl;
      workerEnv.PUBLIC_API_URL = cfg.publicUrl;
      workerEnv.EMAIL_PUBLIC_ORIGIN = cfg.publicUrl;
    }
    if (commitSha) {
      workerEnv.COMMIT_SHA = commitSha;
    }

    const web = yield* Cloudflare.Worker("FeedWeb", {
      ...(cfg.workerName ? { name: cfg.workerName } : {}),
      main: workerEntry,
      compatibility: {
        date: "2026-10-10",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      limits: {
        cpuMs: 300_000,
      },
      observability: {
        enabled: true,
      },
      workersDev: true,
      ...(cfg.domain ? { domain: cfg.domain } : {}),
      ...(cfg.crons.length > 0 ? { crons: [...cfg.crons] } : {}),
      assets: {
        directory: assets.directory,
        hash: assets.hash,
        notFoundHandling: "single-page-application",
        runWorkerFirst: [...FEED_WORKER_FIRST_ROUTES],
      },
      env: workerEnv,
    }).pipe(Alchemy.AdoptPolicy.adopt(true), Alchemy.RemovalPolicy.retain());

    const shouldVerifyLive = cfg.runLiveVerify && process.env.ALCHEMY_SKIP_LIVE_VERIFY !== "1";
    const verification = shouldVerifyLive
      ? yield* VerifyFeedDeploy({
          workerName: web.workerName,
          workerUrl: web.url,
          url: cfg.publicUrl ?? web.url,
          assetHash: assets.hash,
          commitSha,
          secondaryUrls: cfg.secondaryVerifyUrls,
        })
      : undefined;

    return {
      url: web.url,
      workerName: web.workerName,
      stage: stageTarget.stage,
      assetHash: assets.hash,
      verified: verification ? verification.ok : false,
    };
  }),
);
