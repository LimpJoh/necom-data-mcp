/**
 * daily_digest – kompakt läge per varumärke, beräknat en gång per dygn och cachat.
 * Tänkt som första (ofta enda) läsningen för agenter: nyckeltal med förändring, Meta-spend från
 * kampanjkartan, journaländringar sedan förra läsningen och regelbaserade avvikelser.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from './config.js';
import { brands, getBrand, type Brand } from './brands.js';
import { salesTotals } from './sales/tools.js';
import { readJournal, type JournalEntry } from './journal.js';
import { loadMap } from './meta/map.js';
import { gscConfigured, gscQuery } from './gsc/tools.js';
import { ga4Configured, runReport } from './ga4/tools.js';
import { daysAgo, round, safeDiv, pct, textResult, errorResult } from './util.js';

type Delta = { cur: number | null; prev: number | null; change_pct: number | null };
const delta = (cur: number | null, prev: number | null): Delta => ({
  cur: cur === null ? null : round(cur),
  prev: prev === null ? null : round(prev),
  change_pct: cur !== null && prev !== null && prev > 0 ? round(((cur - prev) / prev) * 100, 1) : null,
});

const stockholmDate = (d = new Date()) => d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Stockholm' });
const dir = () => path.join(config.dataDir, 'digest');
const fileFor = (date: string) => path.join(dir(), `${date}.json`);

interface BrandDigest {
  brand: string;
  name: string;
  sales?: { net_7d: Delta; orders_7d: Delta; aov_7d: Delta; net_yesterday: number | null; source: string };
  meta?: { spend_7d: number; purchases_7d: number; platform_roas_7d: number | null; mer_7d: number | null; break_even_mer: number | null; target_mer: number | null; map_updated_at: string };
  ga4?: { sessions_7d: Delta; cvr_pct_7d: Delta };
  gsc?: { clicks_7d: Delta; impressions_7d: Delta; note: string };
  journal: { open_issues: Array<{ id: string; title: string }>; due_checkpoints: Array<{ id: string; title: string; next_check: string }>; last_change_days_ago: number | null };
  flags: string[];
  errors: string[];
}

interface Digest {
  date: string;
  computed_at: string;
  periods: { cur_7d: string; prev_7d: string; gsc_cur_7d: string; gsc_prev_7d: string };
  brands: BrandDigest[];
  summary_flags: string[];
}

async function sumGsc(site: string, since: string, until: string) {
  const rows = await gscQuery(site, { startDate: since, endDate: until, dimensions: [], rowLimit: 1 });
  const r = rows[0];
  return { clicks: r?.clicks ?? 0, impressions: r?.impressions ?? 0 };
}

async function brandDigest(b: Brand): Promise<BrandDigest> {
  const errors: string[] = [];
  const flags: string[] = [];
  const out: BrandDigest = { brand: b.key, name: b.name, journal: { open_issues: [], due_checkpoints: [], last_change_days_ago: null }, flags, errors };
  const cur = { since: daysAgo(7), until: daysAgo(1) };
  const prev = { since: daysAgo(14), until: daysAgo(8) };
  const breakEvenMer = b.grossMarginPct ? round(100 / b.grossMarginPct) : null;

  const tasks: Promise<void>[] = [];

  if (b.platform !== 'none') {
    tasks.push(
      (async () => {
        try {
          const [c, p, y] = await Promise.all([
            salesTotals(b, cur.since, cur.until),
            salesTotals(b, prev.since, prev.until),
            salesTotals(b, daysAgo(1), daysAgo(1)),
          ]);
          out.sales = { net_7d: delta(c.net_revenue, p.net_revenue), orders_7d: delta(c.orders, p.orders), aov_7d: delta(c.aov_net, p.aov_net), net_yesterday: round(y.net_revenue), source: c.source };
          const ch = out.sales.net_7d.change_pct;
          if (ch !== null && ch <= -25) flags.push(`Nettointäkt 7d ${ch} % mot föregående 7d`);
          if (c.orders === 0 && p.orders > 0) flags.push('Inga ordrar senaste 7 dagarna');
        } catch (e) {
          errors.push(`sales: ${(e as Error).message}`);
        }
      })(),
    );
  }

  if (b.metaAccount) {
    tasks.push(
      (async () => {
        try {
          const map = await loadMap(b.key);
          if (!map) return;
          let spend = 0, purchases = 0, revenue = 0;
          for (const c of map.campaigns) {
            spend += c.m7?.spend ?? 0;
            purchases += c.m7?.purchases ?? 0;
            revenue += c.m7?.revenue ?? 0;
          }
          out.meta = { spend_7d: round(spend), purchases_7d: purchases, platform_roas_7d: safeDiv(revenue, spend), mer_7d: null, break_even_mer: breakEvenMer, target_mer: b.targetMer ?? null, map_updated_at: map.updated_at };
          const ageH = (Date.now() - new Date(map.updated_at).getTime()) / 3_600_000;
          if (ageH > 30) flags.push(`Kampanjkartan är ${Math.round(ageH)} h gammal – spend kan vara inaktuell`);
          if (spend > 300 && purchases === 0) flags.push(`Meta: ${round(spend)} kr spend 7d utan rapporterade köp`);
        } catch (e) {
          errors.push(`meta: ${(e as Error).message}`);
        }
      })(),
    );
  }

  if (b.ga4Property && ga4Configured()) {
    tasks.push(
      (async () => {
        try {
          const m = ['sessions', 'ecommercePurchases'];
          const [c, p] = await Promise.all([runReport(b.ga4Property!, cur.since, cur.until, [], m, 1), runReport(b.ga4Property!, prev.since, prev.until, [], m, 1)]);
          out.ga4 = { sessions_7d: delta(c.totals.sessions, p.totals.sessions), cvr_pct_7d: delta(pct(c.totals.ecommercePurchases, c.totals.sessions), pct(p.totals.ecommercePurchases, p.totals.sessions)) };
          const ch = out.ga4.sessions_7d.change_pct;
          if (ch !== null && ch <= -25) flags.push(`GA4-sessioner 7d ${ch} %`);
        } catch (e) {
          errors.push(`ga4: ${(e as Error).message}`);
        }
      })(),
    );
  }

  if (b.gscSite && gscConfigured()) {
    tasks.push(
      (async () => {
        try {
          // GSC släpar 2–3 dygn: jämför dag -10..-4 mot -17..-11.
          const [c, p] = await Promise.all([sumGsc(b.gscSite!, daysAgo(10), daysAgo(4)), sumGsc(b.gscSite!, daysAgo(17), daysAgo(11))]);
          out.gsc = { clicks_7d: delta(c.clicks, p.clicks), impressions_7d: delta(c.impressions, p.impressions), note: 'Förskjutet 3 dygn p.g.a. GSC-fördröjning' };
          const ch = out.gsc.clicks_7d.change_pct;
          if (ch !== null && ch <= -25 && p.clicks >= 20) flags.push(`Organiska klick 7d ${ch} %`);
        } catch (e) {
          errors.push(`gsc: ${(e as Error).message}`);
        }
      })(),
    );
  }

  tasks.push(
    (async () => {
      try {
        const j = await readJournal(b.key);
        const today = stockholmDate();
        const sorted = [...j].sort((a, c) => (a.ts < c.ts ? 1 : -1));
        out.journal.open_issues = sorted.filter((e) => e.type === 'issue' && !e.resolved).slice(0, 8).map((e) => ({ id: e.id, title: e.title }));
        out.journal.due_checkpoints = sorted
          .filter((e) => e.next_check && !e.resolved && e.next_check <= today)
          .slice(0, 8)
          .map((e) => ({ id: e.id, title: e.title, next_check: e.next_check! }));
        const lc = sorted.find((e) => e.type === 'change');
        out.journal.last_change_days_ago = lc ? round((Date.now() - new Date(lc.ts).getTime()) / 86_400_000, 1) : null;
        if (out.journal.due_checkpoints.length) flags.push(`${out.journal.due_checkpoints.length} checkpoint(s) förfallna`);
      } catch (e) {
        errors.push(`journal: ${(e as Error).message}`);
      }
    })(),
  );

  await Promise.all(tasks);

  if (out.meta && out.sales && out.meta.spend_7d > 0 && out.sales.net_7d.cur !== null) {
    out.meta.mer_7d = safeDiv(out.sales.net_7d.cur, out.meta.spend_7d);
    if (out.meta.mer_7d !== null && breakEvenMer !== null && out.meta.mer_7d < breakEvenMer) flags.push(`MER 7d ${out.meta.mer_7d} under break-even ${breakEvenMer}`);
  }
  return out;
}

let inflight: Promise<Digest> | null = null;

export async function computeDigest(): Promise<Digest> {
  if (inflight) return inflight;
  inflight = (async () => {
    const list = brands();
    const results = await Promise.all(list.map(brandDigest));
    const d: Digest = {
      date: stockholmDate(),
      computed_at: new Date().toISOString(),
      periods: { cur_7d: `${daysAgo(7)}..${daysAgo(1)}`, prev_7d: `${daysAgo(14)}..${daysAgo(8)}`, gsc_cur_7d: `${daysAgo(10)}..${daysAgo(4)}`, gsc_prev_7d: `${daysAgo(17)}..${daysAgo(11)}` },
      brands: results,
      summary_flags: results.flatMap((r) => r.flags.map((f) => `${r.brand}: ${f}`)),
    };
    await fs.mkdir(dir(), { recursive: true });
    const tmp = `${fileFor(d.date)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(d));
    await fs.rename(tmp, fileFor(d.date));
    return d;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function cachedDigest(refresh: boolean): Promise<Digest> {
  if (!refresh) {
    try {
      return JSON.parse(await fs.readFile(fileFor(stockholmDate()), 'utf8')) as Digest;
    } catch {
      /* beräkna nedan */
    }
  }
  return computeDigest();
}

