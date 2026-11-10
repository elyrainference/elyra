# Sign-in: tokens, wallets and roles

This page is the threat model of the sign-in of a hosted node (the admin host of [Remote access](REMOTE-ADMIN.md)). Code: `router/http/siwe.mjs` (wallet sign-in), `router/http/remote.mjs` (sessions, token login), `panel/try/auth.js` (browser helper). Tests: `router/test/siwe.test.mjs`, `router/test/remote.test.mjs`.

> Automated tests, no external security review. Treat the admin role as full control of the node, including its wallet.

## Three kinds of people

| Who | How they come in | What they get |
|---|---|---|
| **Visitor** | nothing | the live market and the free playground on the node's own local model, limited per IP (`ELYRA_TRY_PER_IP_HOUR`) |
| **User** | Sign-In with Ethereum, any address | the same, plus an identity chip and a larger hourly quota counted per address (`ELYRA_TRY_WALLET_PER_HOUR`). Chat history stays in their own browser. Nothing else |
| **Admin** | the shared token **or** Sign-In with an address in `ELYRA_ADMIN_ADDRESSES` | the control panel, `/api`, `/v1` and the private live view: full control, same as the token always was |

With `ELYRA_GATEWAY=1` a **User** must also pick a username once (`GET|PUT /auth/username`) before the node chats for them (`/pub/chat`: `401 signin_required`, `403 profile_required`; admins are exempt). That is a profile on the same session, not another sign-in: there is one cookie (`elyra_admin`) and no `/gw/*` routes.

