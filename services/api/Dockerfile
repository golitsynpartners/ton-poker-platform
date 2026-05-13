FROM node:20-alpine
WORKDIR /app

COPY package.json ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/

RUN npx tsc && cp src/db/schema.sql dist/db/schema.sql

EXPOSE 10000
CMD ["node", "dist/server.js"]
