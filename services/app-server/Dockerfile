FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services ./services

# Frozen: the shipped image must be built from exactly the committed lockfile.
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hyfib/app-server... build

FROM node:24-alpine
WORKDIR /app
# npm/corepack are build-time tools; this stage only ever runs plain `node`.
# Removing them also removes their bundled dependencies (e.g. node-tar,
# CVE-2026-59873) from the scanned image — nothing here shells out to a
# package manager at runtime.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
  /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn*
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services ./services

USER app
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "services/app-server/dist/main.js"]
