FROM node:20-alpine

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

# App source.
COPY server.js ./

# Credentials and config are injected at runtime via environment variables
# (docker run --env-file .env ...), never baked into the image.
ENV PORT=8080
EXPOSE 8080

# Drop root.
USER node

CMD ["node", "server.js"]
