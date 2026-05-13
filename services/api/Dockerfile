FROM node:20-alpine
WORKDIR /app

# Copy package files and install
COPY package.json ./
COPY services/api/package.json ./services/api/package.json
RUN cd services/api && npm install

# Copy source
COPY services/api/src/ ./services/api/src/
COPY packages/ ./packages/

EXPOSE 3001
WORKDIR /app/services/api
CMD ["npx", "tsx", "src/server.ts"]
