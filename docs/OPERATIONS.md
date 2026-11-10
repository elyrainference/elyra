# Run it in production

A checklist for a node that other people depend on: a public try page, a seller node, or a node you simply want to keep up. Everything here is something you do on your own server; none of it is needed for a node on your laptop.

## Before you open it to users

- [ ] The node listens on `127.0.0.1` only and is reached through a tunnel or a proxy that forwards **only** `/p2p/*`, `/healthz` and, if you use it, the [try page and login](REMOTE-ADMIN.md). Never forward `/api`, `/v1` or `/metrics`.
- [ ] `ELYRA_PASSPHRASE` is set, so the wallet key is encrypted on disk. **Copy the passphrase to a password manager.** Without it a backup cannot be opened.
- [ ] The admin token is long and random, and is stored only in `/etc/elyra/env` (`chmod 600`, owner root).
- [ ] Only test funds are in the node wallet until you have read [Wallet and USDG](WALLET.md) and accept the risks. Settlement runs on a test network by default.
- [ ] The service restarts by itself and is sandboxed (below).
- [ ] You get told when the model stops answering (see Monitoring).
- [ ] You have a backup and have tried restoring it.
- [ ] If the model runs on another machine, you know what that costs, who can read prompts there, and what happens when it is switched off (see Model on another machine).

## Run the service sandboxed

