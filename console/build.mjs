import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist/web", { recursive: true });

// Server: bundle to a single file, run with plain node.
await build({
  entryPoints: ["src/server.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: "dist/server.cjs",
});

// Web UI: bundle React to static assets with content-hash filename.
await build({
  entryPoints: ["src/web/main.tsx"],
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  minify: true,
  outfile: "dist/web/app.js",
  loader: { ".css": "css" },
  define: { "process.env.NODE_ENV": '"production"' },
});

// Copy app.js to a content-hashed name and rewrite index.html to use it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
const appJs = readFileSync("dist/web/app.js");
const hash = createHash("sha256").update(appJs).digest("hex").slice(0, 8);
copyFileSync("dist/web/app.js", `dist/web/app.${hash}.js`);
const html = readFileSync("public/index.html", "utf8");
writeFileSync("dist/web/index.html", html.replace("app.js", `app.${hash}.js`));
writeFileSync("dist/web/app-hash", hash);

await build({
  entryPoints: ["src/web/styles.css"],
  bundle: true,
  outfile: "dist/web/styles.css",
});

console.log("built dist/server.cjs, dist/web/app.js, dist/web/styles.css");
