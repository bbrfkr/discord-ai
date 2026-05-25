# syntax=docker/dockerfile:1

FROM node:24-alpine

WORKDIR /app

# 依存だけ先に入れてレイヤキャッシュを効かせる。
# tsx / typescript は devDependencies のため NODE_ENV を立てる前にインストールする。
COPY package.json package-lock.json ./
RUN npm ci

# アプリ本体。
COPY tsconfig.json ./
COPY src ./src

# マッピング永続化先（compose で volume をマウントする想定）。
RUN mkdir -p /app/.data

ENV NODE_ENV=production

# Discord bot を起動（tsx で TypeScript を直接実行）。
CMD ["npm", "run", "bot"]
