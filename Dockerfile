FROM node:24-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN useradd --create-home --uid 10001 narad

FROM build AS api
ENV NODE_ENV=production
USER narad
EXPOSE 4318
CMD ["npm", "start"]

FROM build AS agent
USER root
RUN npm install --global @openai/codex@0.163.0 @anthropic-ai/claude-code@2.1.304
ENV NODE_ENV=production HOME=/home/narad
USER narad
EXPOSE 4320
CMD ["node", "--import", "tsx", "server/agent-service.ts"]
