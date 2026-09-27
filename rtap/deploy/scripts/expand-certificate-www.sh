#!/usr/bin/env bash
# ==============================================================================
# RTAP Certificate Expansion Script: add www.strazh.dev to Let's Encrypt Cert
# ==============================================================================
set -euo pipefail

PRIMARY_DOMAIN="strazh.dev"
WWW_DOMAIN="www.strazh.dev"
CERT_DIR="/opt/red_team/rtap/deploy/certs"
KEY_DIR="/opt/red_team/rtap/deploy/private"
LIVE_DIR="/etc/letsencrypt/live/${PRIMARY_DOMAIN}"
COMPOSE_DIR="/opt/red_team/rtap"
WEBROOT_DIR="/opt/red_team/rtap/deploy/certbot"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Expanding certificate for ${PRIMARY_DOMAIN} and ${WWW_DOMAIN}..."

sudo certbot certonly \
    --webroot \
    -w "${WEBROOT_DIR}" \
    -d "${PRIMARY_DOMAIN}" \
    -d "${WWW_DOMAIN}" \
    --expand \
    --non-interactive \
    --agree-tos \
    --preferred-challenges http-01

# Copy into RTAP Nginx mount directories
sudo cp -L "${LIVE_DIR}/fullchain.pem" "${CERT_DIR}/${PRIMARY_DOMAIN}.crt"
sudo cp -L "${LIVE_DIR}/privkey.pem" "${KEY_DIR}/${PRIMARY_DOMAIN}.key"
sudo chmod 644 "${CERT_DIR}/${PRIMARY_DOMAIN}.crt"
sudo chmod 600 "${KEY_DIR}/${PRIMARY_DOMAIN}.key"
sudo chown -R ubuntu:ubuntu "${CERT_DIR}" "${KEY_DIR}"

# Reload Nginx proxy
cd "${COMPOSE_DIR}"
docker compose exec -T nginx nginx -s reload

# Verify renewal dry run
sudo certbot renew --dry-run

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Successfully expanded certificate to include ${WWW_DOMAIN} and verified renewal."
