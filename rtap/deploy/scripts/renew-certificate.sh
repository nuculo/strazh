#!/usr/bin/env bash
# ==============================================================================
# RTAP Automated Let's Encrypt Certificate Renewal Script
# ==============================================================================
set -euo pipefail

CERT_DIR="/opt/red_team/rtap/deploy/certs"
KEY_DIR="/opt/red_team/rtap/deploy/private"
LIVE_DIR="/etc/letsencrypt/live/strazh.dev"
COMPOSE_DIR="/opt/red_team/rtap"
WEBROOT_DIR="/opt/red_team/rtap/deploy/certbot"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Starting certificate renewal check..."

# Run certbot renew using webroot
sudo certbot renew --webroot -w "${WEBROOT_DIR}" --quiet

# Deploy renewed certificates to RTAP Nginx mount points
if [ -f "${LIVE_DIR}/fullchain.pem" ] && [ -f "${LIVE_DIR}/privkey.pem" ]; then
    sudo cp -L "${LIVE_DIR}/fullchain.pem" "${CERT_DIR}/strazh.dev.crt"
    sudo cp -L "${LIVE_DIR}/privkey.pem" "${KEY_DIR}/strazh.dev.key"
    sudo chmod 644 "${CERT_DIR}/strazh.dev.crt"
    sudo chmod 600 "${KEY_DIR}/strazh.dev.key"
    sudo chown -R ubuntu:ubuntu "${CERT_DIR}" "${KEY_DIR}"

    # Reload Nginx inside container
    cd "${COMPOSE_DIR}"
    docker compose exec -T nginx nginx -s reload
    echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Certificate active and Nginx reloaded successfully."
fi
