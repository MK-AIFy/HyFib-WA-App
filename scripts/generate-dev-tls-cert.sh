#!/usr/bin/env bash
# Generates a self-signed TLS certificate for the edge proxy so the stack can
# be brought up over HTTPS locally. DO NOT use these certificates in
# production — provision a CA-signed certificate instead.
set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/infra/nginx/certs"
COMMON_NAME="${1:-localhost}"

mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/server.crt" ] && [ -f "$CERT_DIR/server.key" ]; then
  echo "Certificate already exists at $CERT_DIR/server.crt — leaving it untouched."
  exit 0
fi

openssl req -x509 -nodes -newkey rsa:2048 \
  -keyout "$CERT_DIR/server.key" \
  -out "$CERT_DIR/server.crt" \
  -days 365 \
  -subj "/CN=${COMMON_NAME}" \
  -addext "subjectAltName=DNS:${COMMON_NAME},DNS:localhost,IP:127.0.0.1"

chmod 600 "$CERT_DIR/server.key"
echo "Self-signed certificate written to $CERT_DIR (CN=${COMMON_NAME})."
