/**
 * Dogshowpro (Supabase/Postgres). Läser med service role men returnerar ENBART aggregat –
 * ingen persondata (namn, e-post, personnummer) lämnar servern.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { resolveRange, round, safeDiv, pct, textResult, errorResult } from '../util.js';

let sb: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (!config.dogshowpro.url || !config.dogshowpro.serviceRoleKey) throw new Error('Dogshowpro är inte konfigurerat (DOGSHOWPRO_SUPABASE_URL / SERVICE_ROLE_KEY).');
  if (!sb) sb = createClient(config.dogshowpro.url, config.dogshowpro.serviceRoleKey, { auth: { persistSession: false } });
  return sb;
}

interface RegRow {
  created_at: string;
  tenant_id: string;
  event_id: string;
  payment_status: string | null;
  status: string | null;
  payment_amount_sek: number | null;
  amount_sek: number | null;
  source: string | null;
  source_site: string | null;
  is_test: boolean | null;
}

export function registerDogshowproTools(server: McpServer): void {
  server.registerTool(
    'dogshowpro_sales_summary',
    {
      title: 'Dogshowpro – anmälningar och intäkt',
      description:
        'Aggregerar anmälningar (registrations) i Dogshowpro: antal, betalda, intäkt i SEK, per dag/klubb/evenemang/källa. Testposter exkluderas. Ingen persondata returneras.',
      inputSchema: {
        since: z.string().optional().describe('Startdatum YYYY-MM-DD eller relativt ("30d"). Default 30d.'),
        until: z.string().optional().describe('Slutdatum YYYY-MM-DD. Default idag.'),
        tenant_slug: z.string().optional().describe('Begränsa till en klubb (tenants.slug).'),
      },
    },
    async ({ since, until, tenant_slug }) => {
      try {
        const r = resolveRange(since, until);
        const s = db();
        let tenantFilter: string | null = null;
        if (tenant_slug) {
          const { data: t, error } = await s.from('tenants').select('id').eq('slug', tenant_slug).maybeSingle();
          if (error) throw error;
          if (!t) throw new Error(`Ingen klubb med slug "${tenant_slug}".`);
          tenantFilter = t.id as string;
        }
        let q = s
          .from('registrations')
          .select('created_at,tenant_id,event_id,payment_status,status,payment_amount_sek,amount_sek,source,source_site,is_test')
          .gte('created_at', `${r.since}T00:00:00Z`)
          .lte('created_at', `${r.until}T23:59:59Z`)
          .or('is_test.is.null,is_test.eq.false')
          .limit(20_000);
        if (tenantFilter) q = q.eq('tenant_id', tenantFilter);
        const { data, error } = await q;
        if (error) throw error;
        const rows = (data ?? []) as RegRow[];

        const [{ data: tenants }, { data: events }] = await Promise.all([
          s.from('tenants').select('id,name,slug'),
          s.from('events').select('id,title,starts_at,tenant_id'),
        ]);
        const tenantName = new Map((tenants ?? []).map((t) => [t.id as string, `${t.name} (${t.slug})`]));
        const eventName = new Map((events ?? []).map((e) => [e.id as string, `${e.title} – ${String(e.starts_at ?? '').slice(0, 10)}`]));

        const amount = (x: RegRow) => Number(x.payment_amount_sek ?? x.amount_sek ?? 0);
        const isPaid = (x: RegRow) => (x.payment_status ?? '').toLowerCase() === 'paid';
        const agg = (keyFn: (x: RegRow) => string) => {
          const m = new Map<string, { registrations: number; paid: number; revenue: number }>();
          for (const x of rows) {
            const k = keyFn(x);
            const c = m.get(k) ?? { registrations: 0, paid: 0, revenue: 0 };
            c.registrations += 1;
            if (isPaid(x)) {
              c.paid += 1;
              c.revenue += amount(x);
            }
            m.set(k, c);
          }
          return [...m.entries()].map(([key, v]) => ({ key, ...v, revenue: round(v.revenue) })).sort((a, b) => b.revenue - a.revenue || b.registrations - a.registrations);
        };
        const paid = rows.filter(isPaid);
        const revenue = paid.reduce((a, x) => a + amount(x), 0);
        return textResult({
          period: r,
          totals: {
            registrations: rows.length,
            paid: paid.length,
            paid_rate_pct: pct(paid.length, rows.length),
            revenue_sek: round(revenue),
            avg_paid_amount_sek: safeDiv(revenue, paid.length),
          },
          by_day: agg((x) => x.created_at.slice(0, 10)).sort((a, b) => a.key.localeCompare(b.key)),
          by_tenant: agg((x) => tenantName.get(x.tenant_id) ?? x.tenant_id),
          by_event: agg((x) => eventName.get(x.event_id) ?? x.event_id).slice(0, 30),
          by_source: agg((x) => `${x.source ?? '(okänd)'} / ${x.source_site ?? '(okänd sajt)'}`),
          by_payment_status: agg((x) => x.payment_status ?? '(null)'),
        });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'dogshowpro_upcoming_events',
    {
      title: 'Dogshowpro – kommande evenemang och fyllnadsgrad',
      description: 'Kommande evenemang med anmälningsläge (antal anmälda vs max) – underlag för att avgöra vilka evenemang som behöver marknadsföring.',
      inputSchema: { days_ahead: z.number().int().min(1).max(365).optional().describe('Default 90.') },
    },
    async ({ days_ahead }) => {
      try {
        const s = db();
        const until = new Date(Date.now() + (days_ahead ?? 90) * 86_400_000).toISOString();
        const { data: events, error } = await s
          .from('events')
          .select('id,title,type,starts_at,registration_opens_at,registration_closes_at,max_participants,status,price_member_sek,price_external_sek,tenant_id')
          .gte('starts_at', new Date().toISOString())
          .lte('starts_at', until)
          .order('starts_at');
        if (error) throw error;
        const ids = (events ?? []).map((e) => e.id as string);
        const counts = new Map<string, { total: number; paid: number }>();
        if (ids.length) {
          const { data: regs, error: e2 } = await s.from('registrations').select('event_id,payment_status,is_test').in('event_id', ids).or('is_test.is.null,is_test.eq.false');
          if (e2) throw e2;
          for (const x of regs ?? []) {
            const c = counts.get(x.event_id as string) ?? { total: 0, paid: 0 };
            c.total += 1;
            if ((x.payment_status ?? '').toLowerCase() === 'paid') c.paid += 1;
            counts.set(x.event_id as string, c);
          }
        }
        const { data: tenants } = await s.from('tenants').select('id,name');
        const tn = new Map((tenants ?? []).map((t) => [t.id as string, t.name as string]));
        return textResult(
          (events ?? []).map((e) => {
            const c = counts.get(e.id as string) ?? { total: 0, paid: 0 };
            return {
              event: e.title,
              club: tn.get(e.tenant_id as string) ?? e.tenant_id,
              type: e.type,
              starts_at: e.starts_at,
              registration_opens_at: e.registration_opens_at,
              registration_closes_at: e.registration_closes_at,
              status: e.status,
              price_member_sek: e.price_member_sek,
              price_external_sek: e.price_external_sek,
              registrations: c.total,
              paid: c.paid,
              max_participants: e.max_participants,
              fill_rate_pct: e.max_participants ? pct(c.total, e.max_participants) : null,
            };
          }),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
