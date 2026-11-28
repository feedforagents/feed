import vibelang from "vibelang/knip"

export default {
  compilers: { vibe: vibelang, vibex: vibelang },
  "ignore": [
    "vibestack/examples/**",
    "**/test/fixtures/**",
    "vendor/**",
    "**/.alchemy/**",
    "**/.wrangler/**"
  ],
  "ignoreExportsUsedInFile": true,
  "ignoreIssues": {
    "vibestack/studio/src/server.vibe": ["exports"]
  },
  "workspaces": {
    ".": {
      "entry": [
        "alchemy.run.ts",
        "vibestack/alchemy.ts",
        "vibestack/design/cli.ts",
        "vibestack/stories/cli.ts",
        "vibestack/remote-cache.ts",
        "vibestack/chromium.ts",
        "vibestack/*/test/*.test.ts",
        "vibestack/testing/test/fixture/*/src/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "alchemy.run.ts",
        "vibestack/**/*.{ts,tsx,vibe,vibex}",
        "!vibestack/studio/**"
      ],
      "ignoreDependencies": [
        "lemmascript",
        "@vitest/browser",
        "@repo/design-system",
        "@cloudflare/workers-types",
        "@alchemy.run/test",
        "wrangler"
      ]
    },
    "packages/cli": {
      "entry": [
        "src/index.ts",
        "src/main.ts",
        "test/**/*.test.ts"
      ],
      "project": [
        "src/**/*.ts",
        "test/**/*.ts"
      ]
    },
    "packages/ui": {
      "entry": [
        "src/**/*.{meta,stories}.tsx"
      ],
      "project": [
        "**/*.{ts,tsx,vibe,vibex,css}"
      ],
      "ignoreDependencies": [
        "tailwindcss"
      ]
    },
    "packages/design-system": {
      "ignoreDependencies": [
        "eslint",
        "eslint-plugin-better-tailwindcss",
        "tailwindcss",
        "typescript-eslint"
      ]
    },
    "packages/*": {
      "entry": [
        "src/index.{ts,vibe}",
        "test/**/*.test.{ts,tsx,vibe}",
        "test/drivers/*.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,tsx,vibe,vibex}",
        "test/**/*.{ts,tsx,vibe,vibex}"
      ]
    },
    "vibestack/studio": {
      "entry": [
        "src/main.vibe",
        "src/project.ts",
        "src/doc.ts"
      ],
      "project": [
        "src/**/*.{ts,tsx,vibe,vibex,css}",
        "test/**/*.{ts,tsx,vibe,vibex}"
      ],
      "ignoreDependencies": [
        "tailwindcss"
      ]
    },
    "apps/*": {
      "entry": [
        "src/web/main.tsx",
        "src/server/main.vibe",
        "src/server/worker.vibe",
        "deploy/**/*.test.ts",
        "deploy/vitest.config.ts",
        "test/**/*.test.{ts,tsx,vibe}",
        "test/drivers/*.ts",
        "src/**/*.{schema,contract}.{ts,vibe}"
      ],
      "project": [
        "src/**/*.{ts,tsx,vibe,vibex,css}",
        "deploy/**/*.{ts,tsx}",
        "test/**/*.{ts,tsx,vibe,vibex}"
      ],
      "ignoreDependencies": [
        "tailwindcss"
      ]
    }
  }
}
