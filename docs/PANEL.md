# Control panel guide

The panel is a no-build web app (native ES modules) served by your own node at `http://localhost:8545/app/`. It talks only to that node's control API ([API](API.md)), which is loopback-only unless you opt in to [remote admin](REMOTE-ADMIN.md) (a login on one hostname).

**Public hosted app:** [app.elyrainference.com](https://app.elyrainference.com/) opens Market → Playground → Sell. Browsing requires no wallet. Free hosted chat follows that deployment's quota and optional wallet-sign-in/username gate; paid browser sessions are a separate, opt-in payment path. This is not your node's owner console ([Public app](#live-app-and-the-try-page)).

The panel is laid out like a SaaS console: a workspace header and collapsible groups in the sidebar, breadcrumbs and a search button in the top bar, an account menu top right ([App shell](#app-shell-search-shortcuts-and-menus)). The top bar shows the node status chip (`Online · :<port>`), the wallet balance chip and `Demo market · N simulated peers` while the simulated market is on. On phones the sidebar becomes a drawer opened from the menu button. If the node is not running an overlay says so and reconnects by itself (status is polled every 2 s).

## Views

The sidebar separates jobs: **This node** (Home & usage, Private Live), **Use AI** (Models & sellers, Playground, Routing), **Set up** (Sources & tools, Network), **Earn & pay** (Sell capacity, Payments). Home has three state-derived checklists: **Own model**, **Buy from peers**, **Sell capacity**. Own-model setup never requires a buyer escrow deposit; a hosted API source retains its upstream provider bill. Seller setup follows source → models/prices → reachability → settlement/gas → earnings. Payments, Network and Sell capacity retain their existing tabs and endpoints.

| # | View | What it is for |
|---|---|---|
| - | **Home & usage** | This node's endpoint, measured usage, health, recent activity, routing policy, quick actions and the Own model / Buy from peers / Sell capacity checklist |
| - | **Private Live** | Owner-only realtime metadata for this node, never global buyer activity ([Live view](#live-view)) |
| 01 | **Playground** | Chat through your own router. Pick `auto`, an `auto:*` shorthand or a model. Under each answer a collapsible **route footer** always shows `SIMULATED PEER` or `LIVE`, the privacy label (`CLEAR` / `TEE`) and the peer; open it for model, price, tokens, cost and latency. Next to it a **route preview** shows the top 6 candidates and why the others lost |
| 02 | **Models & sellers** | Every listing this router can reach (live peers, your own sources, simulated ones), with price, speed, reputation, privacy and source. `Try` opens Playground for that model; it does not pin a particular seller |
| 03 | **Routing** | The policy: four weights (price, speed, reputation, privacy), presets (Balanced, Cheapest, Fastest, Private, Top rated), "Require private peers" (`teeOnly`) and a max price. Live preview of the ranking as you change it |
| 04 | **Network** | Peer counts, topology graph, this node's identity (name, node id, wallet, peer URL, relay status), the demo-network switch, **add a peer by URL**, peers found through the on-chain registry (badge "from registry"), and the **TEE trust list** (image digests you accept) |
| 05 | **Payments** | Alerts, the **Fund this node** stepper (chain mode), wallet balance, spent/earned, the **Daily spend cap**, the receipt ledger, settlement batches. With an escrow configured: network settings, mint (mock token only), approve + deposit (or **Fund from your wallet**), the per-wallet deposit cap (`$20 USDG` default, shown next to every deposit), withdraw, vouchers both ways, explorer links |
| 06 | **Sell capacity** | Models & pricing / Reachability / Earnings. Connect your own compute, choose offers and default/per-model USDG prices, publish, check relay or peer URL, then inspect vouchers and payouts. Hosted API keys are for personal routing, not advertised for resale |
| 07 | **Sources & tools** | Endpoint snippets, detect/add Ollama, LM Studio or OpenAI-compatible sources (including hosted APIs for personal routing), plus node backup |

## App shell, search, shortcuts and menus

Code: `index.html`, `css/shell.css`, `lib/nav.js`, `menus.js`, `palette.js`, `shortcuts.js`, `components/pop.js`, `components/overlay.js`. Nothing here changes what the node does; it is navigation and chrome.

- **Node switcher (sidebar header).** The node's name, version and a **network chip** that says which money this node settles with: **MAINNET · REAL MONEY** (red, plus a thin red line across the top of every page), **TESTNET** (indigo; **LOCAL CHAIN** for a dev chain) or **SIMULATED** (purple: no escrow configured, nothing settles on-chain). It is derived from `/api/status` (`network.settlement`); only `robinhood-mainnet` is real money. On phones the chip also sits in the top bar. The menu copies the endpoint URL or node id and opens Network or Payments; there is exactly one node per panel, so it says "to manage another node, open that node's own panel" rather than pretending to switch.
- **Sidebar groups** (This node, Use AI, Set up, Earn & pay) fold with their header; the choice is remembered in `localStorage["elyra-nav-closed"]`, and the group of the page you are on never stays folded. The sidebar explicitly identifies the surface as the owner console for this node.
- **Breadcrumbs:** node name / group / page, plus the open tab on pages that have tabs (`node-a / Earn & pay / Payments / Ledger`). The browser tab title follows.
- **Command palette:** **Ctrl/Cmd+K** or **/** (or the Search button). Type to filter every view and every tab (`Payments · Escrow`), and four actions: **Send a test request** (opens the Playground with the cursor in the message box), **Copy endpoint URL**, **switch theme**, **switch density**; plus keyboard shortcuts, docs and GitHub. Arrows move, Enter runs, Escape closes; the page behind is `inert` while it is open.
- **Keyboard shortcuts:** `?` lists them; **g** then a letter jumps to a view (`g h` Home & usage, `g l` Private Live, `g c` Sources & tools, `g n` Network, `g p` Playground, `g m` Models & sellers, `g r` Routing, `g o` Sell capacity, `g y` Payments). They are ignored while you type in a field.
- **Account menu (top right):** who is signed in, theme, density, shortcuts, documentation, GitHub and **Sign out**. On localhost it says **Local owner** (the control API is loopback-only; nothing is asked). Behind a remote-admin hostname it reads `GET /auth/session` once: a wallet session shows the username or the short address and the role, a token session says "Admin session"; **Sign out** posts the same `/admin/logout` form as before.
- **Toasts** have a dismiss button and, where a change is easy to reverse, **Undo** (8 s): hiding the simulated market (Home) and removing a peer (Network → Peers). Undo makes the opposite API call (`demoNetwork: true`, re-adding the peer's URL); it is not a rollback of node state.
- **Density:** comfortable (default) or compact (account menu or palette), stored in `localStorage["elyra-density"]` and applied before first paint like the theme.
- **Inline help:** a `?` button next to a setting (default price, credit limit, deposit cap, privacy claim, routing weights, daily spend cap, TEE trust list, Home health) opens a short plain-language popover. Escape closes it.
- **Tabs inside pages:** **Sell capacity** = Models & pricing / Reachability / Earnings, **Payments** = Fund / Ledger / Escrow, **Network** = Topology / Peers / Trust. Internal view/tab IDs and remembered-tab behavior are unchanged. Contextual actions can carry `data-go` + `data-tab`: seller Earnings opens Earnings, settlement opens Escrow, receipt review opens Ledger. Forms are not rebuilt on the status poll.
- **Empty states** carry an illustration icon and one call to action; loaders are skeleton blocks of the final size; pages fade up on entry. All motion stops under `prefers-reduced-motion`.

## Home as a dashboard

Code: `views/overview.js`, `dash-usage.js`, `dash-health.js`, `dash-activity.js`, `overview-next.js`, `lib/usage.js`, `components/chart.js`, `css/dash.css`. Every number comes from an API the panel already used; **nothing is estimated**, and where the data cannot answer, the card says so.

- **KPI cards** (requests, tokens, spent, earned, last 24 hours): value, change against the previous 24 hours and a 14-day sparkline. Requests, tokens and earned compare the last two rolling-24-hour buckets of `/api/status` `stats.series` / `earnDaily`. The status API has no spend series, so **Spent** compares from `/api/routes` only when that log is complete (fewer than 60 routes: the API returns the newest 60); otherwise it says "no earlier data" and has no sparkline. A rise over 999% is shown as ">999%".
- **Usage chart** with **24h / 7d / 14d** and **Consumed / Served**. 24 h is built hour by hour from `/api/routes`; when the node has more than 60 routes in that window, older hours are not in the log and the chart says so instead of showing zeros as data. 7 d and 14 d come from the 14-day series. There is no 30-day view because the node keeps 14 days of daily buckets.
- **Health** (Model sources, Peers, Chain, Registry), each green (working), amber (needs attention), red (broken) or grey (not in use / still checking) with the reason: no real source connected, a source offline, no peers online, chain RPC unreachable, low gas, escrow not verified, registry set but unreachable. Derived from `/api/status`, `/api/upstreams`, `/api/peers` and the `/api/chain` snapshot (1.5 s limit, like the checklist).
- **Recent activity:** the newest rows of the Live feed (`/api/events/recent`, drawn by the same renderer as the Live view), topped up from the persisted route log for the time before the feed's first request (the feed only remembers what happened since the node started).
- **Quick actions**, the existing **alerts** and one-banner logic, **Active policy**, and the **Get started** checklist: it stays open while fewer than two steps are done (a new node), is collapsed to one line with the next step named once most of it is done, and always opens or closes as you choose (remembered in `localStorage["elyra-guide-open"]`).

## What the panel tells you to do next

- **Overview** shows one banner at the top of the page, derived from live state. With no real source: **"Connect a real model"** with `Detect Ollama` (opens Connect and runs detection) and `Add a source`. With a real source while the simulated market is still on: **"Your real model is connected"** with `Try it` and `Hide simulated market` (turns the demo network off). Otherwise no banner.
- **Sources & tools** marks a source **Offline** (with the reason on hover) after it fails two health checks in a row, and **Remote** when you told it the source is another machine. Offline sources are left out of routing until they answer again.
- **Sources & tools** confirms a source was added ("Ollama is ready", models, `Open playground`), explains detection failures, and links separately to Sell capacity: adding a personal source does not automatically publish an offer.
- **Playground** lists **Your models (live)** above the simulated market, says in the empty state who will answer, and while a reply is pending shows the elapsed seconds and, after 6 s, that a first request after idle can take a minute (a cold model load). Result badges read `LIVE` / `SIMULATED PEER`, the peer, model, price, `CLEAR`/`TEE`, tokens, cost and time (seconds above 1 s).
- A live source always wins over simulated peers for `auto` ([USAGE](USAGE.md#choosing-a-model-or-a-policy)), so the route preview shows only real options once you have one.

## Alerts, guided funding, spend cap and backup

All four are derived from live state (`/api/status`, and the `/api/chain` snapshot the view already loads); nothing is stored except the backup tick, and no extra backend polling was added. Code: `views/alerts.js`, `payments-steps.js`, `payments-cap.js`, `backup.js`.

- **Alerts** (top of Home and Payments, non-blocking, each with its one fix): **No ETH for gas** (chain mode, wallet below 0.0005 ETH; Payments: faucet link + copy address, Home: opens Payments at the stepper), **Escrow below $1** (spendable balance, buyers and anyone who has deposited or paid; **Add funds**), **You used N% of today's spend cap** (from 80%) and **Daily spend cap reached** (**Raise the cap**, which focuses the cap field). They disappear by themselves when the cause is gone. A button with `data-focus="<id>"` scrolls to and focuses that element (opening any fold around it); with `data-go` it carries the target to the next view as `S.pre.focus`.
- **Fund this node** (Payments, chain mode only; hidden in simulated mode, a note while the RPC is unreachable): 1 **Get gas (ETH)** (faucet link, copy the node address), 2 **Get USDG** (a **MOCK TEST TOKEN** badge and *Mint 100* on the testnet mock; otherwise copy the address, plus **Fund from your wallet** when wallet connect is enabled), 3 **Deposit into the escrow** (amount + *Approve + deposit*, enabled once there is gas and USDG). Each step is done or **Next** with its button; when all three are done the card collapses to a one-line "Funded" summary you can open. It is redrawn only when the facts it shows change and never while you type in it. The advanced escrow form below is unchanged.
- **Daily spend cap** (Payments): the control for `spendCapUsdDay` ([Configuration](CONFIGURATION.md)). A usage bar shows the last 24 hours against the cap; empty field = no cap. The form is drawn once per visit; only the bar refreshes on the poll.
- **Back up this node** (Connect): explains that identity and wallet live in the data directory and what losing it costs (the wallet and unredeemed earnings, reputation), shows the directory path and whether secrets are encrypted at rest (`ELYRA_PASSPHRASE`, a boolean from `/api/status`), a checklist (**passphrase set**, derived; **offline copy**, your own tick kept in this browser's `localStorage`: Elyra cannot see a copy), and **Download public facts** / **Copy as JSON**: node id, name, wallet address, network, escrow and version, built in the browser from `/api/status` and `/api/chain`. The file has no keys and no passphrase; **no API returns a private key or passphrase** and none must be added.

Verified at 390 px wide (all eight views, no element wider than the screen): one column, tables and code scroll inside their own box, the topology graph scrolls inside its box.

## Live view

The **Private Live** page (sidebar, This node) is the owner's window on this node, fed by `GET /api/events` ([API](API.md#live-feed-owner-only)). It is not global buyer activity. Only loopback or an admin session can open it, and it shows metadata only (never a prompt, an answer or a key). Code: `views/live.js`, `css/live.css`.

- **Presence card** (left; below the feed on narrow screens): peers online or offline with their round-trip time, **Serving you** (which peers answered you in the last 5 minutes, with request counts; simulated peers carry **SIM**), and **Buying from you** (buyers in the last 5 minutes as short wallet ids, or `peer abc123` when you sell without an escrow; says "You are not selling" with a link to Provide when providing is off).
- **Activity feed** (right): one row per event, newest on top, with a kind badge (**Buying**, **Selling**, **Peer**, **Money**, **Alert**), model and peer, tokens, cost, latency and a coloured status (green ok, amber refused with the reason such as *Spend cap* or *Not funded*, red failed or alert). Events from the demo market carry the **SIM** badge. At most 200 rows stay in the DOM; each event adds one row, the list is never re-rendered.
- **Controls:** filter pills (All, Buying, Selling, Peers, Money, Alerts; they only flip an attribute CSS reads), **Pause** (events keep arriving and are held; **Resume · N new** flushes them) and a connection chip (**Live**, **Connecting…**, **Reconnecting in 4s…** with a 1 s to 30 s backoff, resuming from the last event id so nothing is shown twice). The empty state reads "Nothing yet" with a button to the Playground.
- The stream is opened when you enter the page and closed when you leave it (`leave()` hook in `router.js`); the node allows 8 streams at once. All event text goes through `esc()`.

## Design system and theme

All colours, radii and fonts are CSS variables in `panel/css/base.css :root`; nothing else hard-codes a colour (the topology SVG is painted by classes in `network.css`).

| Token | Role |
|---|---|
| `--bg` `--surface` `--raised` `--input` | Page, card, raised/hover and field backgrounds (dark: `#0b0d12` / `#12151c` / `#181c26`) |
| `--border` `--border2` | 1 px hairline and stronger control borders |
| `--text` `--muted` `--faint` | Body, secondary and placeholder text (all AA on every surface in both themes) |
| `--accent` `--accent-text` `--accent-bg` `--accent-bd` `--grad` | Indigo/violet brand colour; the gradient is only for primary buttons, progress bars, chart bars and the logo mark |
| `--ok` `--warn` `--bad` `--sim` (+ `-bg`, `-bd`) | Semantic colours: success / caution / danger / **simulated** (purple). `SIM`, `DEMO` and `CLAIMED` badges keep their own colour so they never look verified |
| `--font` `--mono` | System UI stack; monospace only for addresses, URLs, hashes, code |
| `--r-card` `--r-ctl` `--side` `--top` | 12 px cards, 8 px controls, 232 px sidebar, 56 px top bar |

**Theme toggle.** Dark is the default. The account menu (or the palette) switches to the light theme (`[data-theme="light"]` overrides the colour tokens only) and stores the choice in `localStorage["elyra-theme"]`. With nothing stored the panel follows `prefers-color-scheme` and falls back to dark. `panel/theme-init.js` is a tiny classic script in `<head>` that sets the theme (and the density, `localStorage["elyra-density"]`) before first paint (no flash); `lib/theme.js` holds the toggles.

**Public pages share it.** The signed-out try/market page (`panel/try/`, [Live app and the try page](#live-app-and-the-try-page)) uses the same tokens, radii, system fonts, buttons, pills and dark/light theme (same `localStorage["elyra-theme"]` key, so one choice follows the visitor between the panel and the try page). The sign-in page (`router/http/login-page.mjs`) uses the same look, dark by default and light by OS preference (its CSP allows no script). `/app/*` is behind the admin login, so `panel/try/try.css` carries its own copy of the token block (colours, fonts, radii): when you change a token in `base.css`, change it there too. The theme script is `panel/try/theme.js` (classic script, CSP `script-src 'self'`). The old commercial typefaces are gone from `panel/`.

**Components.** Buttons: `.btn` (secondary), `.btn.primary`, `.btn.ghost`, `.btn.danger`, sizes `.sm` / `.lg`. Badges are pills (`.badge` + `tee` / `sim` / `live` / `warn` / `bad` / `count`). Forms use `components/form.js` (`field()` = label, control, helper text, inline error; `watchField()` = validation). Polled regions are written with `setHtml()` so a refresh never re-renders unchanged markup; forms are rendered once per visit and never on the 2 s poll. Motion respects `prefers-reduced-motion`.

## Typical flows

**Use your own model:** Home → Own model → Sources & tools → detect/add a source → Models & sellers → Try → Playground → expand the route footer → Home & usage. No buyer escrow deposit is needed for local inference; hosted API sources retain their own provider bill. See [OLLAMA](OLLAMA.md).

**Tune routing:** Routing → drag weights or choose a preset → watch the live preview → the new weights apply to every request sent to `auto`. A specific model name ignores the weights for model choice and just picks the best peer for that model.

**Buy privately:** Routing → tick "Require private peers". Requests with no private route **fail** instead of leaking. Private means your own machine/LAN or a **VERIFIED** TEE; a seller's own TEE claim shows as `CLAIMED` and does not count ([TEE](TEE.md)).

**Pay on-chain (testnet):** Payments → network `robinhood-testnet` + escrow address from [STATUS](STATUS.md) → Mint test USDG (mock only) → Deposit → route a request to a **live** paid peer → the receipt appears in the ledger. Simulated peers are never settled.

**Sell your own compute:** Sources & tools → connect Ollama / LM Studio / your OpenAI-compatible model server → test in Playground → Sell capacity → Models & pricing → select models and prices, enable and save → Reachability → inspect relay/peer URL → Payments → Escrow for settlement and redemption gas → Sell capacity → Earnings. Buyers fund their own escrow; sellers do not need a buyer deposit just to serve their own model. Publishing does not guarantee demand. See [PROVIDER](PROVIDER.md).

## Labels you will see

| Label | Meaning |
|---|---|
| `SIM` / `SIMULATED PEER` | Comes from the built-in demo market. Never real inference, never settled |
| `DEMO` | Demo engine or demo claim (e.g. `TEE · DEMO`) |
| `LIVE` | A real peer or your own upstream |
| `CLEAR` | The operator can read prompts |
| `LOCAL` | Your own machine or LAN |
| `CLAIMED` | Seller says it runs in a TEE; unverified, does not count for private routing |
| `VERIFIED` | A Google-signed Confidential Space attestation passed your trust list. Proven only against a simulated Google so far ([STATUS](STATUS.md)) |
| `MOCK` | The testnet token is our open-mint `MockUSDG`, worthless |

## Live app and the try page

The project's own node runs at `app.elyrainference.com`. Signed out you get the **public app**: a real product with navigation, not a single chat box. The full panel (everything above) is behind a login and is for the node's owner.

It is a small, separate surface, off unless the node sets `ELYRA_PUBLIC_TRY=1` ([Remote access](REMOTE-ADMIN.md#public-market-page-optional)). Free hosted chat uses only this operator's own local/remote model, never a paid peer, hosted API key or simulated answer. Browser paid-peer chat is a separate opt-in (`ELYRA_PUBLIC_PAY=1`) escrow-session path. To manage sources, routing, selling and the node wallet, open your own node's owner console ([Quickstart](QUICKSTART.md)).

### Pages and navigation

Header: logo with a **Beta** badge, **Market**, **Playground**, **Sell**, **Docs** and **GitHub** (new tabs), theme toggle and the wallet button. Navigation is hash routing (`#/market` default, `#/playground`, `#/sell`; the old `#sell` and `#m=<model>` links still work, `#m=` opens that model's sellers). On phones the nav sits in a second row of the sticky header. Moving between pages moves keyboard focus to the page heading; there is a skip link; the current page has `aria-current`. The footer has Product / Resources / Project columns (docs, quickstart, run a node, security, GitHub, MIT license, Terms, Privacy), says it is an early build and shows the node's real facts (peers, settlement, free chats left today).

| Page | What it is |
|---|---|
| **Market** | Browse-first hero and a three-path guide: own model (no escrow), hosted try (quota and deployment-specific access), paid peer (escrow session). Real model/seller counts are scoped to this node, not a global index. Open a model for each seller's price, speed basis, privacy and local reputation, plus a price range from actual offers. `Try` opens the free hosted model; `Review paid` appears only when browser payment is enabled and opens a pre-funding Playground review, not a wallet prompt. Actions choose a model, not a guaranteed seller |
| **Playground** | Hosted free mode shows deployment access requirements and quota; only the gateway gate asks for sign-in/username. Paid peer mode can be reviewed before funding: it shows the same price ceiling sent with the request (highest current peer offer plus the existing 5% quote allowance), disables sending until the session is funded, and opens session setup on demand. `Session & usage` opens browser-session balance and signed usage. Each answer keeps its actual route, tokens and cost; free quota is hidden in paid mode. Conversation history is local to this browser, not global activity |
| **Sell** | A complete handoff to your own node console: connect your own model, choose offers/prices, verify reachability, configure settlement/gas and track earnings. Public wallet sign-in does not grant seller controls. Existing install command, arithmetic earnings example and provider/relay/wallet guides remain; reachability is not a promise of demand |

**History** lives only in the visitor's `localStorage["elyra-try-chat"]` (last 60 turns, one conversation). The page says so under the composer, `Clear history` (two clicks) wipes it, and nothing about it is stored on the node; the last few messages of the conversation are sent with each request, as before. Choosing another model keeps the conversation.

### Wallet, sign-in and tiers

The header button **Connect wallet** opens the genuine **Reown AppKit** picker directly (injected wallets and WalletConnect QR), lazy-loaded from the existing checksummed wallet bundle through `/try/appkit.js`. The operator must set `ELYRA_REOWN_PROJECT_ID` and allow the app's domain in the Reown dashboard; without a valid setting the page reports that connection is unavailable, never a fake success or a custom wallet list. AppKit follows Elyra's dark/light theme and may ask the wallet to switch to the configured network. Connecting is separate from **Sign in**, which requests one off-chain SIWE signature through `/try/auth.js`: no transaction, token approval or transfer. The account menu remains Elyra's own UI for the profile, balances and paid session. Its chip shows the short address or username and role (`Wallet` or `Owner`); only an owner gets the control-panel link. A user wallet session cannot reach `/api`, `/v1`, `/metrics` or the private Live feed. Sign out revokes the server session; disconnect only disconnects the wallet.

**Username (opt-in `ELYRA_GATEWAY=1`):** with the gateway on, the signed-in wallet also picks a name once (`GET/PUT /auth/username`) and the free chat needs it: without a session the chat says to sign in (`401 signin_required`), without a name to choose one (`403 profile_required`); an admin session is exempt. It is the same wallet session, not a second sign-in.

**Paying (opt-in `ELYRA_PUBLIC_PAY=1`):** Market's **Review paid** opens Playground with the model selected, the real model-level ceiling and a funding gate. **Set up paid session** opens **Paid session · funding & usage** in the wallet menu. Create a browser-held throwaway key (no transaction), connect a funding wallet, then approve + deposit USDG for that session address (wallet-confirmed transactions; capped at the deployment's per-wallet cap, $20 by default). Sign-in is separate and is not required for this paid-session path. Sending in paid mode authorizes vouchers within the displayed ceiling; the actual seller, tokens and charge appear under the answer. Session usage is only this browser's signed record. Keep the key before clearing storage; withdrawal requires a 1-day delay and ETH on the session address. Network/token warnings distinguish mainnet real money from mock/test networks. When payment is disabled, both Market and Playground say to use your own node; no fake funding action is shown.

### Code

`panel/try/`: `index.html` (shell and three pages), `try.css`, `theme.js`, and ES modules loaded from `try.js`: `lib.js`, `market.js`, `chat.js`, `wallet.js` (account menu), `appkit-connect.js` (lazy Reown picker), `auth.js` (SIWE and username), `pay.js` and `session.js` (opt-in browser session payments). The app's own markup has no inline scripts or styles and uses `textContent` for server text. When Reown is configured, public CSP adds exact SDK service origins and allows injected SDK styles; `script-src 'self'`, no eval, owner access rules and `frame-ancestors 'none'` remain enforced. Without Reown configured, the original self-only CSP stays. Reown picker/connect/disconnect and rejected-signature states were exercised in Chromium at 1440/390 px using an injected test provider and a test project ID; actual phone-wallet relay pairing needs a valid project ID and was not verified.
