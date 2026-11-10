// The single shared UI state. Owns: latest /api/status, current view, online flag, one-shot navigation hints, buy/sell role.
// Views read it; only lib/status.js and router.js write status/online/view.
export const S = {
  status: null,
  view: "overview",
  online: false,
  tabs: {}, // remembered tab per view (components/tabs.js)
  pre: {}, // hints for the next view (e.g. { model } when jumping to the playground)
  role: localStorage.getItem("elyra-role") === "sell" ? "sell" : "buy",
};
