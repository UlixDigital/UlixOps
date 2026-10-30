import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/vault-setup.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // Workspace packages are bundled in; npm dependencies stay external.
  noExternal: [/^@ulixops\//],
});
