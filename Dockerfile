# Workzone AI Ads: production image, two targets built from this one file.
#   app     Next.js standalone server. Applies database migrations on start, then serves the web app.
#   worker  Background process (scripts/targeting-worker.ts) and the hourly scheduler (scripts/daily.ts).
# docker-compose.yml builds both. No secrets are baked in: everything comes from .env at run time,
# except the three NEXT_PUBLIC_* names, which Next.js inlines into the browser code at build time.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---------------------------------------------------------------- base
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---------------------------------------------------------------- deps: all dependencies (build + Prisma client)
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma/schema.prisma prisma/schema.prisma
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- prod-deps: runtime dependencies only (worker)
FROM base AS prod-deps
COPY package.json package-lock.json ./
# Then remove what is never used at run time: Next's compiler, TypeScript and the Prisma CLI (pulled in as optional
# peers of @prisma/client), and image libraries for other platforms.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force \
 && rm -rf node_modules/@next/swc-* node_modules/typescript node_modules/prisma node_modules/@prisma/engines \
           node_modules/@prisma/config node_modules/effect node_modules/@img/*musl* node_modules/@img/sharp-wasm32
# Generated Prisma client (normally produced by the postinstall script, skipped above).
COPY --from=deps /app/node_modules/.prisma ./node_modules/.prisma

# ---------------------------------------------------------------- prisma-cli (app: migrations) and tsx (worker), each in its own folder
FROM base AS prisma-cli
WORKDIR /opt/prisma
COPY package-lock.json /tmp/package-lock.json
RUN v=$(node -p "require('/tmp/package-lock.json').packages['node_modules/prisma'].version") \
 && npm init -y >/dev/null && npm install --no-audit --no-fund "prisma@$v" && npm cache clean --force

FROM base AS tsx
WORKDIR /opt/tsx
COPY package-lock.json /tmp/package-lock.json
RUN v=$(node -p "require('/tmp/package-lock.json').packages['node_modules/tsx'].version") \
 && npm init -y >/dev/null && npm install --no-audit --no-fund "tsx@$v" && npm cache clean --force

# Claude Code CLI, so the built-in AI can also run on the installer's own Claude subscription (docs/ai.md).
# Not pinned: the CLI talks to a service that moves on. Pin with --build-arg CLAUDE_CODE_VERSION=x.y.z if needed.
FROM base AS claude-cli
WORKDIR /opt/claude
ARG CLAUDE_CODE_VERSION=latest
RUN npm init -y >/dev/null && npm install --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force

# ---------------------------------------------------------------- build: Next.js standalone output
FROM deps AS build
COPY . .
ARG NEXT_PUBLIC_APP_NAME="Workzone AI Ads"
ARG NEXT_PUBLIC_OPERATOR_NAME=""
ARG NEXT_PUBLIC_OPERATOR_SITE=""
ENV NEXT_OUTPUT=standalone \
    NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME} \
    NEXT_PUBLIC_OPERATOR_NAME=${NEXT_PUBLIC_OPERATOR_NAME} \
    NEXT_PUBLIC_OPERATOR_SITE=${NEXT_PUBLIC_OPERATOR_SITE}
# Image libraries for other platforms (Alpine / WebAssembly) are traced in but never loaded on this image.
RUN npm run build \
 && rm -rf .next/standalone/node_modules/@img/*musl* .next/standalone/node_modules/@img/sharp-wasm32

# ---------------------------------------------------------------- app
FROM base AS app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 PATH=/opt/claude/node_modules/.bin:$PATH
COPY --from=prisma-cli /opt/prisma /opt/prisma
COPY --from=claude-cli /opt/claude /opt/claude
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node prisma ./prisma
# Bundled catalogs (targeting library seed, Vietnam locations). The data/ volume is filled from these on first start.
COPY --chown=node:node data/*.json ./data/
RUN mkdir -p data/uploads data/knowledge data/msg-images logs && chown -R node:node data logs
USER node
EXPOSE 3000
CMD ["sh", "-c", "node /opt/prisma/node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma && exec node server.js"]

# ---------------------------------------------------------------- worker
FROM base AS worker
ENV NODE_ENV=production PATH=/opt/tsx/node_modules/.bin:/opt/claude/node_modules/.bin:$PATH
COPY --from=tsx /opt/tsx /opt/tsx
COPY --from=claude-cli /opt/claude /opt/claude
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts
COPY --chown=node:node data/*.json ./data/
RUN mkdir -p data/uploads data/knowledge data/msg-images logs && chown -R node:node data logs
USER node
CMD ["tsx", "scripts/targeting-worker.ts"]
