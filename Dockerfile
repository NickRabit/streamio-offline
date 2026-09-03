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
# Stamped by the build script and by CI so a running server can say which image it is.
ARG BUILD_TIME=""
ARG GIT_COMMIT=""
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data DOWNLOAD_DIR=/downloads \
    BUILD_TIME=$BUILD_TIME GIT_COMMIT=$GIT_COMMIT
WORKDIR /app
# Ovladače Intel QuickSync existují jen pro amd64; na arm64 se image staví bez nich.
# Architekturu bereme z dpkg, ne z ARG TARGETARCH: ten doplňuje jen BuildKit a klasický
# builder (Container Manager na Synology) ho nechá prázdný, takže by se ovladače
# tiše přeskočily a QuickSync by na NASu nikdy nejel.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libva-drm2 vainfo util-linux \
    && if [ "$(dpkg --print-architecture)" = "amd64" ]; then apt-get install -y --no-install-recommends intel-media-va-driver i965-va-driver; fi \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --omit=dev --workspace=@stremio-offline/server && npm cache clean --force
COPY --from=build /app/server/dist /app/server/dist
COPY --from=build /app/web/dist /app/web
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN mkdir -p /data /downloads && chown -R node:node /app /data /downloads && chmod +x /usr/local/bin/entrypoint.sh
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
