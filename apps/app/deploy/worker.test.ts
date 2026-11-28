import path from "node:path";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Vitest";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expect } from "vitest";
import { hashAssetDirectory, resolveStage, verifyDeploymentEndpoints } from "vibestack/alchemy";

const appDir = path.resolve(import.meta.dirname, "..");
const webDistDir = path.join(appDir, "dist/web");
const workerEntry = path.join(appDir, "dist/server/worker.js");
const stage = resolveStage({ mode: "test", cwd: appDir }).stage;

const WORKER_FIRST_ROUTES = [
  "/api/*",
  "/mcp",
  "/oauth/*",
  "/.well-known/*",
  "/SKILL.md",
  "/skill.md",
  "/llms.txt",
  "/how-to-play.md",
];

const FeedWorkerTestStack = Alchemy.Stack(
  "FeedWorkerOfflineTest",
  {
    providers: Cloudflare.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const uploads = yield* Cloudflare.R2.Bucket("Uploads");
    const email = yield* Cloudflare.Email.SendEmail("Email");
    const assets = hashAssetDirectory(webDistDir);
    const worker = yield* Cloudflare.Worker("FeedWeb", {
      main: workerEntry,
      compatibility: {
        date: "2026-10-10",
        flags: ["nodejs_compat", "global_fetch_strictly_public"],
      },
      workersDev: true,
      assets: {
        directory: assets.directory,
        hash: assets.hash,
        notFoundHandling: "single-page-application",
        runWorkerFirst: WORKER_FIRST_ROUTES,
      },
      env: {
        UPLOADS: uploads,
        EMAIL: email,
        DEPLOYMENT_ENV: "localnet",
        SMS_MODE: "loopback",
        EMAIL_MODE: "loopback",
        EMAIL_FROM: "Feed Test <login@feed.fun>",
        GAME_START: "run",
        COMMIT_SHA: "workerd-offline-test",
      },
    });
    return { url: worker.url, assetHash: assets.hash };
  }),
);

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  stage,
});

const stack = beforeAll(deploy(FeedWorkerTestStack));
afterAll(destroy(FeedWorkerTestStack));

test("boots compiled Feed worker and serves SPA assets and discovery routes in offline workerd", Effect.gen(function* () {
  const outputs = yield* stack;
  expect(outputs?.url).toMatch(/^http:\/\/(?:localhost|127\.0\.0\.1):/);
  const url = outputs?.url;
  if (!url) throw new Error("Missing local workerd URL");

  const receipt = yield* Effect.promise(() =>
    verifyDeploymentEndpoints(
      url,
      [
        { path: "/", expectedStatus: 200, bodyIncludes: ['id="root"'] },
        { path: "/markets", expectedStatus: 200, bodyIncludes: ['id="root"'] },
        { path: "/SKILL.md", expectedStatus: 200, bodyIncludes: ["feed.fun"] },
        { path: "/skill.md", redirect: "manual", expectedStatus: 301, expectedHeaders: { location: /\/SKILL\.md$/ } },
        { path: "/llms.txt", expectedStatus: 200 },
        { path: "/how-to-play.md", expectedStatus: 200 },
        {
          path: "/.well-known/agent-skills/index.json",
          expectedStatus: 200,
          expectJson: (parsed) => {
            const record = parsed as { readonly skills?: readonly unknown[] };
            return Array.isArray(record.skills) && record.skills.length >= 1;
          },
        },
        {
          path: "/.well-known/oauth-authorization-server",
          expectedStatus: 200,
          expectJson: (parsed) => {
            const record = parsed as { readonly authorization_endpoint?: unknown; readonly token_endpoint?: unknown };
            return typeof record.authorization_endpoint === "string" && typeof record.token_endpoint === "string";
          },
        },
        { path: "/.well-known/oauth-protected-resource", expectedStatus: 200 },
        {
          path: "/api/health",
          expectedStatus: [200, 503],
          expectJson: (parsed) => {
            const record = parsed as { readonly ok?: unknown; readonly code?: unknown };
            return record.ok === true || record.code === "service_unavailable";
          },
        },
        {
          path: "/api/markets",
          expectedStatus: [200, 503],
          expectJson: (parsed) => {
            const record = parsed as { readonly predictions?: unknown; readonly code?: unknown };
            return Array.isArray(record.predictions) || record.code === "service_unavailable";
          },
        },
      ],
      { assetHash: outputs.assetHash, maxAttempts: 4, initialDelayMs: 250 },
    ),
  );

  expect(receipt.ok).toBe(true);
  expect(receipt.probes).toHaveLength(11);
}));
