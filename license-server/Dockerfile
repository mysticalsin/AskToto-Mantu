FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

# Drop root: the node:alpine image ships an unprivileged `node` user. Running the license service as a
# non-root user limits blast radius if the process is ever compromised. /app is owned by node so the
# app can read its own files (it does not write to the image at runtime).
RUN chown -R node:node /app
USER node

ENV PORT=8420
EXPOSE 8420

CMD ["node", "server.mjs"]
