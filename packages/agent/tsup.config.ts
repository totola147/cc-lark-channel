import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
  external: [
    "@larksuiteoapi/node-sdk",
    "@anthropic-ai/claude-agent-sdk",
    "pino",
    "pino-pretty",
    "ws",
  ],
});
