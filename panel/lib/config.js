// Where the panel talks to. Owns: the API base and static asset URLs. Must not: do I/O beyond reading/writing the ?api= override.
export const API = (() => {
  const q = new URLSearchParams(location.search).get("api");
  if (q) localStorage.setItem("vpr-api", q.replace(/\/$/, ""));
  return localStorage.getItem("vpr-api") || ""; // the VPR serves this page, so it talks to itself (any port); ?api=… overrides
})();
export const ENDPOINT = (API || location.origin) + "/v1";
/** true when the panel is opened through a public hostname (remote access): tools cannot use that address, it needs a login */
export const IS_REMOTE = !API && !/^(localhost|127(\.\d+){3}|\[::1\])$/.test(location.hostname);
/** the address to give to OpenAI-compatible tools: always the node's own loopback address, on the machine that runs it */
export const toolUrl = (port) => (IS_REMOTE ? `http://localhost:${port || 8545}/v1` : ENDPOINT);
export const LOGO = "/app/assets/logos/";
export const MARK_WHITE = "/app/assets/elyra-mark-white.svg";
