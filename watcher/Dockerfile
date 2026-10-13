FROM node:22-alpine

RUN apk add --no-cache docker-cli docker-cli-compose unzip zip

WORKDIR /app

COPY watcher.js restore.js world-files.js release-schema.js updater.js update-runner.js health-check.js version.json ./

CMD ["node", "watcher.js"]
