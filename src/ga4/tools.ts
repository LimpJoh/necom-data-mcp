import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { existsSync } from 'node:fs';
import { config, ga4Properties } from '../config.js';
import { listeners } from '../store.js';
import { resolveRange, round, safeDiv, pct, textResult, errorResult } from '../util.js';

let client: BetaAnalyticsDataClient | null = null;
listeners.push(() => {
  client = null;
});
export function ga4Configured(): boolean {
  return Boolean(config.ga4Credentials) && existsSync(config.ga4Credentials);
}
function ga(): BetaAnalyticsDataClient {
  if (!ga4Configured()) throw new Error('GA4 är inte konfigurerat – ladda upp servicekontots JSON i admin (Inställningar).');
  if (!client) client = new BetaAnalyticsDataClient({ keyFilename: config.ga4Credentials });
  return client;
}

function propertyId(key: string): string {
  const props = ga4Properties();
  const id = props[key] ?? (/^\d+$/.test(key) ? key : undefined);
  if (!id) throw new Error(`Okänd GA4-property "${key}". Tillgängliga: ${Object.keys(props).join(', ') || '(inga)'} eller ett numeriskt property-ID.`);
  return `properties/${id}`;
}

const propertyParam = z.string().describe('Butiksnyckel (t.ex. "outlets", "dogshowpro") eller numeriskt GA4 property-ID.');
const sinceParam = z.string().optional().describe('Startdatum YYYY-MM-DD eller relativt ("7d", "30d"). Default 30d.');
const untilParam = z.string().optional().describe('Slutdatum YYYY-MM-DD. Default idag.');

export async function runReport(property: string, since: string, until: string, dimensions: string[], metrics: string[], limit = 50, orderByMetric?: string) {
  const [res] = await ga().runReport({
    property: propertyId(property),
    dateRanges: [{ startDate: since, endDate: until }],
    dimensions: dimensions.map((name) => ({ name })),
    metrics: metrics.map((name) => ({ name })),
    limit,
    orderBys: orderByMetric ? [{ metric: { metricName: orderByMetric }, desc: true }] : undefined,
  });
  const rows = (res.rows ?? []).map((r) => {
    const o: Record<string, string | number> = {};
    dimensions.forEach((d, i) => (o[d] = r.dimensionValues?.[i]?.value ?? ''));
    metrics.forEach((m, i) => (o[m] = Number(r.metricValues?.[i]?.value ?? 0)));
    return o;
  });
  const totals: Record<string, number> = {};
  metrics.forEach((m, i) => (totals[m] = Number(res.totals?.[0]?.metricValues?.[i]?.value ?? 0)));
  return { rows, totals, row_count: res.rowCount ?? rows.length };
}

