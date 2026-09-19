/**
 * Plattformsoberoende försäljning. Woo-varumärken går via WooCommerce; egenutvecklade via en standardvy `v_sales`
 * i Supabase (se sql/v_sales.sql). Skills anropar dessa i stället för plattformsspecifika verktyg.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient } from '@supabase/supabase-js';
import { brands, getBrand, brandCard, type Brand } from '../brands.js';
import { WooClient } from '../woo/client.js';
import { resolveRange, round, safeDiv, pct, textResult, errorResult } from '../util.js';

export interface SalesTotals {
  orders: number;
  net_revenue: number;
  gross_revenue: number;
  aov_net: number | null;
  source: string;
}

interface VSalesRow {
  order_id: string;
  created_at: string;
  status: string;
  net_amount: number;
  gross_amount: number;
  currency: string;
  channel: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  customer_hash: string | null;
  is_test: boolean | null;
}

const PAID = ['completed', 'processing', 'paid'];

export async function salesTotals(b: Brand, since: string, until: string): Promise<SalesTotals> {
  if (b.platform === 'woo' && b.woo && b.url) {
    const client = new WooClient({ key: b.key, name: b.name, url: b.url, user: b.woo.user, appPassword: b.woo.appPassword });
    try {
      const { data } = await client.get<{ totals: { net_revenue: number; orders_count: number; total_sales: number } }>('wc-analytics', 'reports/revenue/stats', {
        after: `${since}T00:00:00`,
        before: `${until}T23:59:59`,
        interval: 'month',
        per_page: 1,
      });
      return { orders: data.totals.orders_count, net_revenue: round(data.totals.net_revenue), gross_revenue: round(data.totals.total_sales), aov_net: safeDiv(data.totals.net_revenue, data.totals.orders_count), source: 'wc-analytics' };
    } catch {
      const list = await client.orders(since, until, ['completed', 'processing']);
      const net = list.reduce((a, o) => a + Number(o.total) - Number(o.total_tax) - Number(o.shipping_total), 0);
      const gross = list.reduce((a, o) => a + Number(o.total), 0);
      return { orders: list.length, net_revenue: round(net), gross_revenue: round(gross), aov_net: safeDiv(net, list.length), source: 'woo orders' };
    }
  }
  if (b.platform === 'supabase' && b.supabase) {
    const rows = await vSales(b, since, until);
    const net = rows.reduce((a, r) => a + Number(r.net_amount), 0);
    const gross = rows.reduce((a, r) => a + Number(r.gross_amount), 0);
    return { orders: rows.length, net_revenue: round(net), gross_revenue: round(gross), aov_net: safeDiv(net, rows.length), source: `supabase ${b.supabase.salesView}` };
  }
  throw new Error(`Varumärket "${b.key}" har ingen försäljningskälla konfigurerad (platform=${b.platform}).`);
}

async function vSales(b: Brand, since: string, until: string): Promise<VSalesRow[]> {
  const sb = createClient(b.supabase!.url, b.supabase!.serviceRoleKey, { auth: { persistSession: false } });
  const { data, error } = await sb
    .from(b.supabase!.salesView)
    .select('order_id,created_at,status,net_amount,gross_amount,currency,channel,utm_source,utm_medium,utm_campaign,customer_hash,is_test')
    .gte('created_at', `${since}T00:00:00Z`)
    .lte('created_at', `${until}T23:59:59Z`)
    .in('status', PAID)
    .or('is_test.is.null,is_test.eq.false')
    .limit(50_000);
  if (error) throw new Error(`${b.name}: ${error.message} – finns vyn ${b.supabase!.salesView}? Se sql/v_sales.sql.`);
  return (data ?? []) as VSalesRow[];
}

export function registerSalesTools(server: McpServer): void {
  server.registerTool(
    'brand_list',
    {
      title: 'Varumärkesregister',
      description: 'Alla varumärken med plattform, Meta-konto/pixel/katalog, GA4, Search Console, bruttomarginal, mål-MER och vilka källor som är konfigurerade. Inga hemligheter. Anropa först i varje session.',
      inputSchema: {},
    },
    async () => textResult(brands().map(brandCard)),
  );

  server.registerTool(
    'sales_summary',
    {
      title: 'Försäljning per varumärke (plattformsoberoende)',
      description:
        'Ordrar, nettointäkt, bruttointäkt och AOV för ett varumärke oavsett om det kör WooCommerce eller egen plattform (Supabase v_sales), med jämförelse mot föregående period. För detaljer per kanal/produkt använd woo_* eller supabase_sales_breakdown.',
      inputSchema: { brand: z.string(), since: z.string().optional(), until: z.string().optional() },
    },
    async ({ brand, since, until }) => {
      try {
        const b = getBrand(brand);
        const r = resolveRange(since, until);
        const days = Math.round((Date.parse(r.until) - Date.parse(r.since)) / 86_400_000) + 1;
        const prevUntil = new Date(Date.parse(r.since) - 86_400_000).toISOString().slice(0, 10);
        const prevSince = new Date(Date.parse(prevUntil) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
        const [cur, prev] = await Promise.all([salesTotals(b, r.since, r.until), salesTotals(b, prevSince, prevUntil)]);
        return textResult({
          brand: b.key,
          name: b.name,
          period: r,
          current: cur,
          previous: { period: { since: prevSince, until: prevUntil }, ...prev },
          change_pct: { net_revenue: pct(cur.net_revenue - prev.net_revenue, prev.net_revenue), orders: pct(cur.orders - prev.orders, prev.orders) },
          gross_margin_pct: b.grossMarginPct ?? null,
          contribution_before_ads: b.grossMarginPct !== undefined ? round(cur.net_revenue * (b.grossMarginPct / 100)) : null,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'supabase_sales_breakdown',
    {
      title: 'Egen plattform – försäljning per dag/kanal/kampanj (v_sales)',
      description: 'För varumärken på egen plattform: nettointäkt och ordrar per dag, per kanal/utm_source/medium/kampanj, samt andel återkommande kunder (customer_hash). Kräver vyn v_sales.',
      inputSchema: { brand: z.string(), since: z.string().optional(), until: z.string().optional() },
    },
    async ({ brand, since, until }) => {
      try {
        const b = getBrand(brand);
        if (b.platform !== 'supabase' || !b.supabase) throw new Error(`"${b.key}" är inte ett Supabase-varumärke.`);
        const r = resolveRange(since, until);
        const rows = await vSales(b, r.since, r.until);
        const total = rows.reduce((a, x) => a + Number(x.net_amount), 0);
        const agg = (keyFn: (x: VSalesRow) => string) => {
          const m = new Map<string, { orders: number; net: number }>();
          for (const x of rows) {
            const k = keyFn(x);
            const c = m.get(k) ?? { orders: 0, net: 0 };
            c.orders += 1;
            c.net += Number(x.net_amount);
            m.set(k, c);
          }
          return [...m.entries()].map(([key, v]) => ({ key, orders: v.orders, net_revenue: round(v.net), share_pct: pct(v.net, total) })).sort((a, b2) => b2.net_revenue - a.net_revenue);
        };
        const customers = new Map<string, number>();
        for (const x of rows) if (x.customer_hash) customers.set(x.customer_hash, (customers.get(x.customer_hash) ?? 0) + 1);
        const returning = [...customers.values()].filter((n) => n > 1).length;
        return textResult({
          brand: b.key,
          period: r,
          orders: rows.length,
          net_revenue: round(total),
          by_day: agg((x) => x.created_at.slice(0, 10)).sort((a, b2) => a.key.localeCompare(b2.key)),
          by_channel: agg((x) => x.channel ?? '(okänd)'),
          by_source_medium_campaign: agg((x) => `${x.utm_source ?? '(none)'} / ${x.utm_medium ?? '(none)'} / ${x.utm_campaign ?? '(none)'}`).slice(0, 40),
          unique_customers: customers.size,
          returning_customers: returning,
          returning_share_pct: pct(returning, customers.size),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
