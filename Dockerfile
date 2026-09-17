FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html .env.hosted ./
COPY src ./src
COPY public ./public
RUN npm run build:hosted

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=10000 DATA_DIR=/data
COPY --from=build /app/hosted-dist ./hosted-dist
COPY hosted ./hosted
COPY tools/accounts.mjs tools/portal.mjs tools/invite.mjs ./tools/
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 10000
CMD ["node", "tools/portal.mjs"]
