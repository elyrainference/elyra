# Install

Run a node on your own computer or on a Linux server.

## Requirements

| | |
|---|---|
| Node.js | 20 or newer (22 LTS recommended). Plain ESM, no build step |
| Runtime dependency | `ethers` (loaded dynamically; the router works without it, chain settlement does not) |
| Network | Outbound HTTPS. Inbound only if you want to *provide* capacity (see [Exposure](#exposure)) |
| Disk / RAM | The router is light. Models are what cost RAM and disk, see [OLLAMA](OLLAMA.md) |

## Local (laptop or desktop)

```bash
git clone https://github.com/elyrainference/elyra.git
cd elyra
npm ci --omit=dev
npm start                      # http://localhost:8545/  (panel at /app/, API at /v1)
```

Windows: `start.bat`. A second node on one machine: `npm run node2` (port 8546, data dir `.elyra-b`).

Data (identity, **wallet private key**, state) lives in `.elyra/`. Back it up; losing it loses the wallet and any unredeemed vouchers. It is git-ignored and the web server refuses to serve dot-directories. Set `ELYRA_PASSPHRASE` to encrypt it at rest (scrypt then AES-256-GCM); without the passphrase the node refuses to start.

## Linux server (systemd)

### 1. Node.js

A systemd service runs as an unprivileged user, so Node must be readable system-wide. Use the official tarball and verify its checksum:

```bash
V=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep linux-x64.tar.xz | sed -E 's/.*node-(v[0-9.]+)-linux.*/\1/')
curl -fsSLO https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz
curl -fsSL https://nodejs.org/dist/$V/SHASUMS256.txt | grep "node-$V-linux-x64.tar.xz" | sha256sum -c -
sudo mkdir -p /opt/node && sudo tar -xJf node-$V-linux-x64.tar.xz -C /opt/node --strip-components=1
/opt/node/bin/node --version
```

(Distro packages or NodeSource also work; then use `/usr/bin/node` in the unit below.)

### 2. Code, user, secrets

```bash
sudo useradd -r -m -d /home/elyra -s /usr/sbin/nologin elyra
sudo git clone https://github.com/elyrainference/elyra.git /opt/elyra
cd /opt/elyra && sudo PATH=/opt/node/bin:$PATH npm ci --omit=dev
sudo chown -R elyra:elyra /opt/elyra

sudo mkdir -p /etc/elyra
sudo tee /etc/elyra/env >/dev/null <<EOF
ELYRA_PASSPHRASE=$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')
ELYRA_NETWORK=robinhood-testnet
ELYRA_ESCROW=0xe9dA82E45D8CbF84A633a0B0e46e12D2A9288092
ELYRA_UPSTREAM_URL=http://127.0.0.1:11434/v1
ELYRA_UPSTREAM_NAME=ollama
EOF
sudo chmod 600 /etc/elyra/env
```

**Store the passphrase in a password manager.** Without it `/var/lib/elyra` (identity and wallet) cannot be opened. The escrow address above is the testnet deployment from `docs/STATUS.md`; check it is still current before use.

### 3. Service

```ini
# /etc/systemd/system/elyra.service
[Unit]
Description=Elyra node
After=network-online.target ollama.service
[Service]
User=elyra
WorkingDirectory=/opt/elyra
EnvironmentFile=/etc/elyra/env
ExecStart=/opt/node/bin/node router/server.mjs --host 127.0.0.1 --port 8545 --data /var/lib/elyra --name seller-1 --no-demo
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=30
StateDirectory=elyra
[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now elyra
curl -s http://127.0.0.1:8545/healthz        # {"ok":true,"version":...,"protocol":3,...}
journalctl -u elyra -f                       # JSON lines; never contain prompts or keys
```

Keep `TimeoutStopSec` at 30 or more: on SIGTERM the node redeems outstanding vouchers (bounded to 20 s) before exiting. `--no-demo` removes the simulated peers, which a real node should not show. For a node that faces the internet also add the sandboxing drop-in from [Run it in production](OPERATIONS.md#run-the-service-sandboxed).

### 4. Verify

```bash
ss -ltnp | grep -E '8545|11434'    # both must be 127.0.0.1 only
curl -s http://127.0.0.1:8545/v1/models      # lists your Ollama model next to auto, auto:cheapest, ...
```

## Exposure

Only `/p2p/*` and `/healthz` may ever be reachable from the internet. `/api/*` (wallet, keys, upstream keys), `/v1/*` and `/metrics` are loopback-only inside the node (loopback peer, `localhost` Host, `localhost` Origin), but **do not rely on a single guard: never forward them through a proxy**.

To provide capacity you need a public HTTPS URL for `/p2p/*`. Caddy:

```
seller.example.com {
  @p2p path /p2p/* /healthz
  handle @p2p { reverse_proxy 127.0.0.1:8545 }
  respond 404
}
```

then add `ELYRA_PUBLIC_URL=https://seller.example.com`, `ELYRA_PROVIDE=1`, `ELYRA_PROVIDE_PRICE=<usd per MTok>` and `ELYRA_PAYOUT=<address you control>` to `/etc/elyra/env` and restart. For a test without a domain, `cloudflared tunnel --url http://127.0.0.1:8545` gives a temporary address. Providing also needs testnet ETH in the node wallet for redeem gas (a faucet step).

To reach the **real panel** from anywhere, either use the SSH tunnel below, or opt in to [remote access](REMOTE-ADMIN.md) (one hostname behind a login, through a Cloudflare tunnel, with an optional public try page). Remote control panel without exposing it: `ssh -L 9545:127.0.0.1:8545 user@server`, then open `http://localhost:9545/app/` (the Host must be `localhost`, which is why a tunnel works and a public hostname does not).

## Upgrade

Back up the data directory first ([Backups](OPERATIONS.md#backups)).

```bash
sudo systemctl stop elyra          # redeems vouchers first
cd /opt/elyra && sudo -u elyra git pull && sudo PATH=/opt/node/bin:$PATH npm ci --omit=dev
sudo systemctl start elyra
```

Read `CHANGELOG.md`: a `PROTOCOL` bump means old and new nodes do not interoperate.

## Uninstall

```bash
sudo systemctl disable --now elyra && sudo rm /etc/systemd/system/elyra.service
sudo rm -rf /opt/elyra /etc/elyra            # /var/lib/elyra holds the wallet: keep it or sweep funds first
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `status=203/EXEC` or "failed" right after start | The `node` path in `ExecStart` is not readable by user `elyra` (e.g. Node installed under `/root`). Install to `/opt/node` as above |
| `npm test`: "node did not start" or random failures on a busy machine | Boot can take 5 s or more under load. Tests now wait 30 s; if you still see it, run tests when the box is idle |
| Node refuses to start with a passphrase error | Missing or wrong `ELYRA_PASSPHRASE` for an existing encrypted data dir |
| `/v1/models` has no Ollama model | Ollama not running, or `ELYRA_UPSTREAM_URL` does not end in `/v1`. Check `curl 127.0.0.1:11434/v1/models` |
| First request takes about a minute | Ollama is loading the model into memory (cold start). Later requests are much faster |
| Generation is only about 1 token per second | A small CPU server is limited by memory bandwidth, not by Elyra. Use a smaller model, a faster machine, or a GPU machine over a tunnel ([OLLAMA](OLLAMA.md#ollama-on-another-machine-a-gpu-box-over-an-ssh-tunnel)) |
| A source shows OFFLINE in Connect | It failed two health checks in a row. See [Run it in production](OPERATIONS.md#troubleshooting) |
