# Build stage
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production stage
FROM node:20-slim

# Install Python + uv (for uvx) and Docker CLI (for docker stdio MCP servers)
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      curl \
      ca-certificates \
    && curl -fsSL https://get.docker.com | sh \
    && curl -LsSf https://astral.sh/uv/install.sh | UV_INSTALL_DIR=/usr/local/bin sh \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user and add to docker group so it can use Docker socket
RUN groupadd -r mcpuser \
    && useradd -r -g mcpuser -m -s /bin/bash mcpuser \
    && usermod -aG docker mcpuser

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY public ./public

# Transfer ownership to non-root user
RUN chown -R mcpuser:mcpuser /app

USER mcpuser

EXPOSE 3000

CMD ["npm", "start"]
