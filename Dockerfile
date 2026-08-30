FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# pnpm via corepack: a versao vem do campo "packageManager" do package.json
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma/

# --frozen-lockfile falha se o lockfile estiver dessincronizado do package.json
RUN pnpm install --frozen-lockfile

COPY . .

RUN pnpm exec prisma generate
RUN pnpm run build

EXPOSE 3000

CMD ["sh", "-c", "pnpm exec prisma migrate deploy && pnpm run start:prod"]
