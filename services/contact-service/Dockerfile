FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/contact-service ./services/contact-service

RUN pnpm install --no-frozen-lockfile --filter @hyfib/contact-service...
RUN pnpm --filter @hyfib/contact-service... build

FROM node:24-alpine
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/services/contact-service/package.json ./services/contact-service/package.json
COPY --from=build /app/services/contact-service/dist ./services/contact-service/dist

USER app
CMD ["node", "services/contact-service/dist/index.js"]