/** Förberäkna dagens digest strax efter 05:30 svensk tid (kontroll varje kvart). */
export function scheduleDigest(): void {
  const tick = async () => {
    const now = new Date();
    const hm = now.toLocaleTimeString('sv-SE', { timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit' });
    if (hm < '05:30') return;
    try {
      await fs.access(fileFor(stockholmDate()));
    } catch {
      await computeDigest().catch((e) => console.error('[digest]', (e as Error).message));
    }
  };
  setTimeout(() => void tick(), 20_000);
  setInterval(() => void tick(), 15 * 60_000);
}

function journalSince(all: JournalEntry[], sinceIso: string) {
  return all
    .filter((e) => e.ts > sinceIso)
    .sort((a, b) => (a.ts < b.ts ? 1 : -1))
    .slice(0, 25)
    .map((e) => ({ id: e.id, ts: e.ts, brand: e.brand, type: e.type, title: e.title }));
}

export function registerDigestTools(server: McpServer): void {
  server.registerTool(
    'daily_digest',
    {
      title: 'Daglig sammanfattning – läs detta först',
      description:
        'Kompakt läge per varumärke, beräknat en gång per dygn (05:30) och cachat: nettointäkt/ordrar/AOV 7d mot föregående 7d, Meta-spend och MER 7d (från kampanjkartan), GA4-sessioner och konvertering, organiska klick (GSC, förskjutet 3 dygn), öppna issues, förfallna checkpoints och regelbaserade flaggor. ' +
        'Ange since_ts (tidpunkten för din förra läsning) för att även få journalposter som tillkommit sedan dess. Gå bara vidare till detaljverktyg om en flagga eller din uppgift kräver det.',
      inputSchema: {
        brand: z.string().optional().describe('Begränsa till ett varumärke (brand_list). Utelämna för alla.'),
        since_ts: z.string().optional().describe('ISO-tid för din förra läsning – returnerar journalposter efter denna. Default: senaste 24 h.'),
        refresh: z.boolean().optional().describe('Tvinga omräkning (dyrt, används sällan).'),
      },
    },
    async ({ brand, since_ts, refresh }) => {
      try {
        const d = await cachedDigest(Boolean(refresh));
        const sel = brand ? d.brands.filter((x) => x.brand === getBrand(brand).key) : d.brands;
        const since = since_ts && !Number.isNaN(Date.parse(since_ts)) ? new Date(since_ts).toISOString() : new Date(Date.now() - 86_400_000).toISOString();
        const all = await readJournal(brand ? getBrand(brand).key : undefined);
        return textResult({
          date: d.date,
          computed_at: d.computed_at,
          periods: d.periods,
          flags: brand ? sel.flatMap((r) => r.flags.map((f) => `${r.brand}: ${f}`)) : d.summary_flags,
          brands: sel,
          journal_since: { since, entries: journalSince(all, since) },
          read_at: new Date().toISOString(),
          how_to_use: 'Spara read_at och skicka den som since_ts nästa gång. Inga flaggor och inga nya journalposter = inget att göra.',
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
