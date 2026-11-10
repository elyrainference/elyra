# Elyra node for a Linux host. Build: docker build -t elyra .   Run: see docker-compose.yml and docs/DOCKER.md.
# Not the TEE image: that one is deploy/tee/Dockerfile (pinned digest, Confidential Space).
FROM node:22-bookworm-slim
WORKDIR /srv/elyra
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# lockfile-exact, production-only: the one runtime dependency is ethers
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY router/ router/
COPY panel/ panel/
COPY site/ site/
COPY contracts/artifacts/ contracts/artifacts/
RUN rm -rf router/test && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
# The router listens on 127.0.0.1 by default and keeps /api and /v1 loopback-only. Run the container with
# host networking (docker-compose.yml does) so "loopback" means the host's own loopback.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8545)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "router/server.mjs", "--data", "/data"]
