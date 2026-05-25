FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/reporting-service ./services/reporting-service

RUN pnpm install --no-frozen-lockfile --filter @hyfib/reporting-service...
RUN pnpm --filter @hyfib/reporting-service... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/reporting-service/package.json ./services/reporting-service/package.json
COPY --from=build /app/services/reporting-service/dist ./services/reporting-service/dist

USER app
CMD ["node", "services/reporting-service/dist/index.js"]
