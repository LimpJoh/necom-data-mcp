# Runbook – drift av necom-data-mcp

## Engångsuppsättning (Linus)
1. Lokalt: `ssh-keygen -t ed25519 -f ~/.ssh/necom-deploy -N ""`
2. På VPS:en som root: `bash scripts/bootstrap-vps.sh "$(cat ~/.ssh/necom-deploy.pub)"` (kopiera upp skriptet, eller klistra in innehållet)
3. GitHub → repo → Settings → Secrets and variables → Actions:
   - Secrets: `VPS_HOST` (IP eller värdnamn), `VPS_USER` = `deploy`, `VPS_SSH_KEY` = innehållet i `~/.ssh/necom-deploy` (privat), `VPS_PORT` (bara om inte 22), `ENV_FILE` (hela `.env`, utgå från `.env.example`), `GA4_SERVICE_ACCOUNT_JSON` (hela JSON-filen)
   - Variables (valfritt): `APP_DIR` (default `/var/www/necom-data-mcp`), `PUBLIC_URL` (default `https://mcp.necom.se`)
4. DNS: A-post `mcp.necom.se` → VPS:ens IP (via Hostinger-MCP eller hPanel)
5. Pusha till `main` → workflow "Deploy till VPS" kör typecheck, rsync, skriver hemligheter, bygger, PM2-reload och verifierar `/health`.
6. claude.ai → Connectors → anpassad connector `https://mcp.necom.se/mcp` → logga in med `MCP_LOGIN_PASSWORD`.

## Löpande (Claude via GitHub-MCP)
- Kodändring: commit + push till `main` ⇒ automatisk deploy. Läs körloggen i Actions.
- Ny butik/GA4-property: uppdatera `ENV_FILE`-secreten (Linus) och kör "Deploy till VPS" manuellt (workflow_dispatch) eller pusha.
- Hälsokoll var 30:e minut öppnar ett issue med etikett `health` vid fel och stänger det när servern svarar igen.
- Rotera inloggning: ändra `MCP_LOGIN_PASSWORD` i `ENV_FILE`, deploya, radera `data/oauth-state.json` på servern (`pm2 stop necom-data-mcp && rm data/oauth-state.json && pm2 start necom-data-mcp`).

## Felsökning på servern
```bash
pm2 logs necom-data-mcp --lines 100
pm2 restart necom-data-mcp
curl -s http://127.0.0.1:3010/health
sudo systemctl reload caddy
```
