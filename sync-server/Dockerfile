FROM docker.m.daocloud.io/library/node:24.13-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV DATA_DIR=/data

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8787

CMD ["node", "src/index.mjs"]
