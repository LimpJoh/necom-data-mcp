# necom-data-mcp

Egen MCP-server som ger Claude läsåtkomst till NeCom:s butiksdata: **WooCommerce** (Outlets.se, Svenska Barr, Trail Tails, Clubwear.se), **Google Analytics 4** och **Dogshowpro** (Supabase). Alla hemligheter stannar på servern. Claude kopplas in som en *custom connector* med OAuth – du loggar in en gång med serverns lösenord.

Verktyg (alla läsande, ingen persondata):

| Verktyg | Vad |
|---|---|
| `woo_list_stores` | Vilka butiker som finns |
| `woo_sales_summary` | Intäkt, ordrar, AOV, återbetalningar, nya/återkommande kunder, tidsserie, jämförelse med föregående period |
| `woo_orders_attribution` | Varifrån köpen kom enligt WooCommerce Order Attribution (Meta/Google/direkt/e-post), rabattkoder, enhet |
| `woo_top_products` | Toppsäljare (enheter, intäkt, lagerstatus) |
| `woo_orders_list` | Kompakt orderlista utan kundidentitet |
| `ga4_ecommerce_summary` | Sessioner, köp, intäkt, CVR, AOV, kundvagn→köp per dag |
| `ga4_traffic_sources` | Per kanal / källa-medium / kampanj: sessioner, köp, intäkt, CVR |
| `ga4_landing_pages` | Landningssidor och deras konvertering |
| `ga4_report` | Fri GA4-rapport (valfria dimensioner/mätvärden) |
| `dogshowpro_sales_summary` | Anmälningar, betalda, intäkt per dag/klubb/evenemang/källa |
| `dogshowpro_upcoming_events` | Kommande evenemang med fyllnadsgrad |
| `mer_summary` | MER/blended ROAS, blended CPA, break-even, attributionsgap mot Meta |

## 1. Förberedelser

### WooCommerce (per butik)
1. Skapa gärna en egen WordPress-användare med rollen **Butiksansvarig (Shop manager)**, t.ex. `claude-data`.
2. Logga in som den användaren → **Användare → Profil → Applikationslösenord** → namn `necom-data-mcp` → *Lägg till nytt*. Kopiera lösenordet (24 tecken med mellanslag – mellanslagen får vara kvar).
3. För attribution: **WooCommerce → Inställningar → Avancerat → Funktioner → Order Attribution** ska vara på (standard sedan Woo 8.5).
4. Kontrollera att `https://butik.se/wp-json/wc/v3/` svarar (401 utan inloggning är rätt). Om en säkerhetsplugin blockerar REST-API:t eller Application Passwords: vitlista användaren.

### Google Analytics 4
1. I [Google Cloud Console](https://console.cloud.google.com): skapa/välj projekt → **API:er & tjänster → Aktivera API** → *Google Analytics Data API*.
2. **IAM → Servicekonton → Skapa** (`necom-data-mcp`) → **Nycklar → Lägg till nyckel → JSON**. Spara som `data/ga4-service-account.json` på servern.
3. I GA4: **Admin → Egendom → Åtkomsthantering för egendom** → lägg till servicekontots e-post med rollen **Läsare**. Gör detta per property.
4. Property-ID hittar du under **Admin → Egendomsinformation** (numeriskt, inte `G-…`).

### Dogshowpro
Supabase → **Project Settings → API → service_role**. Nyckeln läses bara av servern; verktygen returnerar enbart aggregat.

## 2. Installation på VPS:en

```bash
# Node 20+ krävs (kolla: node -v)
cd /var/www   # eller där dina appar ligger
git clone <repo> necom-data-mcp && cd necom-data-mcp   # eller packa upp zip
cp .env.example .env && nano .env      # fyll i allt
mkdir -p data && chmod 700 data        # lägg ga4-service-account.json här
chmod +x deploy.sh && ./deploy.sh
```

`deploy.sh` installerar, bygger, startar/laddar om under PM2 (`necom-data-mcp`) och kör en hälsokontroll.

Caddy: lägg in blocket från `Caddyfile.snippet`, peka DNS `mcp.necom.se` → VPS:ens IP, `sudo systemctl reload caddy`. Testa `https://mcp.necom.se/health`.

## 3. Koppla in i Claude

1. claude.ai → **Inställningar → Connectors → Lägg till anpassad connector**.
2. Namn: `NeCom Data`. URL: `https://mcp.necom.se/mcp`. Lämna OAuth-fälten tomma (servern stödjer dynamisk registrering).
3. Klicka **Anslut** → du får serverns inloggningssida → ange `MCP_LOGIN_PASSWORD`.
4. Slå på connectorn i chatten (Cowork: kugghjulet/connector-listan). Testa: *"Lista butikerna"*.

Kopplingen överlever omstarter av servern (tokens sparas i `data/oauth-state.json`, refresh token gäller 90 dagar och roterar). Vill du tvinga fram ny inloggning: stoppa appen, radera filen, starta.

## 4. Uppdatera

```bash
cd necom-data-mcp && git pull && ./deploy.sh
```

## 5. Säkerhet

- Endast läsande anrop mot Woo/GA4/Supabase. Inga skrivverktyg finns.
- Servern lyssnar bara på `127.0.0.1`; Caddy sköter TLS.
- Lösenordsförsök begränsas (5 fel → 60 s spärr). Koder är engångs, PKCE krävs, tokens lagras hashade.
- `data/` innehåller nycklar och tokens – ligger i `.gitignore`, ska ha `chmod 700`.
- Vill du begränsa vilka som kan koppla upp sig ytterligare: byt `MCP_LOGIN_PASSWORD` och radera `data/oauth-state.json`.

## 6. Felsökning

| Symptom | Åtgärd |
|---|---|
| `401 invalid_username` från Woo | Fel användarnamn (ska vara WP-login, inte e-post) eller Application Password inte skapat för den användaren |
| `403` från Woo | Användaren saknar behörighet (Shop manager) eller säkerhetsplugin blockerar REST |
| `wc-analytics` fel, orders funkar | WooCommerce Analytics är avstängt eller inte importerat – verktygen faller tillbaka på orderlistan automatiskt |
| GA4 `PERMISSION_DENIED` | Servicekontot saknar Läsare på propertyn, eller Data API ej aktiverat |
| Claude får "session"-fel | Servern startades om – starta en ny chatt eller be Claude ansluta igen |
| Inget attributionsdata | Order Attribution avstängt i Woo, eller ordrar skapade manuellt/POS |

## 7. Utveckling

```bash
npm install
cp .env.example .env
npm run dev          # tsx watch
npm run typecheck
```

Struktur: `src/index.ts` (Express, OAuth-router, `/mcp`), `src/auth/provider.ts` (OAuth-provider), `src/woo/*`, `src/ga4/*`, `src/dogshowpro/*`, `src/mer.ts`. Nya verktyg: registrera i respektive `register*Tools` med `server.registerTool(namn, {description, inputSchema}, handler)`.
