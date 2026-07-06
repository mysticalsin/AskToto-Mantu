FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV PORT=8420
EXPOSE 8420

CMD ["node", "server.mjs"]
