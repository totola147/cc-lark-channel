FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
RUN npx tsup

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache git
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
COPY config.example.toml ./

ENV CLC_CONFIG=/app/config.toml
EXPOSE 9111

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "process.exit(0)"

ENTRYPOINT ["node", "dist/index.js"]