The unit in [Install](INSTALL.md#3-service) restarts on failure. For a node that faces the internet add a drop-in that removes what the node does not need:

```ini
# /etc/systemd/system/elyra.service.d/hardening.conf
[Service]
Restart=always
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
LockPersonality=yes
RestrictSUIDSGID=yes
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
SystemCallArchitectures=native
CapabilityBoundingSet=
MemoryMax=2G
TasksMax=512
LimitNOFILE=8192
```

```bash
sudo systemctl daemon-reload && sudo systemctl restart elyra
systemd-analyze security elyra --no-pager | tail -1     # about 3 (OK) with this drop-in, 9 (UNSAFE) without
```

The node can still write to its data directory (`StateDirectory=elyra`) and nowhere else. If you start the node from a different directory layout, check `journalctl -u elyra` for `EROFS` or `EACCES` after the change.

## Monitoring

Three signals are enough to start.

| Signal | Where | Alert when |
|---|---|---|
| The node is up | `GET /healthz` returns `{"ok":true,...}` and is safe to expose | not 200 for 2 minutes |
| A model source is serving | `/healthz` field `serving` (true when at least one real model source answers) | `serving` is false |
| A source is down | `/metrics` gauge `elyra_upstreams_down` (and `elyra_upstreams_up`), loopback only | greater than 0 for 2 minutes |

The node probes every model source every 15 seconds. A source that fails two probes in a row is marked **offline**: it disappears from `/v1/models` and from routing, the panel shows an **OFFLINE** badge with the reason, and it comes back as soon as it answers. Requests already in flight fall through to the next route.

An external uptime check on `https://your-host/healthz` plus a check that `serving` is `true` covers the node and the model. Logs are JSON lines in the journal and contain no prompts or keys:

```bash
journalctl -u elyra -n 100 --no-pager
journalctl -u elyra --since "-1h" | grep '"level":"error"'
```

## Backups

Everything that matters is the data directory (`/var/lib/elyra` for the service): `identity.json` (node identity), `wallet.json` (wallet key) and `state.json` (sources, settings, unredeemed vouchers). Losing it loses the wallet and any vouchers you have not redeemed.

```bash
sudo systemctl stop elyra                       # redeems outstanding vouchers, then a consistent copy
sudo tar -C /var/lib -czf /root/elyra-$(date +%F).tgz elyra
sudo systemctl start elyra
```

Keep copies **off the server**, and keep `ELYRA_PASSPHRASE` somewhere else than the copy: the files are encrypted, so a copy without the passphrase is useless and a passphrase without a copy is too. Restore by stopping the service, putting the directory back with `chown -R elyra:elyra`, and starting it. Try a restore on a spare machine once before you need it.

The panel's **Connect → Back up this node** card shows the data directory path, whether the secrets are encrypted at rest, a checklist, and downloads the **public** facts (node id, wallet address, escrow) as JSON. That file holds no keys and no passphrase, is safe to share and only helps you recognise the node after a restore; the backup itself is still the data directory.
### Automated daily backup and non-disruptive restore drill

On the production VPS, `elyra-backup.timer` runs `/usr/local/bin/elyra-backup.sh` daily at `03:17 UTC`. The script copies `/var/lib/elyra` to a temporary directory, verifies that `state.json` parses as valid JSON (retrying up to 3 times if a write is in flight), writes `/var/backups/elyra/elyra-<timestamp>.tgz` (`0600`, root-only) with `./identity.json`, `./wallet.json` and `./state.json` at the archive root, and keeps the newest 14 archives.

To restore a daily archive from `/var/backups/elyra` into `/var/lib/elyra`:

```bash
sudo systemctl stop elyra
sudo tar -C /var/lib/elyra -xzf /var/backups/elyra/elyra-<timestamp>.tgz
sudo chown -R elyra:elyra /var/lib/elyra
sudo systemctl start elyra
```

To verify a backup on the same server **without** stopping the live node or announcing the test instance to peers/relays, extract it into a temporary directory and boot on a spare loopback port with **only** `ELYRA_PASSPHRASE` exported (omit `ELYRA_RELAY_URL` and `ELYRA_SEEDS`):

```bash
TMP=$(mktemp -d)
tar -C "$TMP" -xzf /var/backups/elyra/elyra-<timestamp>.tgz
ELYRA_PASSPHRASE=$(grep '^ELYRA_PASSPHRASE=' /etc/elyra/env | cut -d= -f2-) \
  /opt/node/bin/node /opt/elyra/router/server.mjs --host 127.0.0.1 --port 18599 --data "$TMP" --no-demo &
PID=$!
sleep 2
curl -s http://127.0.0.1:18599/p2p/hello | jq '{id, wallet: .wallet.address}'
curl -s http://127.0.0.1:18599/api/provide | jq '{enabled, upstreamId, price, prices}'
kill "$PID" && rm -rf "$TMP"
```

Compare `id`, `wallet.address`, `pub`, `box.pub`, `provide` and `upstreams` against `http://127.0.0.1:8545`: all must match, and starting with a wrong passphrase must exit non-zero.

## Upgrade and roll back

```bash
sudo systemctl stop elyra
cd /opt/elyra && git rev-parse HEAD > /root/elyra-previous-commit
sudo -u elyra git pull && sudo PATH=/opt/node/bin:$PATH npm ci --omit=dev
sudo systemctl start elyra && curl -s http://127.0.0.1:8545/healthz
```

Read [Changelog](../CHANGELOG.md) first: a protocol bump means old and new nodes do not interoperate. To roll back, stop the service, `git checkout $(cat /root/elyra-previous-commit)`, reinstall and start. The data directory is not changed by an upgrade unless the changelog says so; back it up first anyway.

## Model on another machine

A small server is slow at language models because generation is limited by memory bandwidth; a GPU machine is far faster. [Use another machine over an SSH tunnel](OLLAMA.md#ollama-on-another-machine-a-gpu-box-over-an-ssh-tunnel) and tick **Another machine** when you add it, so it is labelled **REMOTE** and never counted as private.

Things that go wrong with rented GPUs, and what the node does about them:

- **The machine is stopped, reclaimed or restarted.** Its address and port often change. The tunnel service keeps retrying; the source goes **offline** after about 30 seconds and the try page says the model is offline instead of failing. Update the host and port in your tunnel unit when the machine is back.
- **Billing continues while it runs.** Stop it when you do not need it; the node shows it as offline and the try page says so.
- **The owner of the machine can read what you send it.** Do not put the wallet key, tokens or private data on it, and do not use it for prompts you promised to keep private.
- **The first request after idle is slow** while the model loads into GPU memory. Keep the model loaded (`OLLAMA_KEEP_ALIVE=-1` on the GPU machine).

## Troubleshooting

| Symptom | Check |
|---|---|
| Try page says "The model is offline" | Panel, Connect: is the source marked OFFLINE and why? `curl -s http://127.0.0.1:11435/api/version` through the tunnel, `systemctl status` of the tunnel unit, then the model machine |
| `/healthz` has `"serving": false` | No real model source is answering. Same checks |
| Visitors all share one rate limit | The proxy is not sending `CF-Connecting-IP`; run behind Cloudflare |
| Sign-in loops or says "cross-site request refused" | A proxy rule changes `Referrer-Policy`; see [Remote access](REMOTE-ADMIN.md) |
| Node will not start after a change | `journalctl -u elyra -n 50`; a passphrase error means the env file lost `ELYRA_PASSPHRASE` |
| Everyone was signed out | The node restarted; sessions are in memory by design |

## Public-surface bounds and abuse protections

Every endpoint reachable without the admin session (`/pub/*`, `/try/*`, `/admin/login`, `/relay/*`, `/r/<id>/p2p/*`, `/p2p/*`, `/healthz`) is bounded in body size, concurrency, rate and in-memory table size:

- **Free try chat (`POST /pub/chat`):** 16 KB body limit, 1–12 messages, 4,000 chars total, per-IP hourly limit (`ELYRA_TRY_PER_IP_HOUR`, default 20), daily cap (`ELYRA_TRY_DAILY`, default 300), concurrency cap (`ELYRA_TRY_CONCURRENCY`, default 2), `hits` table capped at 5,000 IPs (evicts expired then oldest).
- **Browser session pay (`/pub/paid-chat`, `/pub/voucher`, `/pub/session`):** 24 KB / 4 KB body limits, per-IP hourly rate limits (`ELYRA_PAY_PER_IP_HOUR`, default 60 chats and 600 voucher/session reads), concurrency cap (`ELYRA_PAY_CONCURRENCY`, default 4), one in-flight chat per session wallet, `payHits` table capped at 5,000 keys; chain RPC errors return `503 chain_unavailable`.
- **Relay (`/relay/wait`, `/relay/reply`, `/r/<id>/p2p/*`):** up to 100 active sellers, 16 queued / 8 in-flight jobs per seller, 20,000 replay-guard nonces, 120 s head timeout; buyer disconnects immediately drop queued jobs so dead requests never reach the seller.
- **Peer protocol (`/p2p/hello`, `/p2p/infer`, `/p2p/voucher`):** 100 KB / 8 MB / 20 KB body limits, per-consumer token bucket (`ratePerMin`), concurrency cap (`maxConcurrent`), 20,000 replay-guard nonces (evicts expired then oldest).
