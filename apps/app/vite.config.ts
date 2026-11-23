import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import vibelang from "vibelang-vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vibelang(), react(), tailwindcss()],
  build: {
    outDir: "dist/web"
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/mcp": "http://127.0.0.1:8787",
      "/oauth": {
        target: "http://127.0.0.1:8787",
        bypass(req) {
          if (
            req.method === "GET" &&
            req.url?.startsWith("/oauth/authorize") &&
            req.headers.accept?.includes("text/html")
          ) {
            return "/index.html";
          }
          return undefined;
        }
      },
      "/.well-known": "http://127.0.0.1:8787",
      "/SKILL.md": "http://127.0.0.1:8787",
      "/skill.md": "http://127.0.0.1:8787",
      "/llms.txt": "http://127.0.0.1:8787",
      "/how-to-play.md": "http://127.0.0.1:8787"
    }
  }
});
