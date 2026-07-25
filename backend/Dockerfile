# Stage 1 — compile TypeScript (node:sqlite needs Node 22.12+ / glibc)
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Stage 2 — production runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
# Harmless on 22.13+; required if the image tag resolves to 22.12.x
ENV NODE_OPTIONS=--experimental-sqlite

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data

EXPOSE 3001
CMD ["node", "dist/index.js"]
