/**
 * MER / blended ROAS: butikens verkliga intäkt (oavsett plattform) mot annonskostnad som anroparen anger
 * (Claude hämtar Meta-spend via Meta Ads MCP och skickar in här). Bruttomarginal tas från varumärkesregistret om den inte anges.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getBrand } from './brands.js';
import { salesTotals } from './sales/tools.js';
import { resolveRange, round, safeDiv, pct, textResult, errorResult } from './util.js';

export function registerMerTools(server: McpServer): void {
  server.registerTool(
    'mer_summary',
    {
      title: 'MER / blended ROAS för ett varumärke',
      description:
        'Räknar MER (nettointäkt ÷ annonskostnad), blended CPA, break-even-CPA/MER och bidrag efter annonser utifrån varumärkets verkliga försäljning (Woo eller v_sales) och den annonskostnad du anger (Meta-spend från Meta Ads MCP, ev. + Google Ads). Jämför med plattformsrapporterad ROAS för att se attributionsgapet. Meta-konto-ID för varumärket returneras så att du kan hämta spend.',
      inputSchema: {
        brand: z.string().describe('Varumärkesnyckel (brand_list).'),
        since: z.string().optional(),
        until: z.string().optional(),
        ad_spend_sek: z.number().min(0).describe('Total annonskostnad i SEK för perioden.'),
        platform_reported_revenue_sek: z.number().optional().describe('Intäkt som Meta själv attribuerar (spend × purchase_roas).'),
        platform_reported_purchases: z.number().optional(),
        gross_margin_pct: z.number().min(0).max(100).optional().describe('Överstyr varumärkets bruttomarginal.'),
      },
    },
    async ({ brand, since, until, ad_spend_sek, platform_reported_revenue_sek, platform_reported_purchases, gross_margin_pct }) => {
      try {
        const b = getBrand(brand);
        const r = resolveRange(since, until);
        const s = await salesTotals(b, r.since, r.until);
        const margin = gross_margin_pct ?? b.grossMarginPct;
        const mer = safeDiv(s.net_revenue, ad_spend_sek);
        const marginFrac = margin !== undefined ? margin / 100 : null;
        return textResult({
          brand: b.key,
          name: b.name,
          meta_account: b.metaAccount ?? null,
          period: r,
          sales_source: s.source,
          net_revenue_sek: s.net_revenue,
          gross_revenue_sek: s.gross_revenue,
          orders: s.orders,
          aov_net_sek: s.aov_net,
          ad_spend_sek: round(ad_spend_sek),
          mer,
          target_mer: b.targetMer ?? null,
          mer_vs_target: b.targetMer && mer !== null ? (mer >= b.targetMer ? 'över mål' : 'under mål') : null,
          ad_spend_share_of_revenue_pct: pct(ad_spend_sek, s.net_revenue),
          blended_cpa_sek: safeDiv(ad_spend_sek, s.orders),
          break_even:
            marginFrac !== null && s.aov_net
              ? {
                  gross_margin_pct: margin,
                  break_even_cpa_sek: round(s.aov_net * marginFrac),
                  break_even_mer: round(1 / marginFrac),
                  contribution_after_ads_sek: round(s.net_revenue * marginFrac - ad_spend_sek),
                }
              : null,
          platform_vs_store:
            platform_reported_revenue_sek !== undefined
              ? {
                  platform_reported_revenue_sek,
                  platform_roas: safeDiv(platform_reported_revenue_sek, ad_spend_sek),
                  platform_share_of_store_net_revenue_pct: pct(platform_reported_revenue_sek, s.net_revenue),
                  platform_share_of_store_gross_revenue_pct: pct(platform_reported_revenue_sek, s.gross_revenue),
                  platform_reported_purchases: platform_reported_purchases ?? null,
                  platform_share_of_orders_pct: platform_reported_purchases !== undefined ? pct(platform_reported_purchases, s.orders) : null,
                }
              : null,
          how_to_read:
            'MER under break_even_mer = annonserna bär inte sin kostnad på bruttomarginal. Metas intäkt är brutto inkl. moms; jämför mot gross_revenue. Plattformsandel > 100 % av brutto = överattribution; 30–70 % är normalt i en butik med flera kanaler.',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
