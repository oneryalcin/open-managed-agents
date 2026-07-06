# Appliance image (plan 0115): one container, one volume, first boot prints
# the initial API key in the logs. No build step - Node runs the TypeScript
# source via --experimental-transform-types.
FROM node:24-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY bin ./bin
COPY scripts ./scripts
# The operator console, served by the same process at /console (plan 0120).
COPY ui ./ui

ENV OMA_HOME=/data \
    OMA_HOST=0.0.0.0 \
    NODE_ENV=production

VOLUME /data
EXPOSE 4180

CMD ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning", "src/main.ts"]
