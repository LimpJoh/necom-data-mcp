FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# Fast UID/GID så att värdens datamapp kan ägas rätt: chown -R 10001:10001 /opt/necom-data-mcp/data
# openssh-client behövs bara för ops_vps_exec (SSH till värden).
RUN apk add --no-cache curl openssh-client && addgroup -S -g 10001 app && adduser -S -u 10001 -G app app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir -p /app/data && chown -R app:app /app
USER app
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD curl -fsS http://127.0.0.1:3010/health || exit 1
CMD ["node", "dist/index.js"]
