# Imagem de execução web/API para QA e release; não contém segredos.
FROM node:22.14.0-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web && npm run build:server

FROM node:22.14.0-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=node:node /app/dist-web ./dist-web
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/database.sql ./database.sql
COPY --from=build --chown=node:node /app/database/upgrades ./database/upgrades
COPY --from=build --chown=node:node /app/scripts/database-schema.mjs ./scripts/database-schema.mjs
COPY --from=build --chown=node:node /app/scripts/tenant-initial-admin.mjs ./scripts/tenant-initial-admin.mjs
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:3001/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist-server/server/index.js"]
