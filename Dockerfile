# ---------------------------------------------------------------------------
# Production image. Multi-stage so the runtime layer carries no build
# toolchain and no development dependencies.
#
# Two things matter for size, and both are easy to get wrong:
#
#   * Layers are additive. `npm prune` in the runtime stage does not remove
#     anything — it writes a second copy of what is left. So the pruning
#     happens in its own stage and only the result is copied forward.
#   * `chown -R` rewrites every file it touches, which duplicates the entire
#     tree in a new layer. `COPY --chown` sets ownership as files land instead.
#
# Getting those wrong cost 1.3GB.
# ---------------------------------------------------------------------------

FROM node:22-alpine AS deps
WORKDIR /app
# argon2 ships prebuilds, but keep the toolchain available in case it must compile.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
# npm retries twice by default with a short ceiling, so one blip between the
# builder and the registry fails the whole deploy. Five tries with a longer
# backoff costs nothing on a good day.
RUN npm ci --fetch-retries=5 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=120000

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build
# A build that emits nothing still exits 0. Fail here rather than shipping an
# image whose only symptom is "Cannot find module '/app/dist/main'" at boot.
RUN test -f dist/main.js || (echo 'Build produced no dist/main.js' >&2 && exit 1)

# Dependencies as the runtime actually needs them. The full install and the
# prune both happen here, so the intermediate bulk never reaches the image.
FROM node:22-alpine AS runtime-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
COPY prisma ./prisma
COPY prisma.config.ts ./
COPY --from=deps /app/node_modules ./node_modules
# Prune first, then generate: pruning drops the Prisma CLI along with the other
# dev dependencies, and would take the generated client with it.
RUN npm prune --omit=dev && npx prisma generate

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini && addgroup -S app && adduser -S app -G app

COPY --chown=app:app package*.json ./
COPY --chown=app:app prisma ./prisma
COPY --chown=app:app prisma.config.ts ./
COPY --from=runtime-deps --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
# Migrations are applied on release, not on boot, so multiple instances cannot race.
CMD ["node", "dist/main"]
