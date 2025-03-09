FROM node:20

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --include=dev

COPY . .

CMD ["sh", "-c", "printenv && npx ts-node src/index.ts"]