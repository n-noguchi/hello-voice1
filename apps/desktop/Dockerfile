FROM node:22-alpine AS build

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/desktop/package.json apps/desktop/package.json

RUN pnpm install --frozen-lockfile

COPY apps/desktop apps/desktop

RUN pnpm --filter hello-voice1-desktop build

FROM nginx:1.27-alpine

COPY apps/desktop/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/desktop/dist /usr/share/nginx/html

EXPOSE 80
