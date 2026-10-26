FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update && apt-get install -y --no-install-recommends tcpdump iproute2 && rm -rf /var/lib/apt/lists/*
WORKDIR /proof
COPY proof.mjs ./proof.mjs
COPY run.sh ./run.sh
ENTRYPOINT ["sh", "/proof/run.sh"]
