FROM node:24-bookworm-slim AS build

ARG NARAD_UID=10001
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN test "$NARAD_UID" -ne 0 && useradd --create-home --uid "$NARAD_UID" narad \
    && mkdir -p /run/narad-agent && chown narad:narad /run/narad-agent

FROM build AS api
ENV NODE_ENV=production
USER narad
EXPOSE 4318
CMD ["npm", "start"]

FROM build AS agent
USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.163.0 @anthropic-ai/claude-code@2.1.304
ENV NODE_ENV=production HOME=/home/narad
USER narad
CMD ["node", "--import", "tsx", "server/agent-service.ts"]
