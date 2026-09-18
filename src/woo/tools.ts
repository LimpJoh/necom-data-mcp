import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config, getStore } from '../config.js';
import { WooClient, attributionOf, type WooOrder } from './client.js';
import { resolveRange, round, safeDiv, pct, textResult, errorResult } from '../util.js';

const PAID_STATUSES = ['completed', 'processing'];

const storeParam = z.string().describe(`Butiksnyckel. En av: ${config.stores.map((s) => s.key).join(', ') || '(inga)'}`);
const sinceParam = z.string().optional().describe('Startdatum YYYY-MM-DD eller relativt, t.ex. "7d", "30d". Default 30d.');
const untilParam = z.string().optional().describe('Slutdatum YYYY-MM-DD. Default idag.');

interface RevenueInterval {
  interval: string;
  date_start: string;
  subtotals: { orders_count: number; net_revenue: number; total_sales: number; avg_order_value: number; refunds: number; shipping: number; taxes: number; coupons: number };
}
interface RevenueStats {
  totals: RevenueInterval['subtotals'];
  intervals: RevenueInterval[];
}
interface OrdersStats {
  totals: { orders_count: number; num_items_sold: number; num_new_customers?: number; num_returning_customers?: number; avg_items_per_order: number; avg_order_value: number; net_revenue: number };
}

