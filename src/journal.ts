/**
 * Journal: delad logg över vad som gjorts per varumärke (beslut, ändringar, rapporter, checkpoints).
 * Alla chattar, projekt och schemalagda rapporter läser och skriver samma journal → "för tätt inpå förra ändringen"
 * går att avgöra, och brand_status ger senaste läget utan att leta i gamla chattar.
 * Lagring: en fil per varumärke, data/journal/<brand>.jsonl (append-only, en JSON-rad per post). Persondata ska aldrig loggas.
 */
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from './config.js';
import { brands, getBrand } from './brands.js';
import { textResult, errorResult } from './util.js';

export const ENTRY_TYPES = ['change', 'decision', 'report', 'checkpoint', 'issue', 'note', 'deploy'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export interface JournalEntry {
  id: string;
  ts: string;
  brand: string; // varumärkesnyckel eller "platform"
  type: EntryType;
  title: string;
  detail?: string;
  refs?: Record<string, string>; // t.ex. { adset: "1202…", campaign: "…" }
  metrics?: Record<string, number>; // t.ex. { cpa: 150, spend_7d: 4200 }
  next_check?: string; // YYYY-MM-DD – när effekten ska utvärderas
  source?: string; // "chat", "scheduled:trailtails-2x", "admin"
  resolved?: boolean; // för issue/checkpoint
}

const dir = () => path.join(config.dataDir, 'journal');
const safe = (brand: string) => brand.replace(/[^a-z0-9_-]/gi, '_');
const file = (brand: string) => path.join(dir(), `${safe(brand)}.jsonl`);

async function readFile(brand: string): Promise<JournalEntry[]> {
  let raw = '';
  try {
    raw = await fs.readFile(file(brand), 'utf8');
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as JournalEntry);
    } catch {
      /* hoppa över trasig rad */
    }
  }
  return out;
}

/** Vilka varumärken som har en journalfil. */
export async function journalBrands(): Promise<string[]> {
  try {
    return (await fs.readdir(dir())).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6));
  } catch {
    return [];
  }
}

/** Läser ett varumärkes journal, eller alla om brand utelämnas. */
export async function readJournal(brand?: string): Promise<JournalEntry[]> {
  if (brand) return readFile(brand);
  const all = await Promise.all((await journalBrands()).map(readFile));
  return all.flat();
}

export async function appendJournal(e: Omit<JournalEntry, 'id' | 'ts'> & { ts?: string }): Promise<JournalEntry> {
  const entry: JournalEntry = { id: randomBytes(5).toString('hex'), ts: e.ts ?? new Date().toISOString(), ...e };
  await fs.mkdir(dir(), { recursive: true });
  await fs.appendFile(file(entry.brand), JSON.stringify(entry) + '\n');
  return entry;
}

async function markResolved(id: string, resolved: boolean): Promise<JournalEntry | undefined> {
  for (const brand of await journalBrands()) {
    const all = await readFile(brand);
    const hit = all.find((x) => x.id === id);
    if (!hit) continue;
    hit.resolved = resolved;
    const tmp = `${file(brand)}.tmp`;
    await fs.writeFile(tmp, all.map((x) => JSON.stringify(x)).join('\n') + '\n');
    await fs.rename(tmp, file(brand));
    return hit;
  }
  return undefined;
}

const daysSince = (iso: string) => Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000 * 10) / 10;

/** Sammanfattning av läget för ett varumärke – det Claude ska läsa först. */
export async function brandStatus(brand: string, limit = 15) {
  const all = await readJournal(brand);
  const sorted = [...all].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const lastChange = sorted.find((e) => e.type === 'change');
  const lastReport = sorted.find((e) => e.type === 'report');
  const openIssues = sorted.filter((e) => e.type === 'issue' && !e.resolved);
  const openCheckpoints = sorted.filter((e) => e.type === 'checkpoint' && !e.resolved);
  const nextCheck = sorted.filter((e) => e.next_check && !e.resolved).map((e) => e.next_check as string).sort()[0] ?? null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    brand,
    entries_total: all.length,
    last_change: lastChange ? { ...lastChange, days_ago: daysSince(lastChange.ts) } : null,
    last_report: lastReport ? { id: lastReport.id, ts: lastReport.ts, title: lastReport.title, days_ago: daysSince(lastReport.ts) } : null,
    next_check: nextCheck,
    next_check_due: nextCheck ? nextCheck <= today : false,
    open_issues: openIssues,
    open_checkpoints: openCheckpoints,
    guidance:
      lastChange && daysSince(lastChange.ts) < 3
        ? `Senaste ändringen gjordes för ${daysSince(lastChange.ts)} dagar sedan – vänta minst 72 h innan nästa budget-/målgruppsändring om inte något akut (CPA > break-even, spend utan konverteringar).`
        : 'Ingen ändring de senaste 3 dagarna – justering är OK om data motiverar det.',
    recent: sorted.slice(0, limit),
  };
}

