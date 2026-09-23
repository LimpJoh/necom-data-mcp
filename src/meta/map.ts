/**
 * Kampanjkarta: kampanj → adset → annons med kreativ (thumbnail), 7d/30d-nyckeltal och journalposter per nod.
 * Källa 1: Meta Graph API direkt från servern (META_ACCESS_TOKEN, system user med ads_read) – meta_map_sync + automatisk synk.
 * Källa 2: Claude skickar in en ögonblicksbild från Meta Ads MCP – meta_map_put (när ingen token finns).
 * Lagring: data/meta/<brand>.json. Beskrivningar per nod/varumärke: data/meta/<brand>.notes.json.
 */
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { brands, getBrand, type Brand } from '../brands.js';
import { readJournal, appendJournal, type JournalEntry } from '../journal.js';
import { textResult, errorResult, round } from '../util.js';

export interface Metrics {
  spend: number;
  impressions: number;
  clicks: number;
  ctr: number;
  frequency: number;
  purchases: number;
  revenue: number;
  cpa: number | null;
  roas: number | null;
}
export interface MapAd {
  id: string;
  name: string;
  status: string;
  created_time?: string;
  creative?: { id?: string; thumbnail_url?: string; image_url?: string; title?: string; body?: string; type?: string };
  m7?: Metrics;
  m30?: Metrics;
}
export interface MapAdset {
  id: string;
  name: string;
  status: string;
  daily_budget?: number;
  optimization_goal?: string;
  targeting_summary?: string;
  m7?: Metrics;
  m30?: Metrics;
  ads: MapAd[];
}
export interface MapCampaign {
  id: string;
  name: string;
  status: string;
  objective?: string;
  daily_budget?: number;
  m7?: Metrics;
  m30?: Metrics;
  adsets: MapAdset[];
}
export interface BrandMap {
  brand: string;
  account: string;
  updated_at: string;
  source: 'graph' | 'claude';
  campaigns: MapCampaign[];
}
interface Notes {
  description?: string;
  nodes: Record<string, string>;
}

const dir = () => path.join(config.dataDir, 'meta');
const mapFile = (b: string) => path.join(dir(), `${b.replace(/[^a-z0-9_-]/gi, '_')}.json`);
const notesFile = (b: string) => path.join(dir(), `${b.replace(/[^a-z0-9_-]/gi, '_')}.notes.json`);

