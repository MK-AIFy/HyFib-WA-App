FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/web-portal ./services/web-portal

RUN pnpm install --no-frozen-lockfile --filter @hyfib/web-portal...
RUN pnpm --filter @hyfib/web-portal... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/web-portal/package.json ./services/web-portal/package.json
COPY --from=build /app/services/web-portal/dist ./services/web-portal/dist

USER app
CMD ["node", "services/web-portal/dist/index.js"]
