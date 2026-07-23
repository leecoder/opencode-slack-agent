import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/plugin.ts", "src/socket-worker.mjs"],
    format: ["esm"],
    dts: false,
    clean: true,
    external: [
      "child_process",
      "fs",
      "path",
      "url",
      "https",
    ],
  },
]);
