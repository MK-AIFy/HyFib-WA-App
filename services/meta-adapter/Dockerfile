FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/meta-adapter ./services/meta-adapter

RUN pnpm install --no-frozen-lockfile --filter @hyfib/meta-adapter...
RUN pnpm --filter @hyfib/meta-adapter... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/meta-adapter/package.json ./services/meta-adapter/package.json
COPY --from=build /app/services/meta-adapter/dist ./services/meta-adapter/dist

USER app
CMD ["node", "services/meta-adapter/dist/index.js"]