export async function loadMap(brand: string): Promise<BrandMap | null> {
  try {
    return JSON.parse(await fs.readFile(mapFile(brand), 'utf8')) as BrandMap;
  } catch {
    return null;
  }
}
async function saveMap(m: BrandMap): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  const tmp = `${mapFile(m.brand)}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(m));
  await fs.rename(tmp, mapFile(m.brand));
}
export async function loadNotes(brand: string): Promise<Notes> {
  try {
    return JSON.parse(await fs.readFile(notesFile(brand), 'utf8')) as Notes;
  } catch {
    return { nodes: {} };
  }
}
export async function saveNotes(brand: string, n: Notes): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await fs.writeFile(notesFile(brand), JSON.stringify(n));
}

// ---------- Graph API ----------
const GRAPH = 'https://graph.facebook.com/v23.0';
const INS = (alias: string, preset: string) => `insights.date_preset(${preset}).as(${alias}){spend,impressions,clicks,ctr,frequency,actions,action_values}`;

interface RawInsight {
  data?: { spend?: string; impressions?: string; clicks?: string; ctr?: string; frequency?: string; actions?: { action_type: string; value: string }[]; action_values?: { action_type: string; value: string }[] }[];
}

function toMetrics(i?: RawInsight): Metrics | undefined {
  const d = i?.data?.[0];
  if (!d) return undefined;
  const pick = (arr: { action_type: string; value: string }[] | undefined, types: string[]) => {
    for (const t of types) {
      const hit = arr?.find((a) => a.action_type === t);
      if (hit) return Number(hit.value);
    }
    return 0;
  };
  const spend = Number(d.spend ?? 0);
  const purchases = pick(d.actions, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']);
  const revenue = pick(d.action_values, ['omni_purchase', 'purchase', 'offsite_conversion.fb_pixel_purchase']);
  return {
    spend: round(spend, 0),
    impressions: Number(d.impressions ?? 0),
    clicks: Number(d.clicks ?? 0),
    ctr: round(Number(d.ctr ?? 0), 2),
    frequency: round(Number(d.frequency ?? 0), 2),
    purchases,
    revenue: round(revenue, 0),
    cpa: purchases > 0 ? round(spend / purchases, 0) : null,
    roas: spend > 0 ? round(revenue / spend, 2) : null,
  };
}

async function graphGetAll<T>(token: string, pathAndQuery: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | null = `${GRAPH}/${pathAndQuery}&limit=100&access_token=${encodeURIComponent(token)}`;
  for (let i = 0; url && i < 20; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const j = (await res.json()) as { data?: T[]; paging?: { next?: string }; error?: { message: string; code: number } };
    if (!res.ok || j.error) throw new Error(`Meta Graph: ${j.error?.message ?? res.statusText} (kod ${j.error?.code ?? res.status})`);
    out.push(...(j.data ?? []));
    url = j.paging?.next ?? null;
  }
  return out;
}

function summarizeTargeting(t: Record<string, unknown> | undefined): string {
  if (!t) return '';
  const geo = t.geo_locations as { countries?: string[]; regions?: { name: string }[]; cities?: { name: string }[] } | undefined;
  const parts: string[] = [];
  if (geo?.countries?.length) parts.push(geo.countries.join(','));
  if (geo?.regions?.length) parts.push(geo.regions.map((r) => r.name).join('/'));
  if (geo?.cities?.length) parts.push(geo.cities.map((c) => c.name).join('/'));
  if (t.age_min || t.age_max) parts.push(`${t.age_min ?? 18}–${t.age_max ?? 65}`);
  const ca = t.custom_audiences as { name?: string }[] | undefined;
  if (ca?.length) parts.push(`inkl: ${ca.map((c) => c.name ?? '?').join(', ')}`);
  const ex = t.excluded_custom_audiences as { name?: string }[] | undefined;
  if (ex?.length) parts.push(`exkl: ${ex.map((c) => c.name ?? '?').join(', ')}`);
  if ((t.targeting_automation as { advantage_audience?: number } | undefined)?.advantage_audience) parts.push('Advantage+');
  return parts.join(' · ');
}

export async function syncFromGraph(b: Brand, token: string): Promise<BrandMap> {
  if (!b.metaAccount) throw new Error(`"${b.key}" saknar Meta-konto i registret.`);
  const act = `act_${b.metaAccount.replace(/^act_/, '')}`;
  type C = { id: string; name: string; effective_status: string; objective?: string; daily_budget?: string; i7?: RawInsight; i30?: RawInsight };
  type S = { id: string; name: string; campaign_id: string; effective_status: string; daily_budget?: string; optimization_goal?: string; targeting?: Record<string, unknown>; i7?: RawInsight; i30?: RawInsight };
  type A = { id: string; name: string; adset_id: string; effective_status: string; created_time?: string; creative?: { id?: string; thumbnail_url?: string; image_url?: string; title?: string; body?: string; object_type?: string }; i7?: RawInsight; i30?: RawInsight };
  const [cs, ss, as] = await Promise.all([
    graphGetAll<C>(token, `${act}/campaigns?fields=id,name,effective_status,objective,daily_budget,${INS('i7', 'last_7d')},${INS('i30', 'last_30d')}&effective_status=["ACTIVE","PAUSED","WITH_ISSUES","IN_PROCESS"]`),
    graphGetAll<S>(token, `${act}/adsets?fields=id,name,campaign_id,effective_status,daily_budget,optimization_goal,targeting{geo_locations,age_min,age_max,custom_audiences,excluded_custom_audiences,targeting_automation},${INS('i7', 'last_7d')},${INS('i30', 'last_30d')}&effective_status=["ACTIVE","PAUSED","WITH_ISSUES","IN_PROCESS"]`),
    graphGetAll<A>(token, `${act}/ads?fields=id,name,adset_id,effective_status,created_time,creative.thumbnail_width(400).thumbnail_height(400){id,thumbnail_url,image_url,title,body,object_type},${INS('i7', 'last_7d')},${INS('i30', 'last_30d')}&effective_status=["ACTIVE","PAUSED","WITH_ISSUES","IN_PROCESS","DISAPPROVED","PENDING_REVIEW"]`),
  ]);
  const adsByAdset = new Map<string, MapAd[]>();
  for (const a of as) {
    const list = adsByAdset.get(a.adset_id) ?? [];
    list.push({ id: a.id, name: a.name, status: a.effective_status, created_time: a.created_time, creative: a.creative ? { id: a.creative.id, thumbnail_url: a.creative.thumbnail_url, image_url: a.creative.image_url, title: a.creative.title, body: a.creative.body?.slice(0, 300), type: a.creative.object_type } : undefined, m7: toMetrics(a.i7), m30: toMetrics(a.i30) });
    adsByAdset.set(a.adset_id, list);
  }
  const setsByCampaign = new Map<string, MapAdset[]>();
  for (const s of ss) {
    const list = setsByCampaign.get(s.campaign_id) ?? [];
    list.push({ id: s.id, name: s.name, status: s.effective_status, daily_budget: s.daily_budget ? Number(s.daily_budget) / 100 : undefined, optimization_goal: s.optimization_goal, targeting_summary: summarizeTargeting(s.targeting), m7: toMetrics(s.i7), m30: toMetrics(s.i30), ads: adsByAdset.get(s.id) ?? [] });
    setsByCampaign.set(s.campaign_id, list);
  }
  const map: BrandMap = {
    brand: b.key,
    account: act,
    updated_at: new Date().toISOString(),
    source: 'graph',
    campaigns: cs.map((c) => ({ id: c.id, name: c.name, status: c.effective_status, objective: c.objective, daily_budget: c.daily_budget ? Number(c.daily_budget) / 100 : undefined, m7: toMetrics(c.i7), m30: toMetrics(c.i30), adsets: setsByCampaign.get(c.id) ?? [] })),
  };
  await saveMap(map);
  return map;
}

/** Synkar alla varumärken med Meta-konto om token finns. Körs vid start och periodiskt. */
export async function syncAll(reason: string): Promise<void> {
  const token = config.metaAccessToken;
  if (!token) return;
  for (const b of brands()) {
    if (!b.metaAccount) continue;
    try {
      const m = await syncFromGraph(b, token);
      console.log(`[meta] ${b.key}: ${m.campaigns.length} kampanjer synkade (${reason})`);
    } catch (e) {
      console.error(`[meta] ${b.key}: synk misslyckades – ${(e as Error).message}`);
    }
  }
}

// ---------- Berikning: journal + bedömning ----------
export function grade(b: Brand, m?: Metrics): 'green' | 'yellow' | 'red' | 'grey' {
  if (!m || m.spend < 100) return 'grey';
  const breakEvenRoas = b.grossMarginPct ? 100 / b.grossMarginPct : null;
  const target = b.targetMer ?? (breakEvenRoas ? breakEvenRoas * 1.4 : null);
  if (m.roas === null) return m.spend > 300 ? 'red' : 'grey';
  if (target && m.roas >= target) return 'green';
  if (breakEvenRoas && m.roas >= breakEvenRoas) return 'yellow';
  if (!target && !breakEvenRoas) return m.roas >= 2 ? 'green' : m.roas >= 1 ? 'yellow' : 'red';
  return 'red';
}

function refsOf(e: JournalEntry): string[] {
  return Object.values(e.refs ?? {}).flatMap((v) => String(v).split(',').map((x) => x.trim())).filter(Boolean);
}

export async function enrichedMap(brand: string) {
  const b = getBrand(brand);
  const map = await loadMap(brand);
  const notes = await loadNotes(brand);
  const journal = (await readJournal(brand)).sort((x, y) => (x.ts < y.ts ? 1 : -1));
  const byRef = new Map<string, JournalEntry[]>();
  for (const e of journal) for (const r of refsOf(e)) byRef.set(r, [...(byRef.get(r) ?? []), e]);
  const j = (id: string) => (byRef.get(id) ?? []).slice(0, 8).map((e) => ({ id: e.id, ts: e.ts, type: e.type, title: e.title, detail: e.detail?.slice(0, 400), next_check: e.next_check, resolved: e.resolved }));
  const lastReport = journal.find((e) => e.type === 'report');
  return {
    brand: b.key,
    name: b.name,
    description: notes.description ?? '',
    target_mer: b.targetMer ?? null,
    break_even_roas: b.grossMarginPct ? round(100 / b.grossMarginPct, 2) : null,
    updated_at: map?.updated_at ?? null,
    source: map?.source ?? null,
    last_report: lastReport ? { ts: lastReport.ts, title: lastReport.title, detail: lastReport.detail } : null,
    campaigns: (map?.campaigns ?? []).map((c) => ({
      ...c,
      grade: grade(b, c.m7),
      note: notes.nodes[c.id] ?? '',
      journal: j(c.id),
      adsets: c.adsets.map((s) => ({
        ...s,
        grade: grade(b, s.m7),
        note: notes.nodes[s.id] ?? '',
        journal: j(s.id),
        ads: s.ads.map((a) => ({ ...a, grade: grade(b, a.m7), note: notes.nodes[a.id] ?? '', journal: j(a.id) })),
      })),
    })),
  };
}

// ---------- MCP-verktyg ----------
const metricsSchema = z.object({ spend: z.number(), impressions: z.number().optional(), clicks: z.number().optional(), ctr: z.number().optional(), frequency: z.number().optional(), purchases: z.number(), revenue: z.number().optional() });
const norm = (m?: z.infer<typeof metricsSchema>): Metrics | undefined =>
  m ? { spend: m.spend, impressions: m.impressions ?? 0, clicks: m.clicks ?? 0, ctr: m.ctr ?? 0, frequency: m.frequency ?? 0, purchases: m.purchases, revenue: m.revenue ?? 0, cpa: m.purchases > 0 ? round(m.spend / m.purchases, 0) : null, roas: m.spend > 0 && m.revenue ? round(m.revenue / m.spend, 2) : null } : undefined;

export function registerMetaMapTools(server: McpServer): void {
  server.registerTool(
    'meta_map_get',
    {
      title: 'Kampanjkarta (kampanj → adset → annons med kreativ, nyckeltal, journal)',
      description: 'Hela strukturen för ett varumärke med 7d/30d-nyckeltal per nod, bedömning (green/yellow/red mot mål-MER och break-even), thumbnails, beskrivningar och journalposter kopplade till varje id. Synkas från Meta av servern om Meta-token finns, annars via meta_map_put.',
      inputSchema: { brand: z.string(), include_ads: z.boolean().optional().describe('Default true.') },
    },
    async ({ brand, include_ads }) => {
      try {
        const m = await enrichedMap(brand);
        if (include_ads === false) m.campaigns = m.campaigns.map((c) => ({ ...c, adsets: c.adsets.map((s) => ({ ...s, ads: [] })) }));
        return textResult(m);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'meta_map_sync',
    {
      title: 'Synka kampanjkartan från Meta (kräver Meta-token i admin)',
      description: 'Hämtar kampanjer, adsets, annonser, kreativ och insights (7d/30d) direkt från Meta Graph API och sparar kartan. Läsande.',
      inputSchema: { brand: z.string() },
    },
    async ({ brand }) => {
      try {
        const token = config.metaAccessToken;
        if (!token) throw new Error('Ingen Meta-token. Lägg in en system user-token (ads_read) under Inställningar i admin, eller använd meta_map_put.');
        const m = await syncFromGraph(getBrand(brand), token);
        return textResult({ ok: true, updated_at: m.updated_at, campaigns: m.campaigns.length, adsets: m.campaigns.reduce((n, c) => n + c.adsets.length, 0), ads: m.campaigns.reduce((n, c) => n + c.adsets.reduce((k, s) => k + s.ads.length, 0), 0) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'meta_map_put',
    {
      title: 'Skicka in kampanjkarta från Meta Ads MCP',
      description: 'När servern saknar Meta-token: bygg strukturen från ads_get_ad_entities (level campaign/adset/ad, last_7d och last_30d) + ads_get_creatives och skicka in. Ersätter hela kartan för varumärket.',
      inputSchema: {
        brand: z.string(),
        campaigns: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            status: z.string(),
            objective: z.string().optional(),
            daily_budget: z.number().optional(),
            m7: metricsSchema.optional(),
            m30: metricsSchema.optional(),
            adsets: z.array(
              z.object({
                id: z.string(),
                name: z.string(),
                status: z.string(),
                daily_budget: z.number().optional(),
                optimization_goal: z.string().optional(),
                targeting_summary: z.string().optional(),
                m7: metricsSchema.optional(),
                m30: metricsSchema.optional(),
                ads: z.array(
                  z.object({
                    id: z.string(),
                    name: z.string(),
                    status: z.string(),
                    created_time: z.string().optional(),
                    creative: z.object({ id: z.string().optional(), thumbnail_url: z.string().optional(), image_url: z.string().optional(), title: z.string().optional(), body: z.string().optional(), type: z.string().optional() }).optional(),
                    m7: metricsSchema.optional(),
                    m30: metricsSchema.optional(),
                  }),
                ),
              }),
            ),
          }),
        ),
      },
    },
    async ({ brand, campaigns }) => {
      try {
        const b = getBrand(brand);
        const map: BrandMap = {
          brand: b.key,
          account: b.metaAccount ?? '',
          updated_at: new Date().toISOString(),
          source: 'claude',
          campaigns: campaigns.map((c) => ({ ...c, m7: norm(c.m7), m30: norm(c.m30), adsets: c.adsets.map((s) => ({ ...s, m7: norm(s.m7), m30: norm(s.m30), ads: s.ads.map((a) => ({ ...a, m7: norm(a.m7), m30: norm(a.m30) })) })) })),
        };
        await saveMap(map);
        return textResult({ ok: true, updated_at: map.updated_at, campaigns: map.campaigns.length });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'meta_map_note',
    {
      title: 'Beskrivning på varumärke eller nod i kartan',
      description: 'Sätter den övergripande beskrivningen för varumärkets annonsering (node_id utelämnad) eller en kort beskrivning/bedömning på en kampanj, ett adset eller en annons (node_id). Visas i kartan. Tom text tar bort.',
      inputSchema: { brand: z.string(), node_id: z.string().optional(), text: z.string().max(2000) },
    },
    async ({ brand, node_id, text }) => {
      try {
        getBrand(brand);
        const n = await loadNotes(brand);
        if (node_id) {
          if (text.trim()) n.nodes[node_id] = text.trim();
          else delete n.nodes[node_id];
        } else n.description = text.trim() || undefined;
        await saveNotes(brand, n);
        await appendJournal({ brand, type: 'note', title: node_id ? `Beskrivning uppdaterad för ${node_id}` : 'Övergripande beskrivning uppdaterad', detail: text.slice(0, 500), refs: node_id ? { node: node_id } : undefined, source: 'meta_map_note' }).catch(() => undefined);
        return textResult({ ok: true });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
