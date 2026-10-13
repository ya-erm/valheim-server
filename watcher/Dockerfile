FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose unzip zip

WORKDIR /app

COPY watcher.js restore.js world-files.js .

CMD ["node", "watcher.js"]
