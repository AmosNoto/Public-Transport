# Afterglow: one container serving the API, the live stream and the built client.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=8787 CACHE_DIR=/data/cache
# Downloaded timetables, built city indexes and basemap tiles live here; keep it on a volume.
VOLUME /data
EXPOSE 8787
CMD ["npx", "tsx", "server/src/index.ts", "--production"]
