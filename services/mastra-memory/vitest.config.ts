import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `build` emits to dist/. Without this, compiled copies of the suite are
    // collected alongside the TypeScript sources and every test runs twice.
    exclude: [...configDefaults.exclude, "dist/**"],
  },
});
