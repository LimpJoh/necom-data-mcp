#!/usr/bin/env bash
# Körs på VPS:en (av GitHub Actions eller manuellt) från projektmappen.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { echo "Saknar .env (skapas av deploy-workflowen från ENV_FILE-secreten, eller kopiera .env.example)"; exit 1; }
mkdir -p data && chmod 700 data
npm ci --no-audit --no-fund
npx tsc -p tsconfig.json
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save >/dev/null
for i in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:3010/health; then echo; echo "Lokal hälsokontroll OK"; exit 0; fi
  sleep 2
done
echo "Appen svarar inte lokalt – se: pm2 logs necom-data-mcp"; pm2 logs necom-data-mcp --lines 40 --nostream || true
exit 1
