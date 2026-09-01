import { defineConfig } from "vitest/config";
import dts from "vite-plugin-dts";
import { resolve } from "path";
import { readFileSync } from "fs";

const pkg = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "package.json"), "utf-8"),
);

export default defineConfig({
  plugins: [
    dts({
      insertTypesEntry: true,
      rollupTypes: true,
    }),
  ],
  server: {
    port: 3000,
    open: true,
    watch: {
      ignored: ["**/node_modules/**", "**/build/**"],
    },
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  build: {
    outDir: "build",
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      name: "MaptalksTilerPlugin",
      formats: ["es"],
      fileName: () => `${pkg.name}.module.js`,
    },
    rollupOptions: {
      external: ["three"],
      output: {
        globals: {
          three: "THREE",
        },
      },
      treeshake: {
        moduleSideEffects: false,
        propertyReadSideEffects: false,
      },
    },
    sourcemap: true,
    minify: false,
  },
  test: {
    environment: "node",
  },
});
