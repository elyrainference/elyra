# Remote access: put your node online

By default `/api`, `/v1` and `/metrics` answer only on your own machine and the panel is at `http://localhost:8545/app/`. For a node on a server you can publish the **real** panel on one hostname you own, behind a login, and optionally add a public page where anyone can try your model. Both are off until you set the variables below, and nothing about the loopback rules changes.

> Remote access has had automated tests (no session, wrong token, forged and expired cookies, cross-site writes, proxy headers, rate limiting) but **no external security review**. Treat the token as full control of the node, including its wallet, and keep only test funds in a node you expose.

## Why there is always a login

A tunnel or reverse proxy connects to the node from loopback, so the "is this request local?" check proves nothing for proxied traffic. Allowing another hostname without a login would publish your wallet, upstream API keys and model server to anyone who finds the URL. Remote access therefore requires, in this order:

1. The exact admin host in the `Host` header. Every other host keeps the loopback rules.
2. A valid **admin** session cookie (`elyra_admin`, `HttpOnly; Secure; SameSite=Strict`, signed with HMAC-SHA256 under a random per-boot key, valid 12 hours; a restart signs everyone out and sign-out revokes the cookie on the server too). It comes from the token or from a wallet signature of an allow-listed address. A cookie of role *user* (any other wallet) is refused with 403 on `/api`, `/v1`, `/metrics` and `/api/events`.
3. For browser writes, an `Origin` equal to `https://<admin host>`.

Also enforced: the token is compared in constant time and never logged or returned; five failed logins lock that client for 10 minutes and 30 failures lock all logins for 10 minutes (wallet sign-in has its own limits, see [Sign-in](AUTH.md)); a request carrying proxy headers (`cf-connecting-ip`, `x-forwarded-for`, ...) can never use the localhost path; `/metrics` is never reachable through the admin host; `/p2p/*` stays open as it always was.

## 1. Turn it on

Pick a hostname you control, for example `node.example.com`, and a long random token:

```bash
python3 -c 'import secrets;print(secrets.token_urlsafe(32))'     # keep it in a password manager
```

Add to `/etc/elyra/env` (owned by root, `chmod 600`):

```
ELYRA_ADMIN_HOST=node.example.com
ELYRA_ADMIN_TOKEN=<the token>
```

Instead of the token (or next to it) you can sign in with a wallet: list the owner addresses, comma-separated, in `ELYRA_ADMIN_ADDRESSES=0xAbc…,0xDef…` (case does not matter). The login page then shows **Sign in with wallet**; the address must be in the list to become an admin, any other address is only a visitor. With addresses and no token there is no token login at all. Smart-contract wallets are not supported; see [Sign-in](AUTH.md).

Then `sudo systemctl restart elyra`. The node still listens on `127.0.0.1:8545` only. If the host is missing, or there is neither a token of at least 24 characters nor an admin address, remote access stays **off** and the log says why.

## 2. Publish the hostname with a Cloudflare named tunnel

The node must not listen on a public port; the tunnel dials out. Create a tunnel just for the node (do not reuse one that serves other sites), point `node.example.com` at `http://127.0.0.1:8545`, and run it as a systemd service. With the dashboard: Zero Trust, Networks, Tunnels, create a tunnel, copy its token into `/etc/elyra/tunnel.env` as `TUNNEL_TOKEN=...`, and add a public hostname with service `http://127.0.0.1:8545`.

```ini
# /etc/systemd/system/elyra-tunnel.service
[Unit]
Description=Elyra: Cloudflare tunnel
After=network-online.target
Wants=network-online.target
[Service]
EnvironmentFile=/etc/elyra/tunnel.env
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run
Restart=always
RestartSec=5
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
[Install]
WantedBy=multi-user.target
```

Cloudflare passes the original `Host`, which is what the node checks. You can put Cloudflare Access in front as a second factor; the node's login stays in place.

## 3. Check it from another computer

```bash
H=https://node.example.com
curl -s -o /dev/null -w '%{http_code}\n' $H/api/status        # 401  (no session)
curl -s -o /dev/null -w '%{http_code}\n' $H/metrics           # 403
curl -s -o /dev/null -w '%{http_code}\n' $H/app/              # 302 -> /admin/login
curl -s -o /dev/null -w '%{http_code}\n' $H/p2p/hello         # 200 (open on purpose)
```

Open `$H/admin/login` in a browser and sign in. The panel talks to your real node and your real model. **Sign out** is in the panel header.

If sign-in is refused with "cross-site request refused", something in front of the node is sending a stricter `Referrer-Policy` than `same-origin`, which makes browsers send `Origin: null`. Remove that header rule for the login page.

## Public market page (optional)

