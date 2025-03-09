FROM node:20

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install --include=dev

COPY . .

CMD ["sh", "-c", "echo OPENAI_API_KEY=$OPENAI_API_KEY && npx ts-node src/index.ts"]