export function registerWooTools(server: McpServer): void {
  server.registerTool(
    'woo_list_stores',
    {
      title: 'Lista WooCommerce-butiker',
      description: 'Visar vilka butiker servern är konfigurerad för (nyckel, namn, URL, GA4-property). Anropa först om du inte vet butiksnyckeln.',
      inputSchema: {},
    },
    async () => textResult(config.stores.map((s) => ({ key: s.key, name: s.name, url: s.url, ga4_property: s.ga4Property ?? null }))),
  );

  server.registerTool(
    'woo_sales_summary',
    {
      title: 'Försäljningssammanfattning (WooCommerce)',
      description:
        'Intäkt, antal ordrar, AOV, återbetalningar, nya vs återkommande kunder för en period, plus utveckling per dag/vecka/månad. Använder WooCommerce Analytics (wc-analytics) och faller tillbaka på orderlistan om Analytics saknas. Netto = exkl. moms, frakt och återbetalningar.',
      inputSchema: {
        store: storeParam,
        since: sinceParam,
        until: untilParam,
        interval: z.enum(['day', 'week', 'month']).optional().describe('Gruppering av tidsserien. Default day.'),
        compare_previous: z.boolean().optional().describe('Om true hämtas även föregående lika lång period för jämförelse. Default true.'),
      },
    },
    async ({ store, since, until, interval, compare_previous }) => {
      try {
        const s = getStore(store);
        const client = new WooClient(s);
        const range = resolveRange(since, until);
        const current = await summary(client, range.since, range.until, interval ?? 'day');
        let previous: Awaited<ReturnType<typeof summary>> | null = null;
        if (compare_previous !== false) {
          const days = Math.round((Date.parse(range.until) - Date.parse(range.since)) / 86_400_000) + 1;
          const prevUntil = new Date(Date.parse(range.since) - 86_400_000);
          const prevSince = new Date(prevUntil.getTime() - (days - 1) * 86_400_000);
          previous = await summary(client, prevSince.toISOString().slice(0, 10), prevUntil.toISOString().slice(0, 10), interval ?? 'day');
        }
        const change = previous
          ? {
              net_revenue_pct: pct(current.totals.net_revenue - previous.totals.net_revenue, previous.totals.net_revenue),
              orders_pct: pct(current.totals.orders - previous.totals.orders, previous.totals.orders),
              aov_pct: current.totals.aov && previous.totals.aov ? pct(current.totals.aov - previous.totals.aov, previous.totals.aov) : null,
            }
          : null;
        return textResult({ store: s.name, currency: 'SEK', ...current, previous_period: previous ? { period: previous.period, totals: previous.totals } : null, change_vs_previous: change });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'woo_orders_attribution',
    {
      title: 'Orderattribution (varifrån kom köpen)',
      description:
        'Grupperar betalda ordrar efter WooCommerce Order Attribution (source type, utm_source/medium/campaign, enhet) samt använda rabattkoder. Visar hur många ordrar och hur mycket intäkt Meta/Facebook/Instagram, Google, direkt, e-post m.fl. står för enligt butiken – att jämföra med Metas egen attribution.',
      inputSchema: { store: storeParam, since: sinceParam, until: untilParam },
    },
    async ({ store, since, until }) => {
      try {
        const s = getStore(store);
        const range = resolveRange(since, until);
        const orders = await new WooClient(s).orders(range.since, range.until, PAID_STATUSES);
        const total = orders.reduce((a, o) => a + Number(o.total), 0);
        const group = (keyFn: (o: WooOrder) => string) => {
          const m = new Map<string, { orders: number; revenue: number }>();
          for (const o of orders) {
            const k = keyFn(o);
            const cur = m.get(k) ?? { orders: 0, revenue: 0 };
            cur.orders += 1;
            cur.revenue += Number(o.total);
            m.set(k, cur);
          }
          return [...m.entries()]
            .map(([key, v]) => ({ key, orders: v.orders, revenue: round(v.revenue), share_of_revenue_pct: pct(v.revenue, total), aov: safeDiv(v.revenue, v.orders) }))
            .sort((a, b) => b.revenue - a.revenue);
        };
        const attributionCoverage = orders.filter((o) => attributionOf(o).source_type !== 'unknown').length;
        return textResult({
          store: s.name,
          period: range,
          orders: orders.length,
          revenue_incl_tax: round(total),
          attribution_coverage_pct: pct(attributionCoverage, orders.length),
          note: attributionCoverage === 0 ? 'Ingen order har attributionsdata – kontrollera att "Order Attribution" är aktiverat i WooCommerce → Inställningar → Avancerat → Funktioner.' : undefined,
          by_source_type: group((o) => attributionOf(o).source_type),
          by_source: group((o) => attributionOf(o).source),
          by_source_medium_campaign: group((o) => {
            const a = attributionOf(o);
            return `${a.source} / ${a.medium} / ${a.campaign}`;
          }).slice(0, 40),
          by_device: group((o) => attributionOf(o).device || '(okänd)'),
          by_coupon: group((o) => (o.coupon_lines?.length ? o.coupon_lines.map((c) => c.code).join('+') : '(ingen kod)')),
          by_created_via: group((o) => o.created_via ?? '(okänd)'),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'woo_top_products',
    {
      title: 'Toppsäljande produkter',
      description: 'Produkter sorterade på sålda enheter eller nettointäkt under perioden. Bra för att välja produkter till annonser och kataloguppsättningar.',
      inputSchema: {
        store: storeParam,
        since: sinceParam,
        until: untilParam,
        limit: z.number().int().min(1).max(100).optional().describe('Antal produkter. Default 20.'),
        order_by: z.enum(['items_sold', 'net_revenue', 'orders_count']).optional(),
      },
    },
    async ({ store, since, until, limit, order_by }) => {
      try {
        const s = getStore(store);
        const client = new WooClient(s);
        const range = resolveRange(since, until);
        try {
          const { data } = await client.get<{ product_id: number; items_sold: number; net_revenue: number; orders_count: number; extended_info?: { name?: string; sku?: string; stock_status?: string; stock_quantity?: number | null; price?: string } }[]>(
            'wc-analytics',
            'reports/products',
            { after: `${range.since}T00:00:00`, before: `${range.until}T23:59:59`, per_page: limit ?? 20, orderby: order_by ?? 'items_sold', order: 'desc', extended_info: 'true' },
          );
          return textResult({
            store: s.name,
            period: range,
            source: 'wc-analytics',
            products: data.map((p) => ({ product_id: p.product_id, name: p.extended_info?.name, sku: p.extended_info?.sku, items_sold: p.items_sold, net_revenue: round(p.net_revenue), orders: p.orders_count, stock_status: p.extended_info?.stock_status, stock_quantity: p.extended_info?.stock_quantity ?? null })),
          });
        } catch {
          const orders = await client.orders(range.since, range.until, PAID_STATUSES);
          const m = new Map<number, { name: string; items: number; revenue: number; orders: Set<number> }>();
          for (const o of orders)
            for (const li of o.line_items) {
              const cur = m.get(li.product_id) ?? { name: li.name, items: 0, revenue: 0, orders: new Set<number>() };
              cur.items += li.quantity;
              cur.revenue += Number(li.total);
              cur.orders.add(o.id);
              m.set(li.product_id, cur);
            }
          const key = order_by ?? 'items_sold';
          const rows = [...m.entries()].map(([product_id, v]) => ({ product_id, name: v.name, items_sold: v.items, net_revenue: round(v.revenue), orders: v.orders.size }));
          rows.sort((a, b) => (key === 'net_revenue' ? b.net_revenue - a.net_revenue : key === 'orders_count' ? b.orders - a.orders : b.items_sold - a.items_sold));
          return textResult({ store: s.name, period: range, source: 'orders (wc-analytics ej tillgängligt)', products: rows.slice(0, limit ?? 20) });
        }
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'woo_orders_list',
    {
      title: 'Orderlista (utan persondata)',
      description: 'Kompakt lista över ordrar: id, datum, status, belopp, antal rader, produktnamn, rabattkod, attribution, land. Ingen kundidentitet returneras.',
      inputSchema: {
        store: storeParam,
        since: sinceParam,
        until: untilParam,
        status: z.array(z.string()).optional().describe('Orderstatusar. Default completed, processing.'),
        limit: z.number().int().min(1).max(500).optional().describe('Max antal. Default 100.'),
      },
    },
    async ({ store, since, until, status, limit }) => {
      try {
        const s = getStore(store);
        const range = resolveRange(since, until);
        const orders = await new WooClient(s).orders(range.since, range.until, status ?? PAID_STATUSES, limit ?? 100);
        return textResult({
          store: s.name,
          period: range,
          count: orders.length,
          orders: orders.slice(0, limit ?? 100).map((o) => ({
            id: o.id,
            date: o.date_created,
            status: o.status,
            total: Number(o.total),
            discount: Number(o.discount_total),
            shipping: Number(o.shipping_total),
            items: o.line_items.reduce((a, li) => a + li.quantity, 0),
            products: o.line_items.map((li) => `${li.name} ×${li.quantity}`),
            coupons: o.coupon_lines?.map((c) => c.code) ?? [],
            attribution: attributionOf(o),
            country: o.billing?.country ?? null,
            returning_customer: o.customer_id > 0,
          })),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}

async function summary(client: WooClient, since: string, until: string, interval: 'day' | 'week' | 'month') {
  const period = { since, until };
  try {
    const [rev, ord] = await Promise.all([
      client.get<RevenueStats>('wc-analytics', 'reports/revenue/stats', { after: `${since}T00:00:00`, before: `${until}T23:59:59`, interval, per_page: 100 }),
      client.get<OrdersStats>('wc-analytics', 'reports/orders/stats', { after: `${since}T00:00:00`, before: `${until}T23:59:59`, interval, per_page: 1 }),
    ]);
    const t = rev.data.totals;
    return {
      period,
      source: 'wc-analytics',
      totals: {
        orders: t.orders_count,
        net_revenue: round(t.net_revenue),
        total_sales_incl_tax_shipping: round(t.total_sales),
        aov: round(t.avg_order_value),
        refunds: round(t.refunds),
        shipping: round(t.shipping),
        taxes: round(t.taxes),
        coupons_discount: round(t.coupons),
        items_sold: ord.data.totals.num_items_sold,
        new_customers: ord.data.totals.num_new_customers ?? null,
        returning_customers: ord.data.totals.num_returning_customers ?? null,
      },
      series: rev.data.intervals.map((i) => ({ interval: i.interval, start: i.date_start.slice(0, 10), orders: i.subtotals.orders_count, net_revenue: round(i.subtotals.net_revenue), aov: round(i.subtotals.avg_order_value) })),
    };
  } catch {
    const orders = await client.orders(since, until, PAID_STATUSES);
    const buckets = new Map<string, { orders: number; revenue: number }>();
    let gross = 0;
    let net = 0;
    let shipping = 0;
    let tax = 0;
    let discount = 0;
    let returning = 0;
    for (const o of orders) {
      const total = Number(o.total);
      gross += total;
      shipping += Number(o.shipping_total);
      tax += Number(o.total_tax);
      discount += Number(o.discount_total);
      net += total - Number(o.total_tax) - Number(o.shipping_total);
      if (o.customer_id > 0) returning += 1;
      const d = o.date_created.slice(0, 10);
      const key = interval === 'month' ? d.slice(0, 7) : interval === 'week' ? isoWeek(d) : d;
      const b = buckets.get(key) ?? { orders: 0, revenue: 0 };
      b.orders += 1;
      b.revenue += total - Number(o.total_tax) - Number(o.shipping_total);
      buckets.set(key, b);
    }
    return {
      period,
      source: 'orders (wc-analytics ej tillgängligt)',
      totals: {
        orders: orders.length,
        net_revenue: round(net),
        total_sales_incl_tax_shipping: round(gross),
        aov: safeDiv(gross, orders.length),
        refunds: null,
        shipping: round(shipping),
        taxes: round(tax),
        coupons_discount: round(discount),
        items_sold: orders.reduce((a, o) => a + o.line_items.reduce((x, li) => x + li.quantity, 0), 0),
        new_customers: null,
        returning_customers: returning,
      },
      series: [...buckets.entries()].sort().map(([k, v]) => ({ interval, start: k, orders: v.orders, net_revenue: round(v.revenue), aov: safeDiv(v.revenue, v.orders) })),
    };
  }
}

function isoWeek(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
