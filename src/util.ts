/** Datumhjälpare. Alla datum tolkas i Europe/Stockholm-dygn. */

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return isoDate(d);
}

/** Tolkar 'since'/'until' (YYYY-MM-DD eller relativa uttryck som '7d', '30d'). Default: senaste 30 dagarna t.o.m. igår. */
export function resolveRange(since?: string, until?: string): { since: string; until: string } {
  const u = until && /^\d{4}-\d{2}-\d{2}$/.test(until) ? until : daysAgo(0);
  let s: string;
  if (!since) s = daysAgo(30);
  else if (/^\d+d$/.test(since)) s = daysAgo(Number(since.slice(0, -1)));
  else if (/^\d{4}-\d{2}-\d{2}$/.test(since)) s = since;
  else throw new Error(`Ogiltigt since: "${since}". Använd YYYY-MM-DD eller t.ex. "7d".`);
  if (s > u) throw new Error(`since (${s}) är efter until (${u}).`);
  return { since: s, until: u };
}

export function round(n: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function pct(part: number, whole: number): number | null {
  return whole > 0 ? round((part / whole) * 100, 2) : null;
}

export function safeDiv(a: number, b: number): number | null {
  return b > 0 ? round(a / b, 2) : null;
}

/** Textresultat för MCP-verktyg. */
export function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: 'text' as const, text: `Fel: ${message}` }] };
}
