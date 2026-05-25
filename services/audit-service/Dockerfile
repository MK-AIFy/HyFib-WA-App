FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/audit-service ./services/audit-service

RUN pnpm install --no-frozen-lockfile --filter @hyfib/audit-service...
RUN pnpm --filter @hyfib/audit-service... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/audit-service/package.json ./services/audit-service/package.json
COPY --from=build /app/services/audit-service/dist ./services/audit-service/dist

USER app
CMD ["node", "services/audit-service/dist/index.js"]
