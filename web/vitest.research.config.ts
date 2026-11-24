import { defineConfig } from "vitest/config";
// Offline research evaluations. They read data that is not in this
// repository, so they are kept out of `npm test`. SELDINGER_VITE_CACHE_DIR
// moves Vite's cache with the run's other writes, to an approved volume.
export default defineConfig({
  cacheDir: process.env.SELDINGER_VITE_CACHE_DIR || undefined,
  test: {
    environment: "node",
    include: ["src/research/**/*.eval.ts"],
    fileParallelism: false,
  },
});
