# Run Elyra in Docker (Linux)

A `Dockerfile` and a `docker-compose.yml` are in the repository root. The image is the same code as `npm start`, installed with the lockfile and production dependencies only, running as the unprivileged `node` user. Tests are not in the image.

> **Status:** built and smoke-tested by CI on every push (image builds, container becomes healthy, `/healthz` and the loopback API answer). Not yet run by an independent operator on a production host.

## Why host networking

The router answers `/api`, `/v1` and the control panel **only to the machine it runs on**. With a normal Docker port mapping, requests arrive from the Docker bridge, not from loopback, so the router would (correctly) refuse them. The compose file therefore uses `network_mode: host`, and the router keeps listening on `127.0.0.1`. This works on Linux. Docker Desktop on Windows and macOS does not provide real host networking: use the plain `npm start` install there.

## Start

```bash
git clone https://github.com/elyrainference/elyra.git && cd elyra
printf 'ELYRA_PASSPHRASE=%s\n' "$(openssl rand -hex 24)" > .env     # encrypts the node wallet at rest. Keep a copy: without it the wallet cannot be opened
docker compose up -d --build
curl http://127.0.0.1:8545/healthz       # panel: http://localhost:8545/app/
```

By default the node uses an Ollama on the host (`http://127.0.0.1:11434/v1`). Install Ollama first ([OLLAMA.md](OLLAMA.md)) or point `ELYRA_UPSTREAM_URL` in `.env` at another OpenAI-compatible server.

## Sell capacity

Add to `.env`, then recreate the container: `ELYRA_PROVIDE=1`, `ELYRA_PROVIDE_PRICE=<usd per million tokens>`, `ELYRA_PAYOUT=<your address>` and either `ELYRA_PUBLIC_URL=https://...` or `ELYRA_RELAY_URL=https://...` (a seller behind NAT uses the relay). `ELYRA_PROVIDE` and the price only apply on the first start of a fresh data volume; change them later in the panel (Provide). Details and risk controls: [PROVIDER.md](PROVIDER.md).

## Data and upgrades

- Identity, wallet and state live in the `elyra-data` volume (`/data`). **Back it up**: deleting it loses the wallet and any unredeemed vouchers.
- Upgrade: `git pull && docker compose up -d --build`. Read the [changelog](../CHANGELOG.md) first; a protocol bump means old and new nodes do not interoperate.
- Logs: `docker compose logs -f elyra`. Metrics: `curl http://127.0.0.1:8545/metrics`.

## Not this image

`deploy/tee/Dockerfile` builds the Confidential Space (TEE) seller image with a pinned base digest. It is a different, stricter artifact: see [TEE.md](TEE.md).
