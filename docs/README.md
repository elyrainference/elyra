# Elyra documentation

The rendered, searchable version of these pages (grouped navigation, search, on-page contents) is on the project website under `/docs/`. This folder is the source.

**Start here**

- [Quickstart](QUICKSTART.md): from zero to a real answer from your own model, in about five minutes.
- [How it works](CONCEPTS.md): routing, peers, receipts, vouchers, real versus simulated.
- [FAQ and troubleshooting](FAQ.md)

**Guides**: [Install](INSTALL.md), [Run a real model (Ollama)](OLLAMA.md), [Use the endpoint](USAGE.md), [Control panel](PANEL.md), [Wallet and USDG](WALLET.md), [$ELYRA token](TOKEN.md), [Sell capacity](PROVIDER.md), [Remote admin](REMOTE-ADMIN.md), [Docker](DOCKER.md), [Run it in production](OPERATIONS.md), [Mainnet runbook](MAINNET.md), [Publish the website](DEPLOY-CLOUDFLARE.md)

**Reference**: [Configuration](CONFIGURATION.md), [Control API](API.md), [Peer protocol](PROTOCOL.md), [Architecture](ARCHITECTURE.md), [Glossary](GLOSSARY.md)

**Trust and security**: [Software design & status (SDD)](SDD.md), [Verification log (STATUS)](STATUS.md) (read these before relying on anything), [Sign-in (AUTH)](AUTH.md), [Security policy](../SECURITY.md), [TEE verification](TEE.md)

**Project**: [Roadmap](../ROADMAP.md), [Changelog](../CHANGELOG.md), [Contributing](../CONTRIBUTING.md), [Decision log](DECISIONS.md), [Landscape](LANDSCAPE.md), [Registry design](REGISTRY.md), [Server runbook](VPS.md), 

Rule for every page: never present simulated or unverified behaviour as real. Label it `SIM`, `CLAIMED` or `VERIFIED`.

The sidebar order and one-line descriptions live in `tools/pages/docs.mjs`; add a page there when you add a Markdown file.
