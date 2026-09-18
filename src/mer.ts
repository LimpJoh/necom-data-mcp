/**
 * MER / blended ROAS: kombinerar butikens faktiska intäkt med annonskostnad som anroparen anger
 * (Claude hämtar Meta-spend via Meta Ads MCP och skickar in här).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getStore } from './config.js';
import { WooClient } from './woo/client.js';
import { resolveRange, round, safeDiv, pct, textResult, errorResult } from './util.js';

export function registerMerTools(server: McpServer): void {
  server.registerTool(
    'mer_summary',
    {
      title: 'MER / blended ROAS för en butik',
      description:
        'Räknar MER (total nettointäkt ÷ total annonskostnad), blended CPA och break-even utifrån butikens verkliga WooCommerce-intäkt och den annonskostnad du anger (t.ex. Meta-spend från Meta Ads MCP, ev. plus Google Ads). Jämför med plattformsrapporterad ROAS för att se attributionsgapet.',
      inputSchema: {
        store: z.string().describe('Butiksnyckel.'),
        since: z.string().optional(),
        until: z.string().optional(),
        ad_spend_sek: z.number().min(0).describe('Total annonskostnad i SEK för perioden (alla kanaler du vill räkna in).'),
        platform_reported_revenue_sek: z.number().optional().describe('Intäkt som Meta (eller annan plattform) själv attribuerar för perioden – för att räkna attributionsgap.'),
        platform_reported_purchases: z.number().optional(),
        gross_margin_pct: z.number().min(0).max(100).optional().describe('Bruttomarginal i procent, för break-even-beräkning.'),
      },
    },
    async ({ store, since, until, ad_spend_sek, platform_reported_revenue_sek, platform_reported_purchases, gross_margin_pct }) => {
      try {
        const s = getStore(store);
        const r = resolveRange(since, until);
        const client = new WooClient(s);
        let netRevenue: number;
        let orders: number;
        try {
          const { data } = await client.get<{ totals: { net_revenue: number; orders_count: number } }>('wc-analytics', 'reports/revenue/stats', { after: `${r.since}T00:00:00`, before: `${r.until}T23:59:59`, interval: 'month', per_page: 1 });
          netRevenue = data.totals.net_revenue;
          orders = data.totals.orders_count;
        } catch {
          const list = await client.orders(r.since, r.until, ['completed', 'processing']);
          netRevenue = list.reduce((a, o) => a + Number(o.total) - Number(o.total_tax) - Number(o.shipping_total), 0);
          orders = list.length;
        }
        const mer = safeDiv(netRevenue, ad_spend_sek);
        const aov = safeDiv(netRevenue, orders);
        const marginFrac = gross_margin_pct !== undefined ? gross_margin_pct / 100 : null;
        return textResult({
          store: s.name,
          period: r,
          net_revenue_sek: round(netRevenue),
          orders,
          aov_sek: aov,
          ad_spend_sek: round(ad_spend_sek),
          mer: mer,
          ad_spend_share_of_revenue_pct: pct(ad_spend_sek, netRevenue),
          blended_cpa_sek: safeDiv(ad_spend_sek, orders),
          break_even: marginFrac !== null && aov ? { gross_margin_pct, break_even_cpa_sek: round(aov * marginFrac), break_even_mer: round(1 / marginFrac), contribution_after_ads_sek: round(netRevenue * marginFrac - ad_spend_sek) } : null,
          platform_vs_store:
            platform_reported_revenue_sek !== undefined
              ? {
                  platform_reported_revenue_sek: platform_reported_revenue_sek,
                  platform_roas: safeDiv(platform_reported_revenue_sek, ad_spend_sek),
                  platform_share_of_store_revenue_pct: pct(platform_reported_revenue_sek, netRevenue),
                  platform_reported_purchases: platform_reported_purchases ?? null,
                  platform_share_of_orders_pct: platform_reported_purchases !== undefined ? pct(platform_reported_purchases, orders) : null,
                }
              : null,
          how_to_read: 'MER under break_even_mer betyder att annonserna inte bär sin kostnad på bruttomarginal. Om plattformens andel av butikens intäkt är > 100 % överattribuerar plattformen; kring 30–70 % är normalt för Meta i en butik med flera kanaler.',
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
