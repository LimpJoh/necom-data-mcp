# necom-data-mcp

Egen MCP-server som ger Claude läsåtkomst till NeCom:s butiksdata – **WooCommerce**, **Google Analytics 4**, **Search Console**, **Stripe**, **Mollie** och egenutvecklade butiker via **Supabase (`v_sales`)** – plus ett valfritt **ops-lager** för att sätta upp och drifta nya projekt (GitHub, Supabase, DNS, VPS). Alla hemligheter stannar på servern. Claude kopplas in som *custom connector* med OAuth.

Drift: `https://mcp.necom.se/mcp`, Docker Compose på VPS:en (`/opt/necom-data-mcp/app`), Caddy → port 3006.

## Varumärkesregistret

Allt hänger på en nyckel per varumärke i `.env` (`BRANDS=outlets,dogshowpro,…` + `BRAND_<key>_*`, se `.env.example`). Nyckeln kopplar plattform (woo/supabase), Meta-konto/pixel/katalog, GA4, Search Console, betalleverantör, bruttomarginal och mål-MER. Nytt varumärke = ett block i `.env` + `docker compose up -d`.

Egenutvecklade butiker exponerar vyn `v_sales` (mall i `sql/v_sales.sql`) – samma kolumner i alla projekt, så MCP:n behöver en enda adapter.

## Verktyg (läsande)

| Grupp | Verktyg |
|---|---|
| Register | `brand_list` |
| Försäljning (alla plattformar) | `sales_summary`, `mer_summary`, `supabase_sales_breakdown` |
| WooCommerce | `woo_list_stores`, `woo_sales_summary`, `woo_orders_attribution`, `woo_top_products`, `woo_orders_list` |
| GA4 | `ga4_list_properties`, `ga4_ecommerce_summary`, `ga4_traffic_sources`, `ga4_landing_pages`, `ga4_report` |
| Search Console | `gsc_list_sites`, `gsc_search_performance`, `gsc_brand_vs_generic` |
| Betalning | `stripe_payments_summary`, `mollie_payments_summary` |
| Dogshowpro | `dogshowpro_sales_summary`, `dogshowpro_upcoming_events` |

## Produktverktyg (WooCommerce, v1.3)

| Verktyg | Gör |
|---|---|
| `woo_products_audit` | Revision av produkter + varianter: pris saknas, slut i lager men synlig, GTIN saknas/ogiltig (GS1-kontrollsiffra), otillåten HTML i beskrivning, bild/kategori/SKU saknas. Matchar felen i Metas `ads_catalog_get_diagnostics`. |
| `woo_product_get` | Full produktinfo via id eller SKU. |
| `woo_products_update` | **Skrivande.** Batch-rättning (max 100) av pris, lager, GTIN, beskrivning, synlighet, status. Kräver att varumärket har *Tillåt produktändringar* ikryssat i admin (Varumärken → Redigera) **och** `confirm=true` per anrop. Loggas i `data/woo-writes.log`. |

## Ops-lager (skrivande, av som default)

Sätt `OPS_ENABLED=true` och relevanta `OPS_*`-tokens. Alla skrivande anrop kräver `confirm=true` och loggas i `data/ops-audit.log`.

| Verktyg | Gör |
|---|---|
| `ops_status` | Vad som är konfigurerat, SSH-nåbarhet |
| `ops_github_list_repos`, `ops_github_create_repo`, `ops_github_put_file`, `ops_github_workflow_runs` | Repon, startfiler, Actions-status |
| `ops_supabase_list_projects`, `ops_supabase_create_project`, `ops_supabase_run_sql` | Nya projekt, migrationer, `v_sales` |
| `ops_dns_get`, `ops_dns_upsert` | Hostinger DNS |
| `ops_vps_exec`, `ops_vps_free_port`, `ops_caddy_add_site` | Kommandon, portar, Caddy-block på VPS:en |

SSH till värden: skapa användaren `deploy` på VPS:en, lägg den publika nyckeln i `~deploy/.ssh/authorized_keys`, den privata som `/opt/necom-data-mcp/data/ops_ssh_key` (ägare 10001, chmod 600). Ge `deploy` sudo utan lösenord för `systemctl reload caddy`, `caddy validate` och `tee -a /etc/caddy/Caddyfile`. `scripts/bootstrap-vps.sh` gör det mesta.

## Förberedelser per källa

**WooCommerce**: WP-användare med rollen Butiksansvarig → Profil → Applikationslösenord. Order Attribution ska vara på (WooCommerce → Inställningar → Avancerat → Funktioner).

**Google (GA4 + Search Console)**: Cloud-projekt → aktivera *Google Analytics Data API* och *Search Console API* → servicekonto → JSON-nyckel som `data/ga4-service-account.json`. Lägg servicekontots e-post som Läsare i varje GA4-property (Admin → Åtkomsthantering) och som användare i Search Console per sajt (Inställningar → Användare och behörigheter). Property-ID är numeriskt.

**Stripe**: Developers → API keys → *Restricted key* med read på Balance transactions och Charges.

**Mollie**: Dashboard → Developers → Organization access tokens → `payments.read`, `profiles.read`.

**Supabase (egna butiker)**: service_role-nyckel + kör `sql/v_sales.sql` anpassad till projektets tabeller.

## Installation / uppdatering på VPS:en

```bash
# första gången
mkdir -p /opt/necom-data-mcp/data && chown -R 10001:10001 /opt/necom-data-mcp/data
cp .env.example /opt/necom-data-mcp/.env && nano /opt/necom-data-mcp/.env
git clone https://github.com/LimpJoh/necom-data-mcp.git /opt/necom-data-mcp/app
# Caddy-block: se Caddyfile.snippet, sedan: caddy validate && systemctl reload caddy

# varje uppdatering
cd /opt/necom-data-mcp/app && git pull && docker compose up -d --build
curl -s https://mcp.necom.se/health
```

Ändrad `.env`: `docker compose up -d` räcker.

## Koppla in i Claude

claude.ai → Inställningar → Connectors → Lägg till anpassad connector: URL `https://mcp.necom.se/mcp`, OAuth-fälten tomma → Anslut → ange `MCP_LOGIN_PASSWORD`. Slå på connectorn i varje chatt/projekt som ska använda den.

## Säkerhet

- Dataverktygen är läsande; persondata returneras aldrig (aggregat, hashade kund-id).
- Ops-lagret är av som default, kräver `confirm=true` per skrivande anrop, loggar allt, och kör på VPS:en som en begränsad `deploy`-användare.
- Servern lyssnar på 127.0.0.1:3006 bakom Caddy; OAuth med PKCE, engångskoder, hashade tokens, lösenordsspärr efter 5 fel.
- Tvinga ny inloggning: stoppa containern, radera `data/oauth-state.json`, starta.

## Felsökning

| Symptom | Åtgärd |
|---|---|
| `invalid_client` vid inloggning | `data/` inte skrivbar: `chown -R 10001:10001 /opt/necom-data-mcp/data` |
| `401 invalid_username` från Woo | Fel WP-användarnamn eller Application Password saknas |
| `wc-analytics` fel | WooCommerce Analytics av – verktygen faller tillbaka på orderlistan |
| GA4/GSC `PERMISSION_DENIED` | Servicekontot saknar behörighet eller API:t är inte aktiverat |
| Claude får "session"-fel | Servern startades om – ny chatt |

## Utveckling

`npm install && cp .env.example .env && npm run dev` · `npm run typecheck`. Nya verktyg registreras i respektive `register*Tools`.
