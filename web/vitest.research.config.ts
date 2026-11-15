import { defineConfig } from "vitest/config";
// Offline research evaluations. They read data that is not in this
// repository, so they are kept out of `npm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/research/**/*.eval.ts"],
    fileParallelism: false,
  },
});
