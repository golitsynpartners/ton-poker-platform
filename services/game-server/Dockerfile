FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY services/game-server/package.json ./services/game-server/package.json
COPY packages/game-engine/package.json ./packages/game-engine/package.json
WORKDIR /app/services/game-server
RUN npm install
WORKDIR /app/packages/game-engine
RUN npm install
WORKDIR /app
COPY services/game-server/src/ ./services/game-server/src/
COPY services/api/src/middleware/ ./services/api/src/middleware/
COPY services/api/src/config/ ./services/api/src/config/
COPY packages/ ./packages/
EXPOSE 3002
WORKDIR /app/services/game-server
CMD ["npx", "tsx", "src/server.ts"]
