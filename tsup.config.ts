import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    redis: "src/backends/redis.ts",
    tiktoken: "src/tiktoken.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  external: ["@dqbd/tiktoken"], // optional peer dep — don't bundle it
});
