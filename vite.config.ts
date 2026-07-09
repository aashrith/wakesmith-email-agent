import { builtinModules } from "node:module";
import { defineConfig } from "vite";

/**
 * Not a bundler we ship — a build-hygiene gate. `tsc --noEmit` checks
 * types; this checks that the same source actually resolves and bundles
 * as a graph (catches circular-import or path issues tsc alone can miss).
 * Runtime keeps using tsx directly (see README trade-offs); dist/ is a
 * CI-style artifact, not how the container runs today.
 */
const runtimeDeps = [
  "@elysiajs/node",
  "@sinclair/typebox",
  "elysia",
  "js-yaml",
  "mailparser",
  "nodemailer",
  "imapflow",
  "uuid",
];

export default defineConfig({
  build: {
    target: "node20",
    ssr: true,
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        server: "src/api/server.ts",
        poller: "src/adapters/inbound/poller.ts",
        cli: "src/adapters/inbound/cli.ts",
      },
      output: {
        format: "esm",
        entryFileNames: "[name].js",
      },
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), ...runtimeDeps],
    },
  },
});
