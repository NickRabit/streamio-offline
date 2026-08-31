FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install
COPY server server
COPY web web
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data DOWNLOAD_DIR=/downloads
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY package.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm install --omit=dev --workspace=@stremio-offline/server && npm cache clean --force
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/web/dist /app/web
RUN mkdir -p /data /downloads && chown -R node:node /app /data /downloads
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
