# ── Stage 1: build the React frontend ────────────────────────────────────────
FROM node:22-alpine AS web-build
WORKDIR /build/web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY web/ ./
RUN npm run build

# ── Stage 2: build the NestJS server ─────────────────────────────────────────
FROM node:22-alpine AS server-build
WORKDIR /build/server
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-fund --no-audit
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /app/generated && chown -R app:app /app/generated
COPY --from=server-build --chown=app:app /build/server/node_modules ./node_modules
COPY --from=server-build --chown=app:app /build/server/dist ./dist
COPY --from=server-build --chown=app:app /build/server/package.json ./package.json
COPY --from=web-build --chown=app:app /build/server/public ./public
VOLUME ["/app/generated"]
USER app
EXPOSE 3000
CMD ["node", "dist/main.js"]
