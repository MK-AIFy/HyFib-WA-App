FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/campaign-service ./services/campaign-service

RUN pnpm install --no-frozen-lockfile --filter @hyfib/campaign-service...
RUN pnpm --filter @hyfib/campaign-service... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/campaign-service/package.json ./services/campaign-service/package.json
COPY --from=build /app/services/campaign-service/dist ./services/campaign-service/dist

USER app
CMD ["node", "services/campaign-service/dist/index.js"]