Signing in does not pay for anything: a wallet cannot sign a voucher for every request, and this node never holds a visitor's money. Paying from the browser is a separate opt-in flow (`ELYRA_PUBLIC_PAY=1`): a throwaway session key in the visitor's browser signs the vouchers, never this sign-in session ([Wallet and USDG](WALLET.md#pay-per-use-on-the-public-page-browser-session-key)). Without it the page points to running your own node.

## What a signature proves, and what it does not

Sign-In with Ethereum ([EIP-4361](https://eips.ethereum.org/EIPS/eip-4361)) asks the wallet to sign one text message with `personal_sign`. It is not a transaction: no gas, no funds move, nothing is approved, nothing is sent to the chain.

- It **proves** that whoever clicked controls the private key of that address, right now, and meant to sign in to *this host*.
- It **does not prove** who the person is, that they own any funds or tokens, or that they are not running a thousand addresses. A fresh address costs nothing, which is why a user gets a larger quota but never access, and why the wallet tier is also capped per IP.
- It does **not** reveal anything the address does not already publish. The server stores nothing about a user beyond the address inside the session cookie; there are no accounts and no user database.

Only normal accounts (EOA, `ecrecover`) are supported. Smart-contract wallets (Safe, account abstraction, EIP-1271) sign in a way the node does not verify; they are refused with a message saying so. Use an EOA, or the token, to be admin.

## The flow

```
GET  /auth/nonce?address=0x…   ->  { message, nonce, expiresAt }
     wallet: personal_sign(message)
POST /auth/verify {address, message, signature}  ->  { address, role, expiresAt }  + Set-Cookie
GET  /auth/session             ->  { signedIn, address?, role?, expiresAt? }
POST /auth/logout              ->  { ok: true }  + cookie cleared
```

The address is a query parameter because EIP-4361 puts it inside the message. The message the server returns looks like this:

```
admin.example.com wants you to sign in with your Ethereum account:
0xAbc…

Sign in to Elyra. This does not move funds or approve anything.

URI: https://admin.example.com
Version: 1
Chain ID: 46630
Nonce: 9f2c…(32 hex)
Issued At: 2026-11-07T12:00:00.000Z
Expiration Time: 2026-11-07T12:05:00.000Z
```

The domain is `ELYRA_ADMIN_HOST`; the chain id is the network the node is configured for (46630 testnet, 4663 mainnet, 31337 local; 46630 when none is set).

## Replay and binding

- **The server writes the message and remembers it.** `/auth/verify` accepts only the exact text it issued for that nonce, for the address it was issued to. A changed domain, URI, chain id, statement, issued-at or expiry is a different string and is refused, even if it carries a valid signature from a real key. This is what stops another site from asking a wallet to sign "for" this node and replaying it here.
- **Single use.** The nonce (16 random bytes) is deleted on the first attempt, valid or not. A replayed message, or a correct signature sent after a failed one, is refused.
- **Short life.** 5 minutes; a message that claims to be issued more than 60 s in the future is refused. Nonces live in memory only: a restart invalidates all of them, and at most 2048 are kept (600 may be issued per 5 minutes in total, 20 per minute per client).
- **Host bound.** `/auth/*` exists only on the admin host. On any other `Host` it is a 404 and sets no cookie.
- **Origin bound.** The writes (`/auth/verify`, `/auth/logout`) must be JSON from the admin origin (or a client that sends no `Origin`); `Origin: null`, other sites and `Sec-Fetch-Site: cross-site` get 403. Nothing here sends CORS headers.
- **Strict input.** Bodies over 4 KiB are 413; the address must be 40 hex digits; the signature a 65-byte hex string; the message at most 1024 characters.

## Sessions and roles

The cookie is the same family as the token login: `HttpOnly; Secure; SameSite=Strict; Path=/`, 12 hours, HMAC-SHA256 under a random key made at boot (a restart signs everybody out).

- token login: `v1.<expiry>.<mac>`, role admin, no address;
- wallet sign-in: `v2.<expiry>.<role>.<address>.<mac>`, the MAC covers all of it, so a role or an address cannot be edited, an expiry cannot be extended, and a wallet MAC is not valid as a token-login MAC (and the other way round).

The role is decided by the server at sign-in: **admin** if the address is in `ELYRA_ADMIN_ADDRESSES` (comma-separated, compared case-insensitively; an entry that is not an address is ignored with a warning, so a typo locks someone out rather than letting anyone in), otherwise **user**. Changing the list needs a restart, which also ends every session.

What each cookie reaches:

| | admin | user | none |
|---|---|---|---|
| `/app/*` panel, `/api/*`, `/v1/*` (including the live feed `/api/events`) | yes | **403** | 401 / login |
| `/metrics` | never (403 for everyone on the admin host) | 403 | 403 |
| `/pub/*`, the public page | yes | yes (wallet quota tier) | yes (visitor tier) |
| `/p2p/*`, `/healthz` | open to all, as always | | |

A user cookie on `/api` is a 403 rather than a 401 so the page can tell "signed in but not allowed" from "signed out"; the response says nothing else.

## Rate limits and lockouts

| What | Limit |
|---|---|
| `/auth/nonce` | 20 per minute per client, 600 per 5 minutes in total |
| failed `/auth/verify` | 5 failures lock that client for 10 minutes (a correct signature is refused during the lock, and the lock does not burn the nonce); 60 failures from anywhere lock all wallet verification for 10 minutes |
| failed token login | 5 per client, 30 in total, 10 minutes (unchanged) |

The client is `CF-Connecting-IP` (or `X-Forwarded-For`), so run the node behind Cloudflare or a proxy that sets it, or all clients share one budget. As with the token, the global lock means someone who can reach the URL can delay your sign-in for ten minutes; Cloudflare Access or a WAF rule in front removes that.

## Configuration

| Variable | Effect |
|---|---|
| `ELYRA_ADMIN_HOST` | the admin hostname and the SIWE domain (required) |
| `ELYRA_ADMIN_TOKEN` | at least 24 characters; optional when addresses are set |
| `ELYRA_ADMIN_ADDRESSES` | admin wallets. Remote admin turns on with the host and either of the two |
| `ELYRA_PUBLIC_TRY=1` | also turns wallet sign-in on for visitors (user role) |
| `ELYRA_TRY_WALLET_PER_HOUR` | the wallet tier's hourly limit (default 100; visitors 20) |

A token-only node with no public page has no `/auth/*` routes at all. With addresses set, the login page also offers "Sign in with wallet" and loads two same-origin scripts (`/admin/login.js`, `/admin/auth.js`) under `script-src 'self'; connect-src 'self'`; there is never inline script, and without an admin address the page keeps its script-free CSP.

## Not covered

- Smart-contract wallets (EIP-1271) and Sign-In with a session key.
- Revoking one session before it expires (log out clears the cookie of that browser; a stolen cookie lives until its 12 hours end or a restart).
- Two-factor, per-user accounts, per-user audit. The admin role is all-or-nothing, like the token.
- Wallet admins are only as safe as their wallet: anyone who can make that wallet sign the message above is an admin. Keep admin addresses to hardware wallets or accounts that hold no funds.
