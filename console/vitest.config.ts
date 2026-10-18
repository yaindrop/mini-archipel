import { defineConfig } from "vitest/config";
import { lingui } from "@lingui/vite-plugin";
export default defineConfig({
  plugins: [lingui({ macroTransform: true })],
  test: {
    setupFiles: ["tests/i18n-setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "src/config.ts",
        "src/store.ts",
        "src/history-db.ts",
        "src/fleet-wire.ts",
        "src/domain.ts",
        "src/fleet.ts",
        "src/app.ts",
        "src/plugins/runtime.ts",
        "src/plugins/runners/domain.ts",
        "src/plugins/runners/server.ts",
        "src/plugins/fan-control/domain.ts",
        "src/plugins/fan-control/server.ts",
      ],
      thresholds: { statements: 80, branches: 75, functions: 80, lines: 80 },
    },
  },
});
