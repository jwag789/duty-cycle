# One image, one process: the room server serves the built web app and the
# WebSocket on /ws. Rooms live in that process's memory, so run one instance.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/engine/package.json packages/engine/
COPY packages/client/package.json packages/client/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/engine/package.json packages/engine/
COPY packages/client/package.json packages/client/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev && npm cache clean --force
# The server runs TypeScript directly with tsx, so it needs the sources it imports.
COPY packages ./packages
COPY apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
# Without DATABASE_URL, rooms go to PGlite under /app/.data: mount a volume there.
RUN mkdir -p .data && chown node:node .data
EXPOSE 8787
# Volumes often mount owned by root, so take ownership of the data dir, then
# drop to the unprivileged node user. This is what `npm start` runs, minus the
# npm wrappers, so Node gets the stop signal itself and shuts down cleanly.
CMD ["sh", "-c", "chown node:node /app/.data && HOME=/home/node exec setpriv --reuid=node --regid=node --init-groups node --import tsx apps/server/src/index.ts"]
