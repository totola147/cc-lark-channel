import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  external: [
    "@larksuiteoapi/node-sdk",
    "pino",
    "pino-pretty",
    "ws",
  ],
});
