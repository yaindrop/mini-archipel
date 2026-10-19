import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadConfig, saveConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { serverPlugins } from "./plugins/catalog.server.ts";
async function main() {
  const configPath = process.argv[2] ?? "console.json";
  const config = loadConfig(configPath);
  mkdirSync(dirname(config.dbPath), { recursive: true });
  const here = dirname(process.argv[1] ?? process.cwd());
  const { app } = createApp(config, {
    plugins: serverPlugins,
    persistConfig: (updated) => {
      saveConfig(configPath, updated);
    },
    webDir: process.env.ARCHIPEL_WEB_DIR ?? join(here, "web"),
  });
  const [host, port] = config.bind.split(":");
  await app.listen({ host: host ?? "127.0.0.1", port: Number(port) });
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      void app.close();
    });
  console.log(`mini-archipel console 0.12.0 listening on ${config.bind}`);
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "console startup failed",
  );
  process.exitCode = 1;
});
