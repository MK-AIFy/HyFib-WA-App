FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/billing-usage-service ./services/billing-usage-service

RUN pnpm install --no-frozen-lockfile --filter @hyfib/billing-usage-service...
RUN pnpm --filter @hyfib/billing-usage-service... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/billing-usage-service/package.json ./services/billing-usage-service/package.json
COPY --from=build /app/services/billing-usage-service/dist ./services/billing-usage-service/dist

USER app
CMD ["node", "services/billing-usage-service/dist/index.js"]
