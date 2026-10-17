import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import { lingui, linguiTransformerBabelPreset } from "@lingui/vite-plugin";
export default defineConfig({
  plugins: [
    react(),
    lingui(),
    babel({ presets: [reactCompilerPreset(), linguiTransformerBabelPreset()] }),
  ],
  server: {
    port: 5174,
    proxy: {
      "/api": "http://127.0.0.1:19100",
      "/ws": { target: "ws://127.0.0.1:19100", ws: true },
    },
  },
  build: {
    outDir: "dist/web",
    sourcemap: true,
    target: "baseline-widely-available",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