export function registerGa4Tools(server: McpServer): void {
  server.registerTool(
    'ga4_list_properties',
    { title: 'Lista GA4-properties', description: 'Visar vilka GA4-properties servern känner till och deras nycklar.', inputSchema: {} },
    async () => textResult(Object.entries(ga4Properties()).map(([key, id]) => ({ key, property_id: id }))),
  );

  server.registerTool(
    'ga4_ecommerce_summary',
    {
      title: 'GA4 e-handelssammanfattning',
      description:
        'Sessioner, användare, köp, intäkt, konverteringsgrad, AOV och kundvagnsövergivande för perioden, per dag. Använd för att se hur trafik och konvertering utvecklas oberoende av Meta-attribution.',
      inputSchema: { property: propertyParam, since: sinceParam, until: untilParam },
    },
    async ({ property, since, until }) => {
      try {
        const r = resolveRange(since, until);
        const metrics = ['sessions', 'totalUsers', 'newUsers', 'ecommercePurchases', 'purchaseRevenue', 'addToCarts', 'checkouts', 'engagementRate', 'averageSessionDuration'];
        const byDay = await runReport(property, r.since, r.until, ['date'], metrics, 400);
        byDay.rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
        const t = byDay.totals;
        return textResult({
          property,
          period: r,
          totals: {
            sessions: t.sessions,
            users: t.totalUsers,
            new_users: t.newUsers,
            purchases: t.ecommercePurchases,
            revenue: round(t.purchaseRevenue),
            conversion_rate_pct: pct(t.ecommercePurchases, t.sessions),
            aov: safeDiv(t.purchaseRevenue, t.ecommercePurchases),
            add_to_carts: t.addToCarts,
            checkouts: t.checkouts,
            cart_to_purchase_pct: pct(t.ecommercePurchases, t.addToCarts),
            engagement_rate_pct: round(t.engagementRate * 100),
            avg_session_seconds: round(t.averageSessionDuration, 0),
          },
          by_day: byDay.rows.map((x) => ({ date: x.date, sessions: x.sessions, purchases: x.ecommercePurchases, revenue: round(Number(x.purchaseRevenue)), cvr_pct: pct(Number(x.ecommercePurchases), Number(x.sessions)) })),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ga4_traffic_sources',
    {
      title: 'GA4 trafikkällor och konvertering per kanal',
      description:
        'Sessioner, köp, intäkt och konverteringsgrad per kanalgrupp och per källa/medium/kampanj. Visar bl.a. hur Paid Social (Meta) konverterar jämfört med Organic, Direct, Email och Paid Search enligt GA4.',
      inputSchema: {
        property: propertyParam,
        since: sinceParam,
        until: untilParam,
        detail: z.enum(['channel', 'source_medium', 'campaign']).optional().describe('channel = sessionDefaultChannelGroup (default), source_medium = sessionSource/sessionMedium, campaign = sessionCampaignName'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ property, since, until, detail, limit }) => {
      try {
        const r = resolveRange(since, until);
        const dims = detail === 'source_medium' ? ['sessionSource', 'sessionMedium'] : detail === 'campaign' ? ['sessionSource', 'sessionCampaignName'] : ['sessionDefaultChannelGroup'];
        const res = await runReport(property, r.since, r.until, dims, ['sessions', 'totalUsers', 'ecommercePurchases', 'purchaseRevenue', 'engagementRate'], limit ?? 50, 'sessions');
        return textResult({
          property,
          period: r,
          totals: { sessions: res.totals.sessions, purchases: res.totals.ecommercePurchases, revenue: round(res.totals.purchaseRevenue) },
          rows: res.rows.map((x) => ({
            ...Object.fromEntries(dims.map((d) => [d, x[d]])),
            sessions: x.sessions,
            users: x.totalUsers,
            purchases: x.ecommercePurchases,
            revenue: round(Number(x.purchaseRevenue)),
            cvr_pct: pct(Number(x.ecommercePurchases), Number(x.sessions)),
            revenue_per_session: safeDiv(Number(x.purchaseRevenue), Number(x.sessions)),
            engagement_rate_pct: round(Number(x.engagementRate) * 100),
            share_of_sessions_pct: pct(Number(x.sessions), res.totals.sessions),
          })),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ga4_landing_pages',
    {
      title: 'GA4 landningssidor',
      description: 'Vilka landningssidor får trafik och hur konverterar de. Bra för att välja/utvärdera landningssidor till annonser.',
      inputSchema: { property: propertyParam, since: sinceParam, until: untilParam, limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ property, since, until, limit }) => {
      try {
        const r = resolveRange(since, until);
        const res = await runReport(property, r.since, r.until, ['landingPagePlusQueryString'], ['sessions', 'ecommercePurchases', 'purchaseRevenue', 'bounceRate'], limit ?? 30, 'sessions');
        return textResult({
          property,
          period: r,
          rows: res.rows.map((x) => ({ landing_page: x.landingPagePlusQueryString, sessions: x.sessions, purchases: x.ecommercePurchases, revenue: round(Number(x.purchaseRevenue)), cvr_pct: pct(Number(x.ecommercePurchases), Number(x.sessions)), bounce_rate_pct: round(Number(x.bounceRate) * 100) })),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ga4_report',
    {
      title: 'GA4 fri rapport',
      description:
        'Kör en valfri GA4 Data API-rapport med angivna dimensioner och mätvärden (API-namn, t.ex. dimensions ["date","deviceCategory"], metrics ["sessions","ecommercePurchases"]). Använd när de färdiga verktygen inte räcker.',
      inputSchema: {
        property: propertyParam,
        since: sinceParam,
        until: untilParam,
        dimensions: z.array(z.string()).max(6),
        metrics: z.array(z.string()).min(1).max(10),
        limit: z.number().int().min(1).max(1000).optional(),
        order_by_metric: z.string().optional(),
      },
    },
    async ({ property, since, until, dimensions, metrics, limit, order_by_metric }) => {
      try {
        const r = resolveRange(since, until);
        const res = await runReport(property, r.since, r.until, dimensions, metrics, limit ?? 100, order_by_metric);
        return textResult({ property, period: r, ...res });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
