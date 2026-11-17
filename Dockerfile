FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ffmpeg python3 python3-numpy python3-pil python3-opencv ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

ARG UPSTREAM_COMMIT=d58cf5b1d83996bc961694f046335454de599770
RUN git clone --filter=blob:none --no-checkout https://github.com/kaomei/stickman-video-director.git /opt/stickman-video-director \
    && cd /opt/stickman-video-director \
    && git sparse-checkout init --cone \
    && git sparse-checkout set skills/directing-stickman-videos \
    && git checkout ${UPSTREAM_COMMIT} \
    && git show ${UPSTREAM_COMMIT}:LICENSE > /opt/stickman-video-director/LICENSE

WORKDIR /opt/stickman-video-director/skills/directing-stickman-videos
RUN npm ci --omit=dev

WORKDIR /app
COPY server.mjs ./
ENV AUTOPILOT_ROOT=/opt/stickman-video-director/skills/directing-stickman-videos
EXPOSE 10000
CMD ["node", "server.mjs"]
