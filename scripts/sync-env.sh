#!/usr/bin/env bash
set -euo pipefail

# Configuration
SERVER_HOST="${SERVER_HOST:-dejis-cloud}"
SERVER_USER="${SERVER_USER:-root}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/bufferflow}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_ENV="${REPO_DIR}/.env.production"

# Fallback to .env if .env.production is missing
if [ ! -f "${SOURCE_ENV}" ]; then
  if [ -f "${REPO_DIR}/.env" ]; then
    SOURCE_ENV="${REPO_DIR}/.env"
  else
    echo "Error: Neither ${REPO_DIR}/.env.production nor ${REPO_DIR}/.env found."
    exit 1
  fi
fi

echo "==> Syncing $(basename "${SOURCE_ENV}") to ${SERVER_USER}@${SERVER_HOST}:${DEPLOY_DIR}/.env..."
ssh -o StrictHostKeyChecking=no "${SERVER_USER}@${SERVER_HOST}" \
  "mkdir -p ${DEPLOY_DIR} && cat > ${DEPLOY_DIR}/.env && chmod 600 ${DEPLOY_DIR}/.env" \
  < "${SOURCE_ENV}"

echo "==> Successfully synced to ${SERVER_HOST}:${DEPLOY_DIR}/.env!"
