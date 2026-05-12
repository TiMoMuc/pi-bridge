# --- Builder ---
FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build

# --- Runtime ---
FROM node:22-slim
WORKDIR /app

# Install Python, uv, ffmpeg, Docker CLI for agent tools and sandbox
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-jinja2 \
    ffmpeg \
    curl \
    ca-certificates \
    docker.io \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install uv (Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Expose local bin tools (pi, etc.) installed as npm dependencies
ENV PATH="/app/node_modules/.bin:$PATH"

COPY --from=builder /app/dist ./dist
COPY __blueprint__/ /app/__blueprint__/
COPY system/ /app/system/
COPY code-server/extensions.txt /app/code-server/extensions.txt

# /workspace is bind-mounted from the host (see docker-compose.yml)
VOLUME ["/workspace"]
WORKDIR /workspace

CMD ["node", "/app/dist/bridge.js"]
