FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl docker.io \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/

RUN npm run build

# Runtime data directories (mounted as volumes)
RUN mkdir -p /app/store /app/groups /app/logs

CMD ["node", "/app/dist/index.js"]
