FROM node:20-alpine
WORKDIR /app
# Copy root and service package files
COPY package.json ./
COPY services/api/package.json ./services/api/package.json
COPY packages/ton-sdk/ ./packages/ton-sdk/
# Install API dependencies
WORKDIR /app/services/api
RUN npm install
# Copy all source
WORKDIR /app
COPY services/api/src/ ./services/api/src/
COPY packages/ ./packages/
EXPOSE 3001
WORKDIR /app/services/api
CMD ["npx", "tsx", "src/server.ts"]
