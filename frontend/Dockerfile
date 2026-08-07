# frontend/Dockerfile
FROM node:22.18.0
WORKDIR /app
COPY package*.json ./
COPY scripts ./scripts
# `npm ci` (not `install`): installs exactly package-lock.json and fails if the
# lock and package.json disagree, so an image rebuild can't silently drift the
# way the backend's unpinned pip install did.
RUN npm ci
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]
