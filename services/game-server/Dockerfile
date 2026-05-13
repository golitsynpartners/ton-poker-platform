FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/

EXPOSE 3002
CMD ["npx", "tsx", "src/server.ts"]
