import { existsSync, readdirSync, readFileSync } from "node:fs"
import { relative, sep } from "node:path"
import js from "@eslint/js"
import react from "@eslint-react/eslint-plugin"
import tailwind from "eslint-plugin-better-tailwindcss"
import boundaries from "eslint-plugin-boundaries"
import reactHooks from "eslint-plugin-react-hooks"
import { defineConfig, globalIgnores } from "eslint/config"
import tseslint from "typescript-eslint"
import vibelang from "vibelang/eslint"
import { designSystem } from "./vibestack/design/eslint.ts"
import { parseTokens } from "./vibestack/design/tokens.ts"

const stack = 'AGENTS.md, "The stack"'
const monorepo = 'CONTRIBUTING.md, "The monorepo"'
const banned = ["redux", "react-redux", "zustand", "mobx", "jotai", "recoil", "valtio", "xstate", "vue", "svelte", "jest"]
const scopes = ["reduxjs", "angular", "xstate", "vue", "sveltejs", "jest"]
const exported = ["apps", "packages"].flatMap((parent) =>
  existsSync(parent)
    ? readdirSync(parent).filter((dir) => existsSync(`${parent}/${dir}/package.json`)).flatMap((dir) => {
        const { name, exports = {} } = JSON.parse(readFileSync(`${parent}/${dir}/package.json`, "utf8"))
        return Object.keys(exports)
          .filter((key) => key !== ".")
          .map((key) => `${name}/${key.slice(2)}`.split("*").map((part) => RegExp.escape(part)).join("[^/]+"))
      })
    : [],
)
const imports = {
  patterns: [
    { regex: `^(?:@(?:${scopes.join("|")})/|(?:${banned.join("|")})(?:[/-]|$))`, message: `Not part of the stack: ${stack}.` },
    { regex: `^(?!(?:${exported.join("|")})$)@repo/[^/]+/`, message: `Import a workspace package by a path its "exports" names: ${monorepo}.` },
  ],
}
const noReact = { patterns: [...imports.patterns, { regex: "^react(?:-dom)?(?:/|$)", message: `Tool and domain code does not import React: ${monorepo}.` }] }
const untyped = ["*.{js,ts}", "**/alchemy.run.ts", "**/vitest.config.ts", "**/deploy/**", "**/.storybook/**", "packages/design-system/**", "vibestack/design/test/**", "vibestack/stories/test/**"]
const tsx = ["packages/ui/**/*.{ts,tsx}", "apps/**/*.{ts,tsx}", "vibestack/studio/src/page/**/*.{ts,tsx}"]
const design = "packages/design-system"
const writing = 'AGENTS.md, "Writing code"'
const citation = String.raw`spec\/\S+\.md, "[^"]+"`
const suppressible = String.raw`(?!code\/|no-console\b)[\w@/-]+`
const cited = new RegExp(String.raw`^\s*${citation}(?:; ${citation})*\s*$`)
const suppression = new RegExp(String.raw`^ eslint-disable(?:-next-line|-line)? ${suppressible}(?:, ${suppressible})* -- \S`)
const configs = [suppression, /^ eslint-enable\b/]
const throwsType = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`
const throwsDirective = new RegExp(String.raw`^\*(?:[\s*]*@throws \{[ \t]*${throwsType}(?:[ \t]*\|[ \t]*${throwsType})*[ \t]*\})+[\s*]*$`)
const directives = {
  Line: [cited, suppression, /^@ (?:backend|requires|ensures|invariant|decreases|assert|pure|type|ghost)(?: |$)/, /^\/ <reference /, /^ @vitest-environment [\w-]+$/],
  Block: [cited, ...configs, /^\*(?:[\s*]*@(?:model|design) \S+)+[\s*]*$/, throwsDirective],
  Shebang: [/^/],
}
const inline = /^\s*(?:eslint(?:-[a-z]+)*|exported|globals?)(?:\s|$)/
const guarded = (parser) => ({
  meta: { name: `${parser.meta.name} with code/inline`, version: parser.meta.version },
  parseForESLint: (text, options) => {
    const parsed = parser.parseForESLint(text, options)
    const loose = parsed.ast.comments.find((comment) => inline.test(comment.value) && !configs.some((form) => form.test(comment.value)))
    if (loose) throw Object.assign(new SyntaxError(`Inline config here is only "eslint-disable[-next-line|-line] <rule>, … -- <reason>", never for code/* or no-console, and "eslint-enable" (${writing}).`), { lineNumber: loose.loc.start.line, column: loose.loc.start.column + 1 })
    return parsed
  },
})
const within = (node) => Boolean(node) && (/Function/.test(node.type) || within(node.parent))
const documented = (context, comment) => context.options[0]?.jsdoc && comment.type === "Block" && comment.value.startsWith("*") && !within(context.sourceCode.getNodeByRangeIndex(comment.range[0]))
const left = { type: "object", additionalProperties: { type: "integer", minimum: 1 } }
const excess = (context, node, found, kind) => {
  const rel = relative(context.cwd, context.filename).split(sep).join("/")
  const limits = context.options[0]?.left
  const allowed = limits && Object.hasOwn(limits, rel) ? limits[rel] : 0
  if (found.length > allowed) found.forEach((problem) => context.report(problem))
  else if (allowed > 0 && found.length < allowed) context.report({ node, message: found.length ? `Stale ${kind} ratchet (${allowed}) for "${rel}": ${found.length} remain; lower it to ${found.length}.` : `Stale ${kind} ratchet (${allowed}) for "${rel}": 0 remain; remove it.` })
}
const comments = {
  meta: { type: "problem", schema: [{ type: "object", properties: { jsdoc: { type: "boolean" }, left }, additionalProperties: false }] },
  create: (context) => ({
    Program: (node) => excess(context, node, context.sourceCode.getAllComments()
      .filter((comment) => !directives[comment.type].some((directive) => directive.test(comment.value)) && !documented(context, comment))
      .map((comment) => ({ loc: comment.loc, message: `No code comments: only spec citations and tool directives (${writing}).` })), "commented"),
  }),
}
const uses = (names) => `:matches(Identifier[name=${names}]:not(ImportSpecifier[imported.name=${names}] > Identifier.local):not(ObjectExpression > Property[computed=false][shorthand=false] > Identifier.key), MemberExpression[computed=true] > Literal.property[value=${names}])`
const scheduling = {
  [uses(/^use(?:Layout|Insertion)?Effect$/)]: `No effect hooks: shared state lives in the spec-backed Machine (${writing}).`,
  [uses(/^(?:setTimeout|setInterval|setImmediate|queueMicrotask|requestAnimationFrame|requestIdleCallback)$/)]: `No timers: wait with Effect in VibeLang, or let the Machine say when (${writing}).`,
}
const effects = {
  meta: { type: "problem", schema: [{ type: "object", properties: { left }, additionalProperties: false }] },
  create: (context) => {
    const found = []
    return { ...Object.fromEntries(Object.entries(scheduling).map(([selector, message]) => [selector, (node) => found.push({ node, message })])), "Program:exit": (node) => excess(context, node, found, "scheduled") }
  },
}
const code = { rules: { comments, effects } }
const own = ["apps/**", "packages/**"]
const commented = {}
const scheduled = {}

const loose = Object.fromEntries(["no-explicit-any", "no-unsafe-argument", "no-unsafe-assignment", "no-unsafe-call", "no-unsafe-member-access", "no-unsafe-return"].map((rule) => [`@typescript-eslint/${rule}`, "off"]))

export default defineConfig(
  globalIgnores(["**/gen/", "!vibestack/gen/", "**/.vibe/", "**/dist/", "**/.cache/", "**/.spec-cache/", "**/.alchemy/", "**/.wrangler/", "**/generated/", "**/storybook-static/", "**/test/fixtures/", "vibestack/examples/", "vibestack/fixtures/", "vendor/", "docs/", ".claude/", ".lemmascript/", ".studio/", ".turbo/", "_apalache-out/"]),
  { linterOptions: { reportUnusedDisableDirectives: "error", reportUnusedInlineConfigs: "error" } },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    plugins: { boundaries },
    settings: {
      "boundaries/elements": [
        { type: "package", pattern: ["packages/*", "apps/*"], capture: ["name"] },
        { type: "studio", pattern: "vibestack/studio" },
        { type: "tool", pattern: "vibestack" },
      ],
    },
    rules: {
      "no-restricted-imports": ["error", imports],
      "boundaries/dependencies": ["error", {
        default: "disallow",
        policies: [
          { from: { element: { type: "package" } }, allow: { to: { element: { type: "package", captured: { name: "{{ from.element.captured.name }}" } } } } },
          { from: { element: { types: ["tool", "studio"] } }, allow: { to: { element: { types: ["tool", "studio"] } } } },
        ],
      }],
      "boundaries/no-unknown-dependencies": "error",
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "@typescript-eslint/no-unused-expressions": ["error", { allowShortCircuit: true, allowTernary: true }],
      "@typescript-eslint/no-floating-promises": ["error", { allowForKnownSafeCalls: [{ from: "package", package: "node:test", name: ["test", "describe", "it"] }] }],
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      "no-regex-spaces": "off",
      "no-warning-comments": ["error", { terms: ["todo", "fixme", "legacy", "deprecated"], location: "anywhere" }],
    },
  },
  { files: untyped, extends: [tseslint.configs.disableTypeChecked] },
  { ignores: ["**/test/**", "vibestack/selftest.ts", "packages/pack-default/src/**"], rules: { "max-lines-per-function": ["error", { max: 250, skipBlankLines: true, skipComments: true }] } },
  {
    files: ["vibestack/**"],
    ignores: ["**/*.tsx"],
    rules: {
      ...loose,
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unsafe-enum-comparison": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/no-base-to-string": "off",
    },
  },
  { files: ["**/*.{vibe,vibex}"], extends: [tseslint.configs.disableTypeChecked], languageOptions: { parser: vibelang, parserOptions: { projectService: false } }, rules: { "no-undef": "off" } },
  {
    files: ["vibestack/**", "**/*.{schema,contract}.ts", "**/test/drivers/**", "**/*.vibe"],
    ignores: ["vibestack/studio/src/page/**"],
    rules: { "no-restricted-imports": ["error", noReact] },
  },
  {
    files: ["**/*.tsx"],
    extends: [react.configs["recommended-type-checked"], reactHooks.configs.flat.recommended],
    rules: Object.fromEntries(Object.keys(reactHooks.rules).filter((rule) => `@eslint-react/${rule}` in react.configs["recommended-type-checked"].rules).map((rule) => [`@eslint-react/${rule}`, "off"])),
  },
  {
    files: tsx,
    extends: [designSystem({ tailwind, tokens: parseTokens(JSON.parse(readFileSync(`${design}/tokens.json`, "utf8"))), entryPoint: `${import.meta.dirname}/${design}/generated/theme.css` })],
    settings: { "better-tailwindcss": { cwd: design } },
  },
  {
    files: tsx,
    ignores: ["packages/ui/**"],
    rules: {
      "no-restricted-globals": ["error", ...["alert", "confirm", "prompt"].map((name) => ({ name, message: "Use Dialog or Alert from @repo/ui." }))],
      "no-restricted-syntax": ["error", { selector: "JSXOpeningElement[name.name=/^(input|textarea)$/]", message: "Use Input, Textarea or Checkbox from @repo/ui." }],
    },
  },
  { files: own, ignores: ["**/*.{vibe,vibex}"], languageOptions: { parser: guarded(tseslint.parser) } },
  { files: ["{apps,packages}/**/*.{vibe,vibex}"], languageOptions: { parser: guarded(vibelang) } },
  { files: own, plugins: { code }, rules: { "no-console": "error", "code/comments": ["error", { left: commented }], "code/effects": ["error", { left: scheduled }] } },
  { files: ["packages/ui/src/components/**"], ignores: ["**/*.meta.tsx"], rules: { "code/comments": ["error", { jsdoc: true, left: commented }] } },
)
