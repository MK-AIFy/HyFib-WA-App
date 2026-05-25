FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/auth-service ./services/auth-service

RUN pnpm install --no-frozen-lockfile --filter @hyfib/auth-service...
RUN pnpm --filter @hyfib/auth-service... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/auth-service/package.json ./services/auth-service/package.json
COPY --from=build /app/services/auth-service/dist ./services/auth-service/dist

USER app
CMD ["node", "services/auth-service/dist/index.js"]
