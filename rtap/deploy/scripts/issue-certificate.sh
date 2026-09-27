#!/usr/bin/env bash
# ==============================================================================
# RTAP Initial Let's Encrypt Certificate Issuance Script
# ==============================================================================
set -euo pipefail

DOMAIN="strazh.dev"
CERT_DIR="/opt/red_team/rtap/deploy/certs"
KEY_DIR="/opt/red_team/rtap/deploy/private"
LIVE_DIR="/etc/letsencrypt/live/${DOMAIN}"
COMPOSE_DIR="/opt/red_team/rtap"
WEBROOT_DIR="/opt/red_team/rtap/deploy/certbot"
EMAIL="${1:-}"

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Checking prerequisites for ${DOMAIN}..."

# Ensure certbot is installed
if ! command -v certbot >/dev/null 2>&1; then
    echo "Installing certbot via apt..."
    sudo apt-get update -qq
    sudo apt-get install -y certbot
fi

# Ensure webroot directory exists with correct permissions
mkdir -p "${WEBROOT_DIR}"
chmod 755 "${WEBROOT_DIR}"

# Build registration flags
REG_FLAG="--register-unsafely-without-email"
if [ -n "${EMAIL}" ]; then
    REG_FLAG="--email ${EMAIL}"
fi

# Request certificate via HTTP-01 webroot
echo "Requesting Let's Encrypt certificate for ${DOMAIN}..."
sudo certbot certonly \
    --webroot \
    -w "${WEBROOT_DIR}" \
    -d "${DOMAIN}" \
    --non-interactive \
    --agree-tos \
    ${REG_FLAG} \
    --preferred-challenges http-01

# Copy into RTAP Nginx mount directories
echo "Deploying issued certificate into ${CERT_DIR} and ${KEY_DIR}..."
sudo cp -L "${LIVE_DIR}/fullchain.pem" "${CERT_DIR}/${DOMAIN}.crt"
sudo cp -L "${LIVE_DIR}/privkey.pem" "${KEY_DIR}/${DOMAIN}.key"
sudo chmod 644 "${CERT_DIR}/${DOMAIN}.crt"
sudo chmod 600 "${KEY_DIR}/${DOMAIN}.key"
sudo chown -R ubuntu:ubuntu "${CERT_DIR}" "${KEY_DIR}"

# Reload Nginx
echo "Reloading Nginx proxy..."
cd "${COMPOSE_DIR}"
docker compose exec -T nginx nginx -s reload

# Verify renewal dry run
echo "Testing certificate renewal dry-run..."
sudo certbot renew --dry-run

# Install daily renewal cron job if not already present
CRON_JOB="0 3 * * * /opt/red_team/rtap/deploy/scripts/renew-certificate.sh >> /var/log/rtap-cert-renew.log 2>&1"
(sudo crontab -l 2>/dev/null | grep -F "renew-certificate.sh") || (sudo crontab -l 2>/dev/null; echo "${CRON_JOB}") | sudo crontab -

echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] Let's Encrypt certificate issued, deployed, and renewal dry-run verified successfully."