Add `ELYRA_PUBLIC_PAY=1` to let visitors also **pay peers per token from their own wallet**: the page creates a session key in the visitor's browser, the visitor deposits into the escrow for it (capped at $20 per wallet by default, the node's one deposit cap), and the page signs the vouchers. This node only relays the chat and the seller's receipt (`/pub/paid-chat`); it holds no money and no key for the visitor. Mainnet is open but capped and the contracts are unaudited.

Add `ELYRA_GATEWAY=1` to require a profile before chatting: a visitor signs in with their wallet (below), picks a username once (`GET|PUT /auth/username`), and only then can use `/pub/chat`. Without a session the chat answers `401 signin_required`, with a session but no name `403 profile_required`; an admin session is exempt. Profiles are stored in `accounts.json` in the data directory (encrypted when `ELYRA_PASSPHRASE` is set). This is not a second sign-in: it is the same wallet session plus a name.
Set `ELYRA_PUBLIC_TRY=1` and a visitor who is not signed in gets a public page instead of the login form: a **live market** of what this node and its connected peers offer, plus a free chat with the models your node runs itself. The login stays at `/admin/login`; unknown paths return a plain 404.

The market (`GET /pub/market`, read-only) lists each model with its sellers, price per million tokens, speed, reputation and a privacy label (Local, Remote, TEE verified, TEE claimed, Clear). It only contains real offers: simulated entries, the stub model and your own hosted API keys are never listed, and a value that has not been measured (speed, reputation) is shown as "not measured yet" rather than guessed. Speed is *measured* when this node has timed real requests, or *claimed* when a peer reports it. Your own source has no price until you offer it to the network (`ELYRA_PROVIDE=1`); it is then listed at your offered price and free to try on this page. Peers are listed for comparison only: they are paid from a wallet, so visitors reach them through their own node, never from this page. Set `ELYRA_TEAM_PEERS` to a comma-separated list of peer ids or names you run yourself and they are labelled "Elyra team"; every other peer is labelled "Community". Link straight to one model with `/#m=<model>`.

### Sign in with a wallet (no transaction)

A visitor can prove they own an Ethereum address with one signature (Sign-In with Ethereum, `/auth/nonce`, `/auth/verify`, `/auth/session`, `/auth/logout`). It sends no transaction, needs no gas and moves no funds. They get an identity chip, a larger hourly quota (`ELYRA_TRY_WALLET_PER_HOUR`, counted per address, bounded per IP) and chat history kept only in their own browser. A wallet visitor can **never** reach `/api`, `/v1`, `/metrics`, `/api/events` or the panel: those answer 403. `GET /pub/quota` returns `{ tier: "visitor" | "wallet", used, limit, resetsAt }`. Paying for chats from a visitor's wallet is the separate opt-in session-key flow above (`ELYRA_PUBLIC_PAY=1`), not the sign-in. Details and threat model: [Sign-in](AUTH.md).
What the chat can and cannot do:

- It only uses a model source you added yourself (Ollama on this machine, or [another machine](OLLAMA.md#ollama-on-another-machine-a-gpu-box-over-an-ssh-tunnel)). It never routes to a peer (that would spend your escrow), never uses a hosted API key, never serves simulated answers.
- A visitor picks one of the models your node serves itself; an unavailable model is refused and costs the visitor nothing. If none is answering, the page says it is offline. `ELYRA_TRY_MODEL` sets the default model: when it is set and unavailable the page is offline rather than quietly switching to a smaller one.
- Limits per visitor and overall, all adjustable (see [Configuration](CONFIGURATION.md)): 20 requests per hour per visitor, 100 per hour for a visitor who signed in with a wallet (above), 300 per day in total, 256 tokens per answer, 2 answers at once.
- The server adds a fixed system prompt and accepts only user and assistant messages (at most 12, 4000 characters). The router does not log or store prompt text.
- Same-origin only, strict content security policy. The only cookie the chat reads is the signed session, to tell the wallet tier from the visitor tier; it grants nothing else. The per-visitor limit uses Cloudflare's `CF-Connecting-IP`, so run it behind Cloudflare (or a proxy that sets it) or all visitors share one limit.
- Every answer runs on your hardware. Size the limits to the machine.

## Limits and risks

- One shared token (or a list of admin wallets, see [Sign-in](AUTH.md)), no per-person accounts, no 2FA. Rotate the token by editing the env file and restarting; the same restart ends every session.
- Anyone with the token, or who can sign in with an admin wallet, can spend the node wallet, change sources and use your model server.
- The global login lock means someone who can reach the URL can stop you from signing in for 10 minutes by guessing. Cloudflare Access or a WAF rule in front removes that.
- Sessions live in memory; a restart signs everyone out.
- The public try page is separate from the login and never exposes `/api`, `/v1`, `/metrics` or the panel.

For running this for real users (monitoring, backups, upgrades) see [Run it in production](OPERATIONS.md).
