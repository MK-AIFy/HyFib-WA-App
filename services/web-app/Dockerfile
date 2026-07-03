# Build the static Vite bundle, then serve it from nginx. No API proxy is
# needed here: the edge nginx (infra/nginx/nginx.conf) already routes /api/
# and /auth/ to the api-gateway before the catch-all reaches this container.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/web-app ./services/web-app

RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @hyfib/web-app... build

FROM nginx:1.27-alpine
COPY services/web-app/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/services/web-app/dist /usr/share/nginx/html
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null 2>&1 || exit 1
