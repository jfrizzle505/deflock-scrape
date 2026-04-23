FROM mcr.microsoft.com/playwright:v1.41.0-jammy

WORKDIR /app

COPY package.json ./
RUN npm install

# Playwright browsers already included in base image
RUN npx playwright install chromium

COPY . .

EXPOSE 3000

CMD ["node", "server.js"]
