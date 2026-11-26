import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { themeCss, tokensCss } from "../../design/generate.ts";
import { parseTokens } from "../../design/tokens.ts";
import type { ComponentIndex } from "../../stories/emit.ts";
import { short } from "../../util.ts";

export interface PreviewInfo {
  url: string | null;
  mode: "embedded" | "storybook" | "none";
}

interface PreviewServer {
  httpServer?: { address(): { port: number } | string | null } | null;
  middlewares: {
    use(
      fn: (
        req: { url?: string },
        res: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void },
        next: (err?: unknown) => void,
      ) => void,
    ): void;
  };
  transformIndexHtml(url: string, html: string): Promise<string>;
  listen(): Promise<unknown>;
  close(): Promise<void>;
}

interface PreviewPlugin {
  name: string;
  enforce?: "pre" | "post";
  configureServer?(server: PreviewServer): void;
  resolveId?(id: string): string | undefined;
  load?(id: string): string | undefined;
}

type CreateViteServer = (config: Record<string, unknown>) => Promise<PreviewServer>;
type PluginFactory = () => unknown;

interface PreviewEntry {
  ready: Promise<PreviewInfo>;
  server?: PreviewServer;
}

const VIRTUAL_ENTRY = "/@studio-preview/main.tsx";
const VIRTUAL_THEME = "virtual:studio-preview-theme.css";
const VIRTUAL_SB_TEST = "\0virtual:studio-storybook-test";
const servers = new Map<string, PreviewEntry>();
let exitHooked = false;

function siblingMetaFile(root: string, relFile: string): string | null {
  const clean = relFile.replace(/^\/+/, "");
  const stem = clean.replace(/\.[jt]sx?$/, "");
  for (const ext of [".meta.tsx", ".meta.ts"]) {
    const candidate = `${stem}${ext}`;
    if (fs.existsSync(path.join(root, candidate))) return candidate;
  }
  return null;
}

const STORYBOOK_TEST_SHIM = `
export const fn = () => {
  const f = (...args) => undefined;
  f.mockClear = () => {};
  f.mock = { calls: [] };
  return f;
};
export const expect = () => new Proxy({}, { get: () => () => {} });
export const userEvent = { click: async () => {}, keyboard: async () => {}, type: async () => {} };
export const within = () => ({ getByRole: () => null, getByText: () => null });
export const isMockFunction = () => false;
`;

function hasRunnableComponents(root: string, components?: ComponentIndex): boolean {
  if (!components?.components.length) return false;
  return components.components.some((c) => /\.[jt]sx$/.test(c.source.file) && fs.existsSync(path.join(root, c.source.file)));
}

function configuredTokenPaths(root: string): string[] {
  const configFile = path.join(root, "vibestack.json");
  if (!fs.existsSync(configFile)) return [];
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(configFile, "utf8"));
    if (!raw || typeof raw !== "object") return [];
    const record = raw as Record<string, unknown>;
    const found: string[] = [];
    if (typeof record.tokens === "string") found.push(path.resolve(root, record.tokens));
    if (record.design && typeof record.design === "object") {
      const design = record.design as Record<string, unknown>;
      if (typeof design.tokens === "string") found.push(path.resolve(root, design.tokens));
    }
    return found;
  } catch {
    return [];
  }
}

function readProjectTokens(root: string) {
  const candidates = [
    ...configuredTokenPaths(root),
    path.join(root, "tokens.json"),
    path.join(root, "packages", "design-system", "tokens.json"),
    path.join(root, "template", "packages", "design-system", "tokens.json"),
  ];
  const tokenFile = candidates.find((file) => fs.existsSync(file));
  if (!tokenFile) return undefined;
  try {
    return parseTokens(JSON.parse(fs.readFileSync(tokenFile, "utf8")));
  } catch {
    return undefined;
  }
}

function searchDirs(root: string, studioRoot: string): string[] {
  const workspaceChildren = ["apps", "packages"].flatMap((group) => {
    const dir = path.join(root, group);
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(dir, entry.name));
    } catch {
      return [];
    }
  });
  const repoRoot = path.resolve(studioRoot, "..", "..");
  return [...new Set([root, ...workspaceChildren, studioRoot, repoRoot])];
}