export function registerJournalTools(server: McpServer): void {
  server.registerTool(
    'brand_status',
    {
      title: 'Läge för ett varumärke (läs först)',
      description:
        'Senaste ändring (och hur många dagar sedan), senaste rapport, nästa checkpoint, öppna problem och de senaste journalposterna. Anropa först i varje chatt/rapport så att du inte justerar för tätt inpå förra ändringen och känner till öppna beslut. brand="platform" för MCP/infra.',
      inputSchema: { brand: z.string(), limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ brand, limit }) => {
      try {
        if (brand !== 'platform') getBrand(brand);
        return textResult(await brandStatus(brand, limit ?? 15));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'journal_add',
    {
      title: 'Logga en händelse i journalen',
      description:
        'Skriv en post: change (något ändrades i Meta/Woo/konfig – ange refs med id:n och metrics före), decision (Linus beslut, även "nej"), report (skickad rapport med nyckeltal), checkpoint (när något ska utvärderas – sätt next_check), issue (öppet problem), note, deploy. Logga ALLTID efter en skrivande åtgärd och efter varje rapport. Aldrig persondata.',
      inputSchema: {
        brand: z.string().describe('Varumärkesnyckel eller "platform".'),
        type: z.enum(ENTRY_TYPES),
        title: z.string().max(200),
        detail: z.string().max(4000).optional(),
        refs: z.record(z.string()).optional().describe('Id:n: adset, campaign, ad, product_ids, commit …'),
        metrics: z.record(z.number()).optional().describe('Nyckeltal vid tillfället: cpa, roas, mer, spend_7d, budget_before, budget_after …'),
        next_check: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Datum då effekten ska utvärderas.'),
        source: z.string().optional().describe('t.ex. "chat", "scheduled:trailtails-2x".'),
      },
    },
    async (input) => {
      try {
        if (input.brand !== 'platform') getBrand(input.brand);
        const e = await appendJournal({ ...input, source: input.source ?? 'chat' });
        return textResult({ ok: true, entry: e });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'journal_list',
    {
      title: 'Lista journalposter',
      description: 'Filtrera på varumärke, typ, datumintervall eller fritext. Nyaste först.',
      inputSchema: {
        brand: z.string().optional(),
        type: z.enum(ENTRY_TYPES).optional(),
        since: z.string().optional().describe('YYYY-MM-DD'),
        until: z.string().optional().describe('YYYY-MM-DD'),
        search: z.string().optional(),
        open_only: z.boolean().optional().describe('Bara olösta issue/checkpoint.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    async ({ brand, type, since, until, search, open_only, limit }) => {
      try {
        let all = await readJournal(brand);
        if (type) all = all.filter((e) => e.type === type);
        if (since) all = all.filter((e) => e.ts.slice(0, 10) >= since);
        if (until) all = all.filter((e) => e.ts.slice(0, 10) <= until);
        if (open_only) all = all.filter((e) => (e.type === 'issue' || e.type === 'checkpoint') && !e.resolved);
        if (search) {
          const q = search.toLowerCase();
          all = all.filter((e) => `${e.title} ${e.detail ?? ''} ${JSON.stringify(e.refs ?? {})}`.toLowerCase().includes(q));
        }
        all.sort((a, b) => (a.ts < b.ts ? 1 : -1));
        return textResult({ count: all.length, entries: all.slice(0, limit ?? 50) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'journal_resolve',
    {
      title: 'Markera issue/checkpoint som löst',
      description: 'Sätter resolved=true (eller false) på en post. Logga gärna en note/decision om utfallet samtidigt.',
      inputSchema: { id: z.string(), resolved: z.boolean().optional() },
    },
    async ({ id, resolved }) => {
      try {
        const e = await markResolved(id, resolved ?? true);
        if (!e) throw new Error(`Ingen post med id ${id}.`);
        return textResult({ ok: true, entry: e });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'journal_overview',
    {
      title: 'Alla varumärken – läge i korthet',
      description: 'En rad per varumärke: senaste ändring, nästa checkpoint, öppna problem. Bra start för veckoanalysen.',
      inputSchema: {},
    },
    async () => {
      try {
        const keys = ['platform', ...brands().map((b) => b.key)];
        const rows = await Promise.all(keys.map(async (k) => {
          const s = await brandStatus(k, 1);
          return { brand: k, entries: s.entries_total, last_change: s.last_change ? { title: s.last_change.title, days_ago: s.last_change.days_ago } : null, next_check: s.next_check, next_check_due: s.next_check_due, open_issues: s.open_issues.length, open_checkpoints: s.open_checkpoints.length };
        }));
        return textResult({ brands: rows });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
