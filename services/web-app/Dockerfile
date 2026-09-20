# Build the static Vite bundle, then serve it from nginx. No API proxy is
# needed here: the edge nginx (infra/nginx/nginx.conf) already routes /api/
# and /auth/ to the api-gateway before the catch-all reaches this container.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

# The full services tree is copied (not just web-app) because a frozen install
# verifies the lockfile against every workspace project; only the built dist
# reaches the nginx stage, so the final image is unaffected.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services ./services

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @hyfib/web-app... build

# Track nginx's stable branch (bugfix/security-only) instead of a minor-pinned tag:
# nginx:1.27-alpine stopped being rebuilt in 2025-04 and froze on Alpine 3.21.3 with
# unfixable OpenSSL CRITICALs (CVE-2026-31789). The CD workflow's Trivy gate scans
# the published image, so a regression on this moving tag is caught, not shipped.
FROM nginx:stable-alpine
COPY services/web-app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/services/web-app/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
