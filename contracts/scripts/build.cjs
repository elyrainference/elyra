// Compiles ElyraEscrow.sol + ElyraRegistry.sol + MockUSDG.sol with solc-js; writes artifacts/{ElyraEscrow,ElyraRegistry,MockUSDG}.json
// ({abi, bytecode, compiler}) and artifacts/standard-input.json (one input with ALL sources, for explorer verification).
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.join(__dirname, "..");
const files = ["ElyraEscrow.sol", "ElyraRegistry.sol", "MockUSDG.sol"];
const input = {
  language: "Solidity",
  sources: Object.fromEntries(files.map((f) => [f, { content: fs.readFileSync(path.join(root, "contracts", f), "utf8").replace(/\r\n/g, "\n") }])),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errs = (out.errors || []).filter((e) => e.severity === "error");
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errs.length) process.exit(1);
const compiler = "solc " + solc.version().split("+")[0];
fs.mkdirSync(path.join(root, "artifacts"), { recursive: true });
for (const [file, name] of [["ElyraEscrow.sol", "ElyraEscrow"], ["ElyraRegistry.sol", "ElyraRegistry"], ["MockUSDG.sol", "MockUSDG"]]) {
  const c = out.contracts[file][name];
  fs.writeFileSync(
    path.join(root, "artifacts", name + ".json"),
    JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, compiler }, null, 2) + "\n"
  );
}
// exact inputs for explorer verification (Blockscout "standard-input" flow): node verify.mjs --contract …
const si = JSON.parse(JSON.stringify(input));
si.settings.outputSelection = { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode", "metadata"] } };
fs.writeFileSync(path.join(root, "artifacts", "standard-input.json"), JSON.stringify({ compilerVersion: "v" + solc.version().replace(/\.Emscripten.*$/, ""), input: si }, null, 2) + "\n");
console.log("wrote artifacts/ElyraEscrow.json, ElyraRegistry.json, MockUSDG.json, standard-input.json", solc.version());
