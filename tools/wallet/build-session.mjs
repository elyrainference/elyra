// Dev-only. node tools/wallet/build-session.mjs  ->  panel/try/session.js (+ .sha256): the session-key module of the public page (ethers only).
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)), out = join(here, "..", "..", "panel", "try");
await build({
  entryPoints: [join(here, "src", "session.js")], outfile: join(out, "session.js"),
  bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "none", sourcemap: false, logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  banner: { js: "/* Elyra session-key module: ethers, built by tools/wallet/build-session.mjs. Do not edit. */" },
});
const buf = readFileSync(join(out, "session.js"));
writeFileSync(join(out, "session.js.sha256"), createHash("sha256").update(buf).digest("hex") + "  session.js\n");
console.log(`session.js ${(statSync(join(out, "session.js")).size / 1e3).toFixed(0)} KB`);