function esmEntryFromExports(exp: unknown): string | undefined {
  if (typeof exp === "string") return exp;
  if (!exp || typeof exp !== "object") return undefined;
  const record = exp as Record<string, unknown>;
  if ("." in record) return esmEntryFromExports(record["."]);
  for (const key of ["import", "node", "default"]) {
    if (key in record) {
      const found = esmEntryFromExports(record[key]);
      if (found) return found;
    }
  }
  return undefined;
}

function resolvePackageFromDir(dir: string, specifier: string): string | undefined {
  const pkgJson = path.join(dir, "package.json");
  if (fs.existsSync(pkgJson)) {
    try {
      return createRequire(pkgJson).resolve(specifier);
    } catch {
      // Fall through to ESM entry inspection for packages without a require export condition.
    }
  }
  const depDir = path.join(dir, "node_modules", ...specifier.split("/"));
  const depPkgFile = path.join(depDir, "package.json");
  if (!fs.existsSync(depPkgFile)) return undefined;
  try {
    const depPkg = JSON.parse(fs.readFileSync(depPkgFile, "utf8")) as Record<string, unknown>;
    const entry = esmEntryFromExports(depPkg.exports)
      ?? (typeof depPkg.module === "string" ? depPkg.module : undefined)
      ?? (typeof depPkg.main === "string" ? depPkg.main : undefined)
      ?? "index.js";
    const resolved = path.resolve(depDir, entry);
    return fs.existsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
}

async function loadFromDirs(dirs: string[], specifier: string): Promise<unknown> {
  for (const dir of dirs) {
    const resolved = resolvePackageFromDir(dir, specifier);
    if (!resolved) continue;
    try {
      return await import(pathToFileURL(resolved).href);
    } catch {
      continue;
    }
  }
  return undefined;
}

function extractCreateServer(mod: unknown): CreateViteServer | undefined {
  if (mod && typeof mod === "object" && "createServer" in mod) {
    const fn = (mod as { createServer: unknown }).createServer;
    if (typeof fn === "function") return fn as CreateViteServer;
  }
  return undefined;
}

function extractPluginFactory(mod: unknown): PluginFactory | undefined {
  if (typeof mod === "function") return mod as PluginFactory;
  if (mod && typeof mod === "object" && "default" in mod) {
    const def = (mod as { default: unknown }).default;
    if (typeof def === "function") return def as PluginFactory;
    if (def && typeof def === "object" && "default" in def) {
      const inner = (def as { default: unknown }).default;
      if (typeof inner === "function") return inner as PluginFactory;
    }
  }
  return undefined;
}

function resolveDepBase(dirs: string[], dep: string): string | undefined {
  return dirs.find((dir) => fs.existsSync(path.join(dir, "node_modules", dep)));
}

function loadThemeCss(root: string, dirs: string[], useTailwind: boolean): string {
  const tokens = readProjectTokens(root);
  if (!useTailwind) {
    return tokens ? `${tokensCss(tokens)}\n` : "";
  }
  const sources = ["src", "packages", "apps"]
    .filter((dir) => fs.existsSync(path.join(root, dir)))
    .map((dir) => `@source "${path.join(root, dir).replaceAll("\\", "/")}";`)
    .join("\n");
  const twBase = resolveDepBase(dirs, "tailwindcss");
  const twImport = twBase
    ? `@import "${path.join(twBase, "node_modules", "tailwindcss", "index.css").replaceAll("\\", "/")}";`
    : '@import "tailwindcss";';
  if (!tokens) return `${twImport}\n${sources}\n`;
  const body = themeCss(tokens)
    .replace('@import "tailwindcss";', twImport)
    .replace('@import "./tokens.css";', sources);
  return `${body}\n${tokensCss(tokens)}\n`;
}

function previewHtml(root: string, reqUrl: string): string {
  const theme = new URL(reqUrl, "http://127.0.0.1").searchParams.get("theme");
  const htmlClass = theme === "dark" || theme === "light" ? ` class="${theme}"` : "";
  const tokens = readProjectTokens(root);
  const inlineCss = tokens ? `${tokensCss(tokens)}html,body{background:var(--background);color:var(--foreground);}` : "";
  return [
    "<!doctype html>",
    `<html lang="en"${htmlClass}>`,
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    "  <title>Studio Preview</title>",
    ...(inlineCss ? [`  <style>${inlineCss}</style>`] : []),
    "</head>",
    '<body class="min-h-screen bg-background text-foreground antialiased">',
    '  <div id="root"></div>',
    `  <script type="module" src="${VIRTUAL_ENTRY}"></script>`,
    "</body>",
    "</html>",
  ].join("\n");
}

function previewEntryCode(): string {
  return `
import React, { Component, useEffect, useState } from "react";
import * as ReactDomClient from "react-dom/client";
import "${VIRTUAL_THEME}";

const mountRoot = ReactDomClient.createRoot || ReactDomClient.default?.createRoot;

const SKIP_NAMES = new Set(["PreviewApp", "PreviewBoundary", "Fragment", "Suspense", "StrictMode", "Provider", "Consumer"]);

function fiberComponentName(el, known) {
  let cur = el;
  while (cur && cur !== document.body) {
    const tagged = cur.getAttribute && cur.getAttribute("data-vs-component");
    if (tagged) return { name: tagged, el: cur };
    const fiberKey = Object.keys(cur).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (fiberKey) {
      let fiber = cur[fiberKey];
      let firstNamed = null;
      while (fiber) {
        const t = fiber.type;
        const name = typeof t === "function" ? (t.displayName || t.name) : (t && typeof t === "object" ? (t.displayName || t.render?.displayName || t.render?.name) : null);
        if (name && /^[A-Z]/.test(name) && !SKIP_NAMES.has(name)) {
          if (known && known.size > 0 && known.has(name)) return { name, el: cur };
          if (!firstNamed) firstNamed = name;
        }
        fiber = fiber.return;
      }
      if (firstNamed) return { name: firstNamed, el: cur };
    }
    cur = cur.parentElement;
  }
  return null;
}

class PreviewBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  componentDidUpdate(prevProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return React.createElement("div", { className: "m-4 rounded-md border border-destructive bg-card p-4 text-sm text-destructive" }, this.state.error);
    }
    return this.props.children;
  }
}

function bindArgs(raw, propNames) {
  const out = {};
  const src = raw && typeof raw === "object" ? raw : {};
  for (const [k, v] of Object.entries(src)) {
    if (v === "__fn__" || (typeof k === "string" && /^on[A-Z]/.test(k) && typeof v !== "function")) {
      out[k] = (...a) => window.parent.postMessage({ type: "studio:action", prop: k, args: a }, "*");
    } else {
      out[k] = v;
    }
  }
  for (const name of propNames || []) {
    if (/^on[A-Z]/.test(name) && typeof out[name] !== "function") {
      out[name] = (...a) => window.parent.postMessage({ type: "studio:action", prop: name, args: a }, "*");
    }
  }
  return out;
}

function PreviewApp() {
  const params = new URLSearchParams(window.location.search);
  const [spec, setSpec] = useState(() => ({
    file: params.get("file") || "",
    name: params.get("name") || "",
    args: {},
    props: [],
    children: [],
    inspect: params.get("inspect") === "1",
    theme: params.get("theme") || "system",
  }));
  const [loaded, setLoaded] = useState({ key: "", Comp: null, metaArgs: {}, error: null });
  const [hoverBox, setHoverBox] = useState(null);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("dark", "light");
    if (spec.theme === "dark" || spec.theme === "light") root.classList.add(spec.theme);
  }, [spec.theme]);

  useEffect(() => {
    const onMsg = (ev) => {
      const data = ev.data;
      if (!data || typeof data !== "object" || data.type !== "studio:preview") return;
      setSpec((prev) => ({
        file: typeof data.file === "string" ? data.file : prev.file,
        name: typeof data.name === "string" ? data.name : prev.name,
        args: data.args && typeof data.args === "object" ? data.args : prev.args,
        props: Array.isArray(data.props) ? data.props : prev.props,
        children: Array.isArray(data.children) ? data.children : prev.children,
        inspect: typeof data.inspect === "boolean" ? data.inspect : prev.inspect,
        theme: typeof data.theme === "string" ? data.theme : prev.theme,
      }));
    };
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "studio:ready" }, "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);

  useEffect(() => {
    if (!spec.file || !spec.name) return;
    let cancelled = false;
    const key = spec.file + "#" + spec.name;
    const clean = spec.file.replace(/^\\/+/, "");
    Promise.all([
      import(/* @vite-ignore */ "/" + clean),
      fetch("/@studio-preview/meta?file=" + encodeURIComponent(clean))
        .then((r) => (r.ok ? r.json() : { metaFile: null }))
        .then((info) => (info && info.metaFile ? import(/* @vite-ignore */ "/" + info.metaFile).catch(() => null) : null))
        .catch(() => null),
    ]).then(([mod, metaMod]) => {
      if (cancelled) return;
      const Comp = mod[spec.name] || mod.default || null;
      const metaArgs = metaMod && metaMod.meta && metaMod.meta.args && typeof metaMod.meta.args === "object" ? metaMod.meta.args : {};
      setLoaded({ key, Comp, metaArgs, error: Comp ? null : "Export " + spec.name + " not found in " + spec.file });
    }).catch((err) => {
      if (cancelled) return;
      setLoaded({ key, Comp: null, metaArgs: {}, error: err instanceof Error ? err.message : String(err) });
    });
    return () => { cancelled = true; };
  }, [spec.file, spec.name]);

  useEffect(() => {
    if (!spec.inspect) {
      setHoverBox(null);
      return;
    }
    const known = new Set([...(spec.children || []), spec.name].filter(Boolean));
    const onMove = (ev) => {
      const hit = fiberComponentName(ev.target, known);
      if (!hit || !hit.el) { setHoverBox(null); return; }
      const rect = hit.el.getBoundingClientRect();
      setHoverBox({ name: hit.name, top: rect.top, left: rect.left, width: rect.width, height: rect.height });
    };
    const onClick = (ev) => {
      const hit = fiberComponentName(ev.target, known);
      ev.preventDefault();
      ev.stopPropagation();
      if (hit) window.parent.postMessage({ type: "studio:select", componentName: hit.name }, "*");
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("click", onClick, true);
    };
  }, [spec.inspect, spec.children, spec.name]);

  const Comp = loaded.Comp;
  const bound = { ...loaded.metaArgs, ...bindArgs(spec.args, spec.props) };
  return React.createElement(
    "div",
    { className: "relative min-h-screen p-6" },
    loaded.error
      ? React.createElement("div", { className: "rounded-md border border-destructive bg-card p-4 text-sm text-destructive" }, loaded.error)
      : Comp
        ? React.createElement(PreviewBoundary, { resetKey: loaded.key + JSON.stringify(spec.args) }, React.createElement(Comp, bound))
        : React.createElement("div", { className: "text-sm text-muted-foreground" }, "Waiting for component…"),
    hoverBox
      ? React.createElement(
          "div",
          {
            style: { position: "fixed", top: hoverBox.top, left: hoverBox.left, width: hoverBox.width, height: hoverBox.height, pointerEvents: "none", zIndex: 9999 },
            className: "rounded border-2 border-primary bg-primary/10",
          },
          React.createElement("span", { className: "absolute -top-6 left-0 rounded bg-primary px-1.5 py-0.5 text-xs font-medium text-primary-foreground" }, hoverBox.name),
        )
      : null,
  );
}

mountRoot(document.getElementById("root")).render(React.createElement(PreviewApp));
`;
}

function previewPlugin(root: string, dirs: string[], useTailwind: boolean): PreviewPlugin {
  const themeFile = path.join(root, "__studio_preview_theme.css");
  const entryId = `\0${VIRTUAL_ENTRY}`;
  return {
    name: "studio-embedded-preview",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathname = (req.url ?? "/").split("?")[0];
        if (pathname === "/@studio-preview/meta") {
          const file = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("file") ?? "";
          res.statusCode = 200;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.end(JSON.stringify({ metaFile: file ? siblingMetaFile(root, file) : null }));
          return;
        }
        if (pathname === "/" || pathname === "/index.html") {
          void server.transformIndexHtml(req.url ?? "/", previewHtml(root, req.url ?? "/")).then((html) => {
            res.statusCode = 200;
            res.setHeader("content-type", "text/html; charset=utf-8");
            res.end(html);
          }, next);
          return;
        }
        next();
      });
    },
    resolveId(id) {
      if (id === VIRTUAL_ENTRY) return entryId;
      if (id === VIRTUAL_THEME) return themeFile;
      if (id === "storybook/test") return VIRTUAL_SB_TEST;
      return undefined;
    },
    load(id) {
      if (id === entryId) return previewEntryCode();
      if (id === themeFile) return loadThemeCss(root, dirs, useTailwind);
      if (id === VIRTUAL_SB_TEST) return STORYBOOK_TEST_SHIM;
      return undefined;
    },
  };
}

function hookProcessExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.once("beforeExit", () => {
    for (const key of [...servers.keys()]) void closePreview(key);
  });
}

function reactAliases(root: string, dirs: string[]): Record<string, string> | undefined {
  if (fs.existsSync(path.join(root, "node_modules", "react"))) return undefined;
  const base = resolveDepBase(dirs, "react-dom");
  if (!base || !fs.existsSync(path.join(base, "node_modules", "react"))) return undefined;
  return {
    "react/jsx-dev-runtime": path.join(base, "node_modules", "react", "jsx-dev-runtime.js"),
    "react/jsx-runtime": path.join(base, "node_modules", "react", "jsx-runtime.js"),
    "react-dom/client": path.join(base, "node_modules", "react-dom", "client.js"),
    "react-dom": path.join(base, "node_modules", "react-dom"),
    react: path.join(base, "node_modules", "react"),
  };
}

async function startEmbeddedPreview(root: string, entry: PreviewEntry): Promise<PreviewInfo> {
  const studioRoot = path.resolve(import.meta.dirname, "..");
  const dirs = searchDirs(root, studioRoot);
  const [viteMod, reactMod, tailwindMod, vibelangMod] = await Promise.all([
    loadFromDirs(dirs, "vite"),
    loadFromDirs(dirs, "@vitejs/plugin-react"),
    loadFromDirs(dirs, "@tailwindcss/vite"),
    loadFromDirs(dirs, "vibelang-vite"),
  ]);
  const createViteServer = extractCreateServer(viteMod);
  const reactPlugin = extractPluginFactory(reactMod);
  if (!createViteServer || !reactPlugin) {
    servers.delete(root);
    return { url: null, mode: "none" };
  }
  const tailwindPlugin = extractPluginFactory(tailwindMod);
  const vibelangPlugin = extractPluginFactory(vibelangMod);
  const plugins: unknown[] = [previewPlugin(root, dirs, Boolean(tailwindPlugin))];
  if (vibelangPlugin) plugins.push(vibelangPlugin());
  plugins.push(reactPlugin());
  if (tailwindPlugin) plugins.push(tailwindPlugin());

  const alias = reactAliases(root, dirs);
  const allow = [...new Set(dirs.filter((dir) => fs.existsSync(dir)))];
  try {
    const server = await createViteServer({
      root,
      configFile: false,
      cacheDir: path.join(os.tmpdir(), "vibestack-studio-preview", short(root)),
      logLevel: "silent",
      appType: "custom",
      plugins,
      resolve: { dedupe: ["react", "react-dom"], ...(alias ? { alias } : {}) },
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: false,
        hmr: false,
        fs: { allow },
      },
      optimizeDeps: {
        include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
      },
    });
    entry.server = server;
    await server.listen();
    const addr = server.httpServer?.address();
    if (!addr || typeof addr === "string") {
      await server.close();
      servers.delete(root);
      return { url: null, mode: "none" };
    }
    return { url: `http://127.0.0.1:${addr.port}/`, mode: "embedded" };
  } catch {
    if (entry.server) await entry.server.close().catch(() => undefined);
    servers.delete(root);
    return { url: null, mode: "none" };
  }
}

/** Lazily start an embedded Vite/React preview server for `root`, or return `{ url: null, mode: "none" }`. */
export function ensurePreview(root: string, components?: ComponentIndex): Promise<PreviewInfo> {
  if (!hasRunnableComponents(root, components)) return Promise.resolve({ url: null, mode: "none" });
  const existing = servers.get(root);
  if (existing) return existing.ready;
  hookProcessExit();
  const entry: PreviewEntry = { ready: Promise.resolve({ url: null, mode: "none" }) };
  entry.ready = startEmbeddedPreview(root, entry);
  servers.set(root, entry);
  return entry.ready;
}

/** Shut down the embedded preview Vite server for `root`, if one was started. */
export async function closePreview(root: string): Promise<void> {
  const entry = servers.get(root);
  if (!entry) return;
  servers.delete(root);
  await entry.ready.catch(() => undefined);
  if (entry.server) await entry.server.close().catch(() => undefined);
}
