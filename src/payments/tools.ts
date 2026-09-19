/**
 * Betalleverantörer: Stripe (balance transactions) och Mollie (payments).
 * Ger verklig betald intäkt, avgifter och återbetalningar – tredje sanningskällan vid sidan av butik och GA4.
 * Endast aggregat returneras.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { brands } from '../brands.js';
import { resolveRange, round, safeDiv, textResult, errorResult } from '../util.js';

const sinceParam = z.string().optional().describe('Startdatum YYYY-MM-DD eller relativt ("30d"). Default 30d.');
const untilParam = z.string().optional();

// ---------------- Stripe ----------------
interface StripeBt {
  id: string;
  type: string;
  amount: number;
  fee: number;
  net: number;
  currency: string;
  created: number;
  reporting_category: string;
}

async function stripeList(path: string, params: Record<string, string>, account?: string): Promise<StripeBt[]> {
  if (!config.stripeSecretKey) throw new Error('Stripe är inte konfigurerat (STRIPE_SECRET_KEY saknas). Använd en restricted key med read-only.');
  const out: StripeBt[] = [];
  let starting_after: string | undefined;
  for (let i = 0; i < 50; i++) {
    const url = new URL(`https://api.stripe.com/v1/${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('limit', '100');
    if (starting_after) url.searchParams.set('starting_after', starting_after);
    const headers: Record<string, string> = { Authorization: `Bearer ${config.stripeSecretKey}` };
    if (account) headers['Stripe-Account'] = account;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Stripe ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { data: StripeBt[]; has_more: boolean };
    out.push(...data.data);
    if (!data.has_more || data.data.length === 0) break;
    starting_after = data.data[data.data.length - 1].id;
  }
  return out;
}

// ---------------- Mollie ----------------
interface MolliePayment {
  id: string;
  status: string;
  amount: { value: string; currency: string };
  amountRefunded?: { value: string };
  settlementAmount?: { value: string; currency: string };
  createdAt: string;
  paidAt?: string;
  method?: string;
  profileId?: string;
  metadata?: Record<string, unknown> | null;
}

async function mollieList(since: string, until: string, profileId?: string): Promise<MolliePayment[]> {
  if (!config.mollieAccessToken) throw new Error('Mollie är inte konfigurerat (MOLLIE_ACCESS_TOKEN saknas). Skapa en organisationstoken med payments.read.');
  const out: MolliePayment[] = [];
  let from: string | undefined;
  const sinceMs = Date.parse(`${since}T00:00:00Z`);
  const untilMs = Date.parse(`${until}T23:59:59Z`);
  for (let i = 0; i < 100; i++) {
    const url = new URL('https://api.mollie.com/v2/payments');
    url.searchParams.set('limit', '250');
    if (profileId) {
      url.searchParams.set('profileId', profileId);
      url.searchParams.set('testmode', 'false');
    }
    if (from) url.searchParams.set('from', from);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${config.mollieAccessToken}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Mollie ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { _embedded: { payments: MolliePayment[] }; _links: { next?: { href: string } | null } };
    const page = data._embedded.payments;
    let reachedOlder = false;
    for (const p of page) {
      const t = Date.parse(p.createdAt);
      if (t < sinceMs) {
        reachedOlder = true;
        break;
      }
      if (t <= untilMs) out.push(p);
    }
    if (reachedOlder || !data._links.next?.href || page.length === 0) break;
    from = new URL(data._links.next.href).searchParams.get('from') ?? undefined;
  }
  return out;
}

export function registerPaymentTools(server: McpServer): void {
  server.registerTool(
    'stripe_payments_summary',
    {
      title: 'Stripe – betald intäkt, avgifter, återbetalningar',
      description:
        'Summerar Stripe balance transactions för perioden: brutto inbetalt, Stripe-avgifter, återbetalningar, netto, antal betalningar, per dag. Valfritt per varumärke (BRAND_x_STRIPE_ACCOUNT för Connect-konton) – annars plattformskontot.',
      inputSchema: { brand: z.string().optional().describe('Varumärkesnyckel med STRIPE_ACCOUNT, eller tomt för huvudkontot.'), since: sinceParam, until: untilParam },
    },
    async ({ brand, since, until }) => {
      try {
        const r = resolveRange(since, until);
        const account = brand ? brands().find((b) => b.key === brand)?.stripeAccount : undefined;
        const rows = await stripeList(
          'balance_transactions',
          { 'created[gte]': String(Math.floor(Date.parse(`${r.since}T00:00:00Z`) / 1000)), 'created[lte]': String(Math.floor(Date.parse(`${r.until}T23:59:59Z`) / 1000)) },
          account,
        );
        const cur = rows[0]?.currency?.toUpperCase() ?? 'SEK';
        const sum = (f: (x: StripeBt) => boolean, pick: (x: StripeBt) => number) => rows.filter(f).reduce((a, x) => a + pick(x), 0) / 100;
        const charges = rows.filter((x) => x.reporting_category === 'charge' || x.type === 'charge' || x.type === 'payment');
        const byDay = new Map<string, { gross: number; count: number }>();
        for (const x of charges) {
          const d = new Date(x.created * 1000).toISOString().slice(0, 10);
          const c = byDay.get(d) ?? { gross: 0, count: 0 };
          c.gross += x.amount / 100;
          c.count += 1;
          byDay.set(d, c);
        }
        return textResult({
          account: account ?? 'platform',
          currency: cur,
          period: r,
          gross_charged: round(sum((x) => charges.includes(x), (x) => x.amount)),
          fees: round(-sum(() => true, (x) => -x.fee)),
          refunds: round(-sum((x) => x.reporting_category === 'refund' || x.type === 'refund', (x) => x.amount)),
          payouts: round(-sum((x) => x.type === 'payout', (x) => x.amount)),
          net_all_transactions: round(sum(() => true, (x) => x.net)),
          payments_count: charges.length,
          avg_payment: safeDiv(sum((x) => charges.includes(x), (x) => x.amount), charges.length),
          by_day: [...byDay.entries()].sort().map(([date, v]) => ({ date, gross: round(v.gross), count: v.count })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    'mollie_payments_summary',
    {
      title: 'Mollie – betalningar per period',
      description:
        'Summerar Mollie-betalningar för perioden: betalt belopp, återbetalat, antal, per status, per metod (Swish/kort/Klarna…), per dag. Valfritt per varumärke via BRAND_x_MOLLIE_PROFILE, annars hela organisationen.',
      inputSchema: { brand: z.string().optional(), since: sinceParam, until: untilParam },
    },
    async ({ brand, since, until }) => {
      try {
        const r = resolveRange(since, until);
        const profile = brand ? brands().find((b) => b.key === brand)?.mollieProfile : undefined;
        const rows = await mollieList(r.since, r.until, profile);
        const paid = rows.filter((p) => p.status === 'paid');
        const val = (p: MolliePayment) => Number(p.amount.value);
        const agg = (keyFn: (p: MolliePayment) => string) => {
          const m = new Map<string, { count: number; amount: number }>();
          for (const p of paid) {
            const k = keyFn(p);
            const c = m.get(k) ?? { count: 0, amount: 0 };
            c.count += 1;
            c.amount += val(p);
            m.set(k, c);
          }
          return [...m.entries()].map(([key, v]) => ({ key, count: v.count, amount: round(v.amount) })).sort((a, b) => b.amount - a.amount);
        };
        const statusCounts: Record<string, number> = {};
        for (const p of rows) statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
        const gross = paid.reduce((a, p) => a + val(p), 0);
        const refunded = paid.reduce((a, p) => a + Number(p.amountRefunded?.value ?? 0), 0);
        return textResult({
          profile: profile ?? 'organisation',
          currency: paid[0]?.amount.currency ?? 'SEK',
          period: r,
          paid_count: paid.length,
          paid_amount: round(gross),
          refunded_amount: round(refunded),
          net_after_refunds: round(gross - refunded),
          avg_payment: safeDiv(gross, paid.length),
          status_counts: statusCounts,
          by_method: agg((p) => p.method ?? '(okänd)'),
          by_day: agg((p) => (p.paidAt ?? p.createdAt).slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key)),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
