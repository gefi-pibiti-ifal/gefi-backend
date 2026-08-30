# Build multi-stage. O estagio final ("runtime") e o unico que vai para o
# servidor: sem toolchain de compilacao, sem dependencias de desenvolvimento,
# sem pnpm e sem codigo-fonte -- apenas o dist/, os modulos de producao e o
# Prisma Client ja gerado.
#
#   docker build --target runtime -t gefi-api .
#
# O compose sempre aponta para `target: runtime`.

# ---------------------------------------------------------------------------
# base: raiz comum. openssl e exigido pelos engines do Prisma.
# ---------------------------------------------------------------------------
FROM node:22-slim AS base

ENV PNPM_HOME="/pnpm" \
    PATH="/pnpm:$PATH" \
    CI=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# ---------------------------------------------------------------------------
# deps: dependencias completas (dev incluidas) para compilar o TypeScript.
# python3/make/g++ existem apenas aqui -- o bcrypt precisa deles quando nao ha
# binario pre-compilado para a plataforma. Nada disso chega ao runtime.
# ---------------------------------------------------------------------------
FROM base AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# O schema vem antes do install porque o postinstall do @prisma/client gera o
# client durante a instalacao.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma/

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# build: gera o Prisma Client e compila para dist/.
# ---------------------------------------------------------------------------
FROM deps AS build

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN pnpm exec prisma generate \
    && pnpm run build

# ---------------------------------------------------------------------------
# prod-deps: arvore de modulos so com dependencias de producao, instalada do
# zero (nao e o node_modules do build com dev removidas). Reduz a superficie:
# eslint, jest, o CLI do Nest e afins nunca entram na imagem final.
# ---------------------------------------------------------------------------
FROM base AS prod-deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma/

RUN pnpm install --frozen-lockfile --prod \
    && pnpm exec prisma generate

# ---------------------------------------------------------------------------
# runtime: imagem final.
# ---------------------------------------------------------------------------
FROM node:22-slim AS runtime

# openssl: engines do Prisma. ca-certificates: chamadas TLS de saida para
# OpenAI/Gemini. Sem curl/wget -- o healthcheck usa o proprio node.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# HOME aponta para o tmpfs porque o filesystem roda somente-leitura
# (read_only no compose). CHECKPOINT_DISABLE e PRISMA_HIDE_UPDATE_MESSAGE
# desligam telemetria e checagem de versao do Prisma na inicializacao:
# as duas tentariam escrever em disco e fazer rede na subida do container.
ENV NODE_ENV=production \
    PORT=3000 \
    HOME=/tmp \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=true \
    DISABLE_OPENCOLLECTIVE=true

WORKDIR /app

# O usuario `node` (uid 1000) ja existe na imagem oficial. A aplicacao nunca
# roda como root e nao e dona dos proprios arquivos -- nao consegue se
# sobrescrever em tempo de execucao.
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --from=build     --chown=root:root /app/dist         ./dist
COPY --chown=root:root prisma       ./prisma
COPY --chown=root:root package.json ./
COPY --chown=root:root docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

RUN chmod 755 /usr/local/bin/docker-entrypoint.sh

USER node

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/main"]
