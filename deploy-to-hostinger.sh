#!/bin/bash
# deploy-to-hostinger.sh
# Run this script locally to deploy vipgrant.com to Hostinger
# Usage: bash deploy-to-hostinger.sh <your-domain>
# Example: bash deploy-to-hostinger.sh vipgrant.com

set -e

DOMAIN="${1:-vipgrant.com}"
API_TOKEN="Cs02KCbRziQxDvr8TifLQ14PgyAfqKFNEsmaXu9sadb9c0e5"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARCHIVE_NAME="vipgrant_$(date +%Y%m%d_%H%M%S).zip"
ARCHIVE_PATH="/tmp/$ARCHIVE_NAME"

echo "=== VIPGrant.com Hostinger Deployment ==="
echo "Domain: $DOMAIN"
echo ""

# Check dependencies
if ! command -v npx &>/dev/null; then
  echo "ERROR: npx not found. Install Node.js first: https://nodejs.org"
  exit 1
fi
if ! command -v zip &>/dev/null; then
  echo "ERROR: zip not found. Install with: brew install zip (Mac) or apt install zip (Linux)"
  exit 1
fi

# Step 1: Create archive
echo "1. Creating archive..."
cd "$SCRIPT_DIR"
zip -r "$ARCHIVE_PATH" index.html landing-pages/ -x "*.DS_Store" -x "__MACOSX/*"
echo "   Archive created: $ARCHIVE_PATH ($(du -sh "$ARCHIVE_PATH" | cut -f1))"

# Step 2: List websites to confirm domain exists
echo ""
echo "2. Checking Hostinger account..."
LIST_RESULT=$(printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"deploy","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hosting_listWebsitesV1","arguments":{}}}' \
  | API_TOKEN="$API_TOKEN" npx hostinger-api-mcp@latest --stdio 2>/dev/null | grep '"id":2')

echo "   Account response: $LIST_RESULT"

# Step 3: Deploy
echo ""
echo "3. Deploying static website to Hostinger..."
DEPLOY_ARGS=$(printf '{"domain":"%s","archivePath":"%s","removeArchive":false}' "$DOMAIN" "$ARCHIVE_PATH")
DEPLOY_CALL=$(printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"hosting_deployStaticWebsite","arguments":%s}}' "$DEPLOY_ARGS")

DEPLOY_RESULT=$(printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"deploy","version":"1.0"}}}' \
  "$DEPLOY_CALL" \
  | API_TOKEN="$API_TOKEN" npx hostinger-api-mcp@latest --stdio 2>/dev/null | grep '"id":2')

echo "   Deploy result: $DEPLOY_RESULT"

if echo "$DEPLOY_RESULT" | grep -q '"isError":true'; then
  echo ""
  echo "ERROR: Deployment failed. Check the result above."
  echo ""
  echo "Manual fallback:"
  echo "  1. Log into hPanel: https://hpanel.hostinger.com"
  echo "  2. Go to File Manager > public_html/"
  echo "  3. Upload the zip: $ARCHIVE_PATH"
  echo "  4. Extract it there"
  exit 1
fi

echo ""
echo "=== Deployment complete! ==="
echo "Visit: https://$DOMAIN"
echo "Test a landing page: https://$DOMAIN/landing-pages/cleaning-service.html"
