FROM node:22.22-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
USER node
CMD ["node", "src/main.ts"]
