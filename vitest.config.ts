import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scratch/**/*.test.ts", "ui/**/*.test.js"],
    // Probes (scratch/0N-*.ts) are runnable scripts, not unit tests — exclude them.
    exclude: ["**/node_modules/**", "scratch/0*-*.ts"],
  },
});
