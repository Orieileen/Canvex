# frontend/Dockerfile
FROM node:22.18.0
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
RUN npm install
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]
