// Hardhat config for the mainnet-fork rehearsal (scripts/fork-rehearsal.mjs). Not used by `npm test`.
// The fork reads Robinhood Chain mainnet through the local DoH proxy (scripts/fork-proxy.mjs); all writes stay local.
//   ELYRA_FORK_URL    default http://127.0.0.1:8599 (the proxy)
//   ELYRA_FORK_BLOCK  pinned block number (set by the rehearsal runner: latest - 5)
// Hardhat has no hardfork history for Robinhood Chain (Arbitrum Orbit), so it refuses to execute anything *at* the
// fork block itself ("No known hardfork for execution on historical block"). The runner therefore mines one local
// block right after start; everything executes on blocks above the fork block with the configured hardfork.
const forking = { url: process.env.ELYRA_FORK_URL || "http://127.0.0.1:8599" };
if (process.env.ELYRA_FORK_BLOCK) forking.blockNumber = Number(process.env.ELYRA_FORK_BLOCK);

module.exports = {
  solidity: { version: "0.8.26", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" } },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./hh-artifacts" },
  networks: { hardhat: { chainId: 4663, forking, hardfork: "cancun" } },
};
