/**
 * Google Search Console via Search Analytics API (REST). Samma servicekonto som GA4;
 * lägg till servicekontots e-post som "Fullständig"/"Begränsad" användare i Search Console per sajt.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GoogleAuth } from 'google-auth-library';
import { existsSync } from 'node:fs';
import { config } from '../config.js';
import { listeners } from '../store.js';
import { brands, getBrand } from '../brands.js';
import { resolveRange, round, pct, textResult, errorResult } from '../util.js';

let auth: GoogleAuth | null = null;
listeners.push(() => {
  auth = null;
});
export function gscConfigured(): boolean {
  return Boolean(config.ga4Credentials) && existsSync(config.ga4Credentials);
}
function gauth(): GoogleAuth {
  if (!gscConfigured()) throw new Error('Search Console är inte konfigurerat – ladda upp servicekontots JSON i admin (Inställningar).');
  if (!auth) auth = new GoogleAuth({ keyFilename: config.ga4Credentials, scopes: ['https://www.googleapis.com/auth/webmasters.readonly'] });
  return auth;
}

function siteFor(brandOrSite: string): string {
  if (brandOrSite.startsWith('sc-domain:') || brandOrSite.startsWith('http')) return brandOrSite;
  const b = getBrand(brandOrSite);
  if (!b.gscSite) throw new Error(`Varumärket "${b.key}" saknar BRAND_${b.key}_GSC_SITE (t.ex. sc-domain:${b.url?.replace(/^https?:\/\//, '') ?? 'exempel.se'}).`);
  return b.gscSite;
}

interface GscRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export async function gscQuery(site: string, body: Record<string, unknown>): Promise<GscRow[]> {
  const client = await gauth().getClient();
  const url = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`;
  const res = await client.request<{ rows?: GscRow[] }>({ url, method: 'POST', data: body });
  return res.data.rows ?? [];
}

const brandParam = z.string().describe('Varumärkesnyckel (t.ex. "outlets") eller Search Console-sajt (sc-domain:outlets.se / https://outlets.se/).');
const sinceParam = z.string().optional().describe('Startdatum YYYY-MM-DD eller relativt ("28d"). Default 28d. OBS: GSC-data släpar 2–3 dagar.');
const untilParam = z.string().optional();

export function registerGscTools(server: McpServer): void {
  server.registerTool(
    'gsc_list_sites',
    { title: 'Search Console – sajter per varumärke', description: 'Visar vilka varumärken som har en Search Console-sajt konfigurerad.', inputSchema: {} },
    async () => textResult(brands().map((b) => ({ key: b.key, gsc_site: b.gscSite ?? null }))),
  );

  server.registerTool(
    'gsc_search_performance',
    {
      title: 'Search Console – organisk sökprestanda',
      description:
        'Klick, visningar, CTR och snittposition från Google-sök, totalt och per dimension (query, page, country, device, date). Använd för att se organisk efterfrågan, vilka produkter/sidor folk söker efter, och om Meta-annonsering ger lyft i varumärkessökningar.',
      inputSchema: {
        brand: brandParam,
        since: sinceParam,
        until: untilParam,
        dimension: z.enum(['query', 'page', 'country', 'device', 'date']).optional().describe('Default query.'),
        limit: z.number().int().min(1).max(1000).optional().describe('Default 50.'),
        filter_contains: z.string().optional().describe('Filtrera query/page som innehåller texten, t.ex. varumärkesnamnet för brand search.'),
      },
    },
    async ({ brand, since, until, dimension, limit, filter_contains }) => {
      try {
        const site = siteFor(brand);
        const r = resolveRange(since ?? '28d', until);
        const dim = dimension ?? 'query';
        const body: Record<string, unknown> = { startDate: r.since, endDate: r.until, dimensions: [dim], rowLimit: limit ?? 50, dataState: 'all' };
        if (filter_contains && (dim === 'query' || dim === 'page')) {
          body.dimensionFilterGroups = [{ filters: [{ dimension: dim, operator: 'contains', expression: filter_contains }] }];
        }
        const [rows, totals] = await Promise.all([gscQuery(site, body), gscQuery(site, { startDate: r.since, endDate: r.until, dataState: 'all' })]);
        const t = totals[0];
        const out = rows.map((x) => ({ [dim]: x.keys[0], clicks: x.clicks, impressions: x.impressions, ctr_pct: round(x.ctr * 100), position: round(x.position, 1) }));
        if (dim === 'date') out.sort((a, b) => String(a.date).localeCompare(String(b.date)));
        return textResult({
          site,
          period: r,
          totals: t ? { clicks: t.clicks, impressions: t.impressions, ctr_pct: round(t.ctr * 100), position: round(t.position, 1) } : null,
          rows: out,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'gsc_brand_vs_generic',
    {
      title: 'Search Console – varumärkessök vs generiskt',
      description: 'Delar upp sökklick i varumärkessökningar (innehåller varumärkesnamnet) och generiska, per period. Ett lyft i varumärkessök efter en Meta-kampanj är en indikation på inkrementell effekt som Metas attribution inte visar.',
      inputSchema: { brand: brandParam, brand_terms: z.array(z.string()).min(1).describe('Ord som identifierar varumärket, t.ex. ["outlets", "outlets.se"]'), since: sinceParam, until: untilParam },
    },
    async ({ brand, brand_terms, since, until }) => {
      try {
        const site = siteFor(brand);
        const r = resolveRange(since ?? '28d', until);
        const rows = await gscQuery(site, { startDate: r.since, endDate: r.until, dimensions: ['query', 'date'], rowLimit: 25000, dataState: 'all' });
        const terms = brand_terms.map((t) => t.toLowerCase());
        const byDate = new Map<string, { brand: number; generic: number }>();
        let brandClicks = 0;
        let genericClicks = 0;
        for (const x of rows) {
          const q = x.keys[0].toLowerCase();
          const isBrand = terms.some((t) => q.includes(t));
          const d = byDate.get(x.keys[1]) ?? { brand: 0, generic: 0 };
          if (isBrand) {
            d.brand += x.clicks;
            brandClicks += x.clicks;
          } else {
            d.generic += x.clicks;
            genericClicks += x.clicks;
          }
          byDate.set(x.keys[1], d);
        }
        return textResult({
          site,
          period: r,
          brand_clicks: brandClicks,
          generic_clicks: genericClicks,
          brand_share_pct: pct(brandClicks, brandClicks + genericClicks),
          by_date: [...byDate.entries()].sort().map(([date, v]) => ({ date, ...v })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
