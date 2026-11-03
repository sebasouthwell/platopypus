# Local test image: the same Ubuntu 24.04 + install.sh the EC2 box uses, minus systemd/nginx/Tailscale.
# Runs as root with the whole filesystem as the Files root, mirroring the box.
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
COPY install.sh /tmp/porthole-src/install.sh
COPY server/package.json /tmp/porthole-src/server/package.json
COPY scripts /tmp/porthole-src/scripts
COPY web /tmp/porthole-src/web
COPY bin /tmp/porthole-src/bin
COPY deploy /tmp/porthole-src/deploy
COPY docs /tmp/porthole-src/docs
COPY package.json /tmp/porthole-src/package.json

# Tools + dependencies first so code changes don't redo the slow layers.
RUN apt-get update -q && apt-get install -y -q --no-install-recommends rsync \
 && MODE=docker PORTHOLE_USER=root PORTHOLE_SRC=/tmp/porthole-src bash /tmp/porthole-src/install.sh \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Now the server code.
COPY server /opt/porthole/server

USER root
WORKDIR /opt/porthole/server
ENV HOME=/root \
    PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin \
    LANG=C.UTF-8 \
    PORTHOLE_BIND=0.0.0.0 \
    PORTHOLE_PORT=7331 \
    PORTHOLE_ROOT=/ \
    PORTHOLE_INSECURE_COOKIE=1
EXPOSE 7331
CMD ["node", "server.js"]
