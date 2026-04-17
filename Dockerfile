FROM node:22-slim

# Install yt-dlp and ffmpeg
RUN apt-get update && apt-get install -y \
    python3 python3-pip ffmpeg curl \
    && pip3 install yt-dlp --break-system-packages \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 8080
CMD ["npm", "start"]
