import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { serverPlugins } from "../src/plugins/catalog.server.ts";
import { manifestUrl } from "../src/plugins/manifest.ts";

const destination = new URL("../dist/manifests/", import.meta.url);
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
for (const plugin of serverPlugins)
  copyFileSync(
    manifestUrl(plugin.id),
    new URL(`${plugin.id}.toml`, destination),
  );
