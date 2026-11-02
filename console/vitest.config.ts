import { defineConfig } from "vitest/config";
import { lingui } from "@lingui/vite-plugin";
export default defineConfig({
  plugins: [lingui({ macroTransform: true })],
  test: {
    setupFiles: ["tests/i18n-setup.ts"],
    include: [
      "tests/**/*.test.{ts,tsx}",
      "../plugins/*/console/tests/**/*.test.{ts,tsx}",
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "src/config.ts",
        "src/store.ts",
        "src/history-db.ts",
        "src/archipel-wire.ts",
        "src/domain.ts",
        "src/archipel.ts",
        "src/app.ts",
        "src/plugins/runtime.ts",
        "src/plugins/manifest.ts",
        "../plugins/runners/console/src/domain.ts",
        "../plugins/runners/console/src/server.ts",
        "../plugins/fan-control/console/src/domain.ts",
        "../plugins/fan-control/console/src/server.ts",
      ],
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
  },
});
