FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/notification-worker ./services/notification-worker

RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @hyfib/notification-worker... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/notification-worker ./services/notification-worker

USER app
CMD ["node", "services/notification-worker/dist/index.js"]
