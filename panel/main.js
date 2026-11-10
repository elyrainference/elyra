// Elyra Router control panel. Talks to the local VPR daemon only (same origin, or ?api=… override).
// Boot: nav -> menus + shortcuts -> initial view from the hash -> start polling. The panel runs without a build step: native ES modules only.
// Layering (imports only point downwards): main -> router/actions/palette/menus -> views -> components -> lib.
import { installActions } from "./actions.js";
import { initHelp } from "./components/pop.js";
import { initDrawer } from "./lib/drawer.js";
import { buildNav } from "./lib/nav.js";
import { onFirstConnect, poll } from "./lib/status.js";
import { S } from "./lib/store.js";
import { initMenus } from "./menus.js";
import { enterCurrent, showInitialView, tickCurrent, watchHash } from "./router.js";
import { initShortcuts } from "./shortcuts.js";

installActions();
buildNav();
initMenus();
initHelp();
initShortcuts();
initDrawer();
S.online = null;
onFirstConnect(enterCurrent);
setInterval(poll, 2000);
setInterval(tickCurrent, 3000);
showInitialView();
poll().then(() => { if (S.online === null) S.online = false; });
watchHash();
