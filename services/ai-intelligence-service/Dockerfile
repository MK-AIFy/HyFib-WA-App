FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/ai-intelligence-service ./services/ai-intelligence-service

RUN pnpm install --no-frozen-lockfile --filter @hyfib/ai-intelligence-service...
RUN pnpm --filter @hyfib/ai-intelligence-service... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/ai-intelligence-service/package.json ./services/ai-intelligence-service/package.json
COPY --from=build /app/services/ai-intelligence-service/dist ./services/ai-intelligence-service/dist

USER app
CMD ["node", "services/ai-intelligence-service/dist/index.js"]
