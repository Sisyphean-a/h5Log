# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY packages/app/package.json packages/app/package.json
RUN npm ci
COPY packages ./packages
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
# 服务端产物自包含，运行时不需要 node_modules 与源码。
COPY --from=build --chown=node:node /app/packages/app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "--max-old-space-size=128", "--max-semi-space-size=16", "dist/server/cli.mjs"]
