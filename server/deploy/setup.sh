#!/usr/bin/env bash
# One-time VPS setup: Docker, the Compose plugin, and a minimal firewall.
# Run once on a fresh Ubuntu droplet: `sudo ./setup.sh`.
set -euo pipefail

if ! command -v docker &>/dev/null; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
fi

if ! docker compose version &>/dev/null; then
  echo "Docker Compose plugin missing after install -- check the Docker install output above." >&2
  exit 1
fi

# get.docker.com only makes root a docker user; without this, every later
# `docker`/`docker compose` command needs sudo too because the daemon
# socket is root:docker. $SUDO_USER is the account that ran `sudo ./setup.sh`.
if [ -n "${SUDO_USER:-}" ]; then
  usermod -aG docker "$SUDO_USER"
  echo "Added $SUDO_USER to the docker group -- log out and back in (or run 'newgrp docker') before using docker compose without sudo."
fi

echo "Configuring the firewall (22, 80, 443 only)..."
apt-get update -qq
apt-get install -y -qq ufw
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo
echo "Done. Next steps:"
echo "  1. Copy this repo onto the droplet (git clone, or scp/rsync)."
echo "  2. cd server && cp .env.example .env, then fill in real values."
echo "  3. ./deploy/fetch-overpass-extract.sh"
echo "  4. Edit Caddyfile with your real domain."
echo "  5. docker compose up -d --build"
