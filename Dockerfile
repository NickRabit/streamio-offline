FROM node:22-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci
COPY server server
COPY web web
RUN npm run build

FROM node:22-trixie-slim AS runtime
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data DOWNLOAD_DIR=/downloads
WORKDIR /app
ARG TARGETARCH
# Ovladače Intel QuickSync existují jen pro amd64; na arm64 se image staví bez nich.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libva-drm2 vainfo \
    && if [ "$TARGETARCH" = "amd64" ]; then apt-get install -y --no-install-recommends intel-media-va-driver i965-va-driver; fi \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --workspace=@stremio-offline/server && npm cache clean --force
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/web/dist /app/web
RUN mkdir -p /data /downloads && chown -R node:node /app /data /downloads
USER node
EXPOSE 8080
CMD ["node", "server/dist/index.js"]
