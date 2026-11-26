FROM node:20-alpine
WORKDIR /relay
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY relay.mjs sign.mjs ./
USER node
CMD ["node", "relay.mjs"]
