# ---------------------------------------------------------------------------
# Production image. Multi-stage so the runtime layer carries no build toolchain.
# Works as-is on Railway / Fly / Render / Cloud Run.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
# argon2 ships prebuilds, but keep the toolchain available in case it must compile.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini && addgroup -S app && adduser -S app -G app

COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Drop dev dependencies but keep the generated Prisma client.
RUN npm prune --omit=dev && npx prisma generate && chown -R app:app /app

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# Migrations are applied on release, not on boot, so multiple instances cannot race.
CMD ["node", "dist/main"]
