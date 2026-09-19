/**
 * Hälsokontroller per varumärke och globalt – det som visas på admin-tavlan.
 * Varje kontroll ger status ok | warn | error | off och en kort text om vad som saknas.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';
import { brands, type Brand } from '../brands.js';
import { WooClient } from '../woo/client.js';
import { runReport, ga4Configured } from '../ga4/tools.js';
import { gscQuery, gscConfigured } from '../gsc/tools.js';

export type Status = 'ok' | 'warn' | 'error' | 'off';
export interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string;
}
export interface BrandHealth {
  key: string;
  name: string;
  checks: Check[];
  score: number; // 0–100
}

const timeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms`)), ms))]);

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function serviceAccountEmail(): string | null {
  try {
    return (JSON.parse(readFileSync(config.ga4Credentials, 'utf8')) as { client_email?: string }).client_email ?? null;
  } catch {
    return null;
  }
}

export async function checkBrand(b: Brand): Promise<BrandHealth> {
  const checks: Check[] = [];

  // Försäljningskälla
  if (b.platform === 'woo') {
    if (!b.woo || !b.url) checks.push({ name: 'WooCommerce', status: 'error', detail: 'Saknar URL, användare eller applikationslösenord.', fix: 'Fyll i under Redigera.' });
    else {
      try {
        const c = new WooClient({ key: b.key, name: b.name, url: b.url, user: b.woo.user, appPassword: b.woo.appPassword });
        const { total } = await timeout(c.get<unknown[]>('wc/v3', 'orders', { per_page: 1, after: `${daysAgo(30)}T00:00:00` }), 15_000);
        let analytics = 'wc-analytics: ok';
        try {
          await timeout(c.get('wc-analytics', 'reports/revenue/stats', { after: `${daysAgo(7)}T00:00:00`, before: `${daysAgo(0)}T23:59:59`, interval: 'month', per_page: 1 }), 15_000);
        } catch {
          analytics = 'wc-analytics svarar inte (fallback på orderlista, saknar nya/återkommande kunder)';
        }
        checks.push({ name: 'WooCommerce', status: analytics.includes('inte') ? 'warn' : 'ok', detail: `${total} ordrar senaste 30 d · ${analytics}` });
        // Attribution
        try {
          const orders = await timeout(c.orders(daysAgo(30), daysAgo(0), ['completed', 'processing'], 200), 20_000);
          const withAttr = orders.filter((o) => o.meta_data?.some((m) => m.key === '_wc_order_attribution_source_type')).length;
          const pctAttr = orders.length ? Math.round((withAttr / orders.length) * 100) : 0;
          checks.push({
            name: 'Order Attribution',
            status: orders.length === 0 ? 'warn' : pctAttr >= 80 ? 'ok' : pctAttr >= 50 ? 'warn' : 'error',
            detail: `${pctAttr} % av ordrarna har källa`,
            fix: pctAttr < 80 ? 'WooCommerce → Inställningar → Avancerat → Funktioner → Order Attribution; kontrollera blockkassan.' : undefined,
          });
        } catch (e) {
          checks.push({ name: 'Order Attribution', status: 'warn', detail: `Kunde inte läsa ordrar: ${(e as Error).message.slice(0, 80)}` });
        }
      } catch (e) {
        const msg = (e as Error).message;
        checks.push({
          name: 'WooCommerce',
          status: 'error',
          detail: msg.slice(0, 160),
          fix: msg.includes('401') ? 'Fel användarnamn (WP-login, inte e-post) eller applikationslösenordet saknas/är återkallat.' : msg.includes('403') ? 'Användaren behöver rollen Butiksansvarig, eller en säkerhetsplugin blockerar REST.' : 'Kontrollera URL och att /wp-json/wc/v3/ svarar.',
        });
      }
    }
  } else if (b.platform === 'supabase') {
    if (!b.supabase) checks.push({ name: 'Supabase', status: 'error', detail: 'Saknar URL eller service_role-nyckel.' });
    else {
      try {
        const sb = createClient(b.supabase.url, b.supabase.serviceRoleKey, { auth: { persistSession: false } });
        const q = sb.from(b.supabase.salesView).select('order_id', { count: 'exact', head: true }).gte('created_at', `${daysAgo(30)}T00:00:00Z`);
        const { count, error } = await timeout(Promise.resolve(q) as Promise<{ count: number | null; error: { message: string } | null }>, 15_000);
        if (error) throw new Error(error.message);
        checks.push({ name: `Supabase ${b.supabase.salesView}`, status: 'ok', detail: `${count ?? 0} rader senaste 30 d` });
      } catch (e) {
        checks.push({ name: `Supabase ${b.supabase?.salesView}`, status: 'error', detail: (e as Error).message.slice(0, 160), fix: 'Skapa vyn med sql/v_sales.sql (anpassad till projektets tabeller).' });
      }
    }
  } else checks.push({ name: 'Försäljningskälla', status: 'warn', detail: 'Ingen plattform vald.' });

  // GA4
  if (!b.ga4Property) checks.push({ name: 'GA4', status: 'warn', detail: 'Property-ID saknas.', fix: 'GA4 → Admin → Egendomsinformation → Egendoms-ID (siffror).' });
  else if (!ga4Configured()) checks.push({ name: 'GA4', status: 'error', detail: 'Servicekontots JSON saknas.', fix: 'Ladda upp under Inställningar.' });
  else {
    try {
      const r = await timeout(runReport(b.ga4Property, daysAgo(7), daysAgo(0), [], ['sessions', 'ecommercePurchases'], 1), 20_000);
      const s = r.totals.sessions;
      const p = r.totals.ecommercePurchases;
      checks.push({ name: 'GA4', status: s > 0 ? (p > 0 ? 'ok' : 'warn') : 'warn', detail: `${s} sessioner, ${p} köp senaste 7 d`, fix: p === 0 ? 'Inga purchase-events i GA4 – kontrollera e-handelsspårningen.' : undefined });
    } catch (e) {
      const msg = (e as Error).message;
      checks.push({ name: 'GA4', status: 'error', detail: msg.slice(0, 140), fix: msg.includes('PERMISSION') ? `Lägg till ${serviceAccountEmail() ?? 'servicekontot'} som Läsare på propertyn.` : undefined });
    }
  }

  // Search Console
  if (!b.gscSite) checks.push({ name: 'Search Console', status: 'warn', detail: 'Sajt saknas (t.ex. sc-domain:exempel.se).' });
  else if (!gscConfigured()) checks.push({ name: 'Search Console', status: 'error', detail: 'Servicekontots JSON saknas.' });
  else {
    try {
      const rows = await timeout(gscQuery(b.gscSite, { startDate: daysAgo(10), endDate: daysAgo(3), dataState: 'all' }), 20_000);
      checks.push({ name: 'Search Console', status: 'ok', detail: `${rows[0]?.clicks ?? 0} klick senaste veckan` });
    } catch (e) {
      const msg = (e as Error).message;
      checks.push({ name: 'Search Console', status: 'error', detail: msg.slice(0, 140), fix: `Lägg till ${serviceAccountEmail() ?? 'servicekontot'} som användare på ${b.gscSite} i Search Console.` });
    }
  }

  // Meta
  const metaMissing = [!b.metaAccount && 'annonskonto', !b.metaPixel && 'pixel', !b.metaCatalog && 'katalog'].filter(Boolean) as string[];
  checks.push(
    metaMissing.length === 0
      ? { name: 'Meta-ID:n', status: 'ok', detail: `Konto ${b.metaAccount}, pixel ${b.metaPixel}, katalog ${b.metaCatalog}` }
      : { name: 'Meta-ID:n', status: metaMissing.includes('annonskonto') ? 'error' : 'warn', detail: `Saknar: ${metaMissing.join(', ')}`, fix: 'Hämta i Business Manager / Events Manager / Commerce Manager.' },
  );

  // Ekonomi
  if (b.grossMarginPct === undefined) checks.push({ name: 'Bruttomarginal', status: 'error', detail: 'Saknas – MER kan inte tolkas som vinst/förlust.', fix: 'Fyll i procent under Redigera.' });
  else checks.push({ name: 'Bruttomarginal', status: 'ok', detail: `${b.grossMarginPct} % → break-even-MER ${(100 / b.grossMarginPct).toFixed(2)}${b.targetMer ? `, mål-MER ${b.targetMer}` : ''}` });

  const weights: Record<Status, number> = { ok: 1, warn: 0.5, error: 0, off: 1 };
  const score = Math.round((checks.reduce((a, c) => a + weights[c.status], 0) / checks.length) * 100);
  return { key: b.key, name: b.name, checks, score };
}

export async function checkGlobal(): Promise<Check[]> {
  const out: Check[] = [];
  const email = serviceAccountEmail();
  out.push(
    existsSync(config.ga4Credentials)
      ? { name: 'Google servicekonto', status: 'ok', detail: email ?? 'JSON finns' }
      : { name: 'Google servicekonto', status: 'warn', detail: 'Saknas – GA4 och Search Console av.', fix: 'Ladda upp JSON-nyckeln nedan.' },
  );
  out.push(config.stripeSecretKey ? { name: 'Stripe', status: 'ok', detail: 'Nyckel finns' } : { name: 'Stripe', status: 'off', detail: 'Inte konfigurerat' });
  out.push(config.mollieAccessToken ? { name: 'Mollie', status: 'ok', detail: 'Token finns' } : { name: 'Mollie', status: 'off', detail: 'Inte konfigurerat' });
  out.push(
    config.ops.enabled
      ? { name: 'Ops-lager', status: 'warn', detail: `PÅ – GitHub ${config.ops.githubToken ? '✓' : '–'}, Supabase ${config.ops.supabaseAccessToken ? '✓' : '–'}, Hostinger ${config.ops.hostingerToken ? '✓' : '–'}, SSH-nyckel ${existsSync(config.ops.sshKeyFile) ? '✓' : '–'}` }
      : { name: 'Ops-lager', status: 'off', detail: 'Av' },
  );
  return out;
}

export async function checkAll(): Promise<{ brands: BrandHealth[]; global: Check[] }> {
  const [bs, g] = await Promise.all([Promise.all(brands().map(checkBrand)), checkGlobal()]);
  return { brands: bs, global: g };
}
