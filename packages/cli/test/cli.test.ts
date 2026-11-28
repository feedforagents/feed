import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { commands, defineCommand, runCli, type CliIo } from "../src/index.ts";

const templateRoot = path.resolve(import.meta.dirname, "../../..");
const mainPath = path.resolve(import.meta.dirname, "../src/main.ts");

function createRecorder(): { readonly io: CliIo; readonly out: () => string; readonly err: () => string } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      writeOut: (text) => {
        stdout.push(text);
      },
      writeErr: (text) => {
        stderr.push(text);
      },
    },
    out: () => stdout.join(""),
    err: () => stderr.join(""),
  };
}

function parseJson(raw: string): unknown {
  return JSON.parse(raw) as unknown;
}

describe("project CLI", () => {
  test("lists registered commands in human and JSON help output", async () => {
    const human = createRecorder();
    expect(await runCli({ argv: ["--help"], commands, rootDir: templateRoot, cwd: templateRoot, io: human.io })).toBe(0);
    expect(human.out()).toContain("Usage: pnpm cli <command> [options]");
    expect(human.out()).toContain("status");

    const structured = createRecorder();
    expect(await runCli({ argv: ["help", "--json"], commands, rootDir: templateRoot, cwd: templateRoot, io: structured.io })).toBe(0);
    const helpPayload = parseJson(structured.out()) as {
      readonly ok: boolean;
      readonly command: string;
      readonly data: {
        readonly commands: readonly { readonly name: string }[];
      };
    };
    expect(helpPayload.ok).toBe(true);
    expect(helpPayload.command).toBe("help");
    expect(helpPayload.data.commands.map((cmd) => cmd.name)).toEqual(["status", "deploy", "verify-live"]);

    const single = createRecorder();
    expect(await runCli({ argv: ["status", "--help", "--json"], commands, rootDir: templateRoot, cwd: templateRoot, io: single.io })).toBe(0);
    expect(parseJson(single.out())).toEqual({
      ok: true,
      command: "help",
      data: {
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
      },
    });
  });

  test("status inspects workspace packages and specs and supports filtering", async () => {
    const all = createRecorder();
    expect(await runCli({ argv: ["status", "--json"], commands, rootDir: templateRoot, cwd: templateRoot, io: all.io })).toBe(0);
    const parsed = parseJson(all.out()) as {
      readonly ok: boolean;
      readonly command: string;
      readonly data: {
        readonly project: string;
        readonly specs: readonly string[];
        readonly packages: readonly { readonly name: string; readonly path: string }[];
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("status");
    expect(parsed.data.specs).toContain("spec/index.md");
    expect(parsed.data.packages.map((pkg) => pkg.name)).toEqual([
      "@repo/app",
      "@repo/auth",
      "@repo/cli",
      "@repo/db",
      "@repo/design-system",
      "@repo/engine",
      "@repo/markets",
      "@repo/mcp",
      "@repo/pack-default",
      "@repo/social",
      "@repo/ui",
    ]);

    const filtered = createRecorder();
    expect(await runCli({ argv: ["status", "-p", "@repo/app", "--json"], commands, rootDir: templateRoot, cwd: templateRoot, io: filtered.io })).toBe(0);
    const filteredParsed = parseJson(filtered.out()) as {
      readonly ok: boolean;
      readonly command: string;
      readonly data: {
        readonly packages: readonly { readonly name: string; readonly path: string }[];
      };
    };
    expect(filteredParsed.ok).toBe(true);
    expect(filteredParsed.command).toBe("status");
    expect(filteredParsed.data.packages.map((pkg) => ({ name: pkg.name, path: pkg.path }))).toEqual([
      { name: "@repo/app", path: "apps/app" },
    ]);

    const missing = createRecorder();
    expect(await runCli({ argv: ["status", "--package", "@repo/missing", "--json"], commands, rootDir: templateRoot, cwd: templateRoot, io: missing.io })).toBe(1);
    const missingParsed = parseJson(missing.out()) as { readonly ok: boolean; readonly command: string; readonly error: string };
    expect(missingParsed.ok).toBe(false);
    expect(missingParsed.command).toBe("status");
    expect(missingParsed.error).toContain("@repo/missing");
  });

  test("returns exit code 2 on unknown commands and unknown flags", async () => {
    const unknownCmd = createRecorder();
    expect(await runCli({ argv: ["nope"], commands, rootDir: templateRoot, cwd: templateRoot, io: unknownCmd.io })).toBe(2);
    expect(unknownCmd.err()).toContain('Unknown command "nope"');

    const unknownFlag = createRecorder();
    expect(await runCli({ argv: ["status", "--bogus", "--json"], commands, rootDir: templateRoot, cwd: templateRoot, io: unknownFlag.io })).toBe(2);
    expect(parseJson(unknownFlag.out())).toMatchObject({
      ok: false,
      command: "status",
    });

    const failing = defineCommand({
      name: "boom",
      summary: "Throws at runtime",
      run: () => {
        throw new Error("corrupt state");
      },
    });

    const textFailure = createRecorder();
    expect(await runCli({ argv: ["boom"], commands: [failing], rootDir: templateRoot, cwd: templateRoot, io: textFailure.io })).toBe(1);
    expect(textFailure.err()).toBe("error: corrupt state\n");

    const jsonFailure = createRecorder();
    expect(await runCli({ argv: ["boom", "--json"], commands: [failing], rootDir: templateRoot, cwd: templateRoot, io: jsonFailure.io })).toBe(1);
    expect(parseJson(jsonFailure.out())).toEqual({
      ok: false,
      command: "boom",
      error: "corrupt state",
    });
  });

  test("defineCommand parses typed flags and positionals for custom levers", async () => {
    const custom = defineCommand({
      name: "echo",
      summary: "Echo input",
      flags: {
        upper: { kind: "boolean", short: "u", description: "Uppercase output" },
        prefix: { kind: "string", description: "Prefix text" },
      },
      run: ({ flags, positionals }) => {
        const joined = positionals.join(" ");
        const body = flags.upper ? joined.toUpperCase() : joined;
        const text = flags.prefix ? `${flags.prefix}:${body}` : body;
        return { ok: true, data: { text }, lines: [text] };
      },
    });

    const recorded = createRecorder();
    expect(await runCli({
      argv: ["echo", "-u", "--prefix", "ok", "hello", "world"],
      commands: [custom],
      rootDir: templateRoot,
      cwd: templateRoot,
      io: recorded.io,
    })).toBe(0);
    expect(recorded.out()).toBe("ok:HELLO WORLD\n");
  });

  test("executes directly on Node 26 via src/main.ts", () => {
    const stdout = execFileSync(process.execPath, [mainPath, "status", "--json"], {
      cwd: templateRoot,
      encoding: "utf8",
    });
    const parsed = parseJson(stdout) as {
      readonly ok: boolean;
      readonly command: string;
      readonly data: {
        readonly packages: readonly { readonly name: string }[];
      };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.command).toBe("status");
    expect(parsed.data.packages.map((pkg) => pkg.name)).toContain("@repo/cli");
  });

  test("deploy rejects conflicting --dry-run and --destroy flags", async () => {
    const recorded = createRecorder();
    expect(await runCli({
      argv: ["deploy", "--dry-run", "--destroy", "--json"],
      commands,
      rootDir: templateRoot,
      cwd: templateRoot,
      io: recorded.io,
    })).toBe(2);
    expect(parseJson(recorded.out())).toMatchObject({
      ok: false,
      command: "deploy",
    });
  });

  test("verify-live checks Feed endpoints against a fake fetch transport", async () => {
    const { verifyFeedDeployment } = await import("../src/index.ts");
    const seen: string[] = [];
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(url).pathname;
      const method = init?.method ?? "GET";
      seen.push(`${method} ${pathname}`);
      if (pathname === "/api/health") {
        return Promise.resolve(new Response(JSON.stringify({ ok: true, service: "feed", gameStart: "run", commit: "abc1234" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      if (pathname === "/") {
        return Promise.resolve(new Response('<div id="root"></div>', { status: 200 }));
      }
      if (pathname === "/SKILL.md") {
        return Promise.resolve(new Response("# feed.fun skill", { status: 200 }));
      }
      if (pathname === "/skill.md") {
        return Promise.resolve(new Response(null, { status: 301, headers: { location: "https://staging.feed.fun/SKILL.md" } }));
      }
      if (pathname === "/.well-known/agent-skills/index.json") {
        return Promise.resolve(new Response(JSON.stringify({ skills: [{ name: "feed" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      if (pathname === "/.well-known/oauth-authorization-server") {
        return Promise.resolve(new Response(JSON.stringify({
          authorization_endpoint: "https://staging.feed.fun/oauth/authorize",
          token_endpoint: "https://staging.feed.fun/oauth/token",
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (pathname === "/api/feed") {
        return Promise.resolve(new Response(JSON.stringify({ items: [{ id: "p1" }] }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (pathname === "/api/markets") {
        return Promise.resolve(new Response(JSON.stringify({ predictions: [{ id: "m1" }], perps: [{ ticker: "FEED" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }));
      }
      if (pathname === "/api/leaderboard") {
        return Promise.resolve(new Response(JSON.stringify({ entries: [], leaderboard: [] }), { status: 200, headers: { "content-type": "application/json" } }));
      }
      if (pathname === "/mcp") {
        const bodyText = typeof init?.body === "string" ? init.body : "";
        if (bodyText.includes("create_post")) {
          return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "www-authenticate": 'Bearer resource_metadata="https://staging.feed.fun/.well-known/oauth-protected-resource"' },
          }));
        }
        return Promise.resolve(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 }));
      }
      return Promise.resolve(new Response("ok", { status: 200 }));
    };

    const report = await verifyFeedDeployment({
      baseUrl: "https://staging.feed.fun",
      commitSha: "abc1234",
      cronSecret: "test-cron-secret",
      maxAttempts: 1,
      initialDelayMs: 0,
      fetch: fakeFetch,
    });
    expect(report.ok).toBe(true);
    expect(report.primary.probes).toHaveLength(16);
    expect(seen).toContain("POST /api/cron/minute-tick");
    expect(seen).toContain("POST /api/cron/npc-tick");
  });
});
