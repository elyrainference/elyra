// Dev-only. node tools/wallet/build.mjs  ->  panel/vendor/wallet.js (+ .sha256 and a list of the hosts the bundle can contact)
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)), out = join(here, "..", "..", "panel", "vendor");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "src", "entry.js")], outfile: join(out, "wallet.js"),
  bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "none", sourcemap: false, logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"', global: "globalThis" },
  banner: { js: "/* Elyra wallet bundle: @reown/appkit + ethers, built by tools/wallet/build.mjs. Do not edit. */" },
});
const buf = readFileSync(join(out, "wallet.js"));
writeFileSync(join(out, "wallet.js.sha256"), createHash("sha256").update(buf).digest("hex") + "  wallet.js\n");
console.log(`wallet.js ${(statSync(join(out, "wallet.js")).size / 1e6).toFixed(2)} MB`);
