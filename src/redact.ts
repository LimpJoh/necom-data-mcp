/**
 * Redigering av credential-formade strängar innan de skrivs till delad, läsbar lagring.
 *
 * Varför: journalen (data/journal/<brand>.jsonl) läses av varje agent vid varje heartbeat via
 * brand_status och journal_list. En hemlighet som hamnar i `detail` sprids därför till alla
 * agenter, varje körning, utan att någon ber om den – och ligger kvar i journalen även efter
 * att nyckeln roterats. Därför redigeras allt som skrivs i appendJournal() (en strypning som
 * täcker både ops_*-verktygen och manuella journal_add-anrop) och varje rad i ops-audit-loggen.
 *
 * Designval:
 *  - Två sorters mönster: värdeform (kända prefix, JWT, PEM-block) och nyckelnamn
 *    (NAME=…, "NAME": …, --password …, Authorization: …). Värdeformen fångar hemligheter som
 *    klistrats in utan namn, nyckelnamnet fångar hemligheter vars form vi inte känner.
 *  - Bara värdet maskeras, aldrig nyckelnamnet: loggen ska fortfarande gå att felsöka med.
 *  - Ingen entropiheuristik. Den maskerar commit-sha:n, order-id:n och Meta-id:n och gör
 *    journalen oläslig – dyrare än den marginella träffsäkerheten den ger.
 *  - Sökvägar, shell-variabler och platshållare lämnas: OPS_SSH_KEY_FILE=/app/data/ops_ssh_key
 *    och Authorization: Bearer $K är inte hemligheter.
 */

export const MASK = '[REDACTED]';

export const SECRET_CLASSES = [
  'private_key',
  'jwt',
  'stripe',
  'woocommerce',
  'github',
  'supabase_pat',
  'google_api',
  'aws',
  'slack',
  'resend',
  'mollie',
  'url_userinfo',
  'auth_header',
  'named_value',
  'cli_flag',
] as const;

export type SecretClass = (typeof SECRET_CLASSES)[number];

/** Nyckelnamn vars värde alltid maskeras. Används i NAME=…, "NAME": … och \"NAME\": …. */
const NAME =
  '[A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|PWD|PASS|SECRET|TOKEN|APIKEY|API[_-]?KEY|ACCESS[_-]?KEY|SERVICE[_-]?ROLE|ANON[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|SESSION|COOKIE|BEARER|AUTH)[A-Za-z0-9_.-]*';

/**
 * Värden som inte är hemligheter även när nyckeln låter så: sökvägar, shell-variabler,
 * platshållare, booleaner – och auth-schemaorden själva, så att
 * `Authorization: Bearer $K` inte blir `Authorization: [REDACTED] $K`.
 */
const NOT_SECRET =
  /^(?:[./~]|\$|\{|<|%|(?:true|false|null|undefined|yes|no|on|off|saknas|bearer|basic|token)$)/i;

/** Kortare än så här är inte en nyckel – och maskering skulle bara göra loggen svårläst. */
const MIN_VALUE_LEN = 6;

const unquote = (v: string): string => v.replace(/^(['"])([\s\S]*)\1$/, '$2');

/** Ser det infångade värdet ut som en hemlighet alls? */
function looksSecret(raw: string | undefined): boolean {
  const v = unquote((raw ?? '').trim());
  return v.length >= MIN_VALUE_LEN && !NOT_SECRET.test(v);
}

interface Rule {
  cls: SecretClass;
  re: RegExp;
  /** Returnerar `m` oförändrat när värdet inte ser ut som en hemlighet. */
  fix: (m: string, g: (string | undefined)[]) => string;
}

const rules: Rule[] = [
  // ---------- värdeform: hela träffen är hemligheten ----------
  {
    cls: 'private_key',
    re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z]+ )*PRIVATE KEY-----/g,
    fix: () => MASK,
  },
  // JWT: Supabase anon/service_role, GCP service accounts, egna sessionstokens.
  { cls: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?/g, fix: () => MASK },
  { cls: 'stripe', re: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, fix: () => MASK },
  { cls: 'woocommerce', re: /\b(?:ck|cs)_[0-9a-f]{40}\b/g, fix: () => MASK },
  { cls: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g, fix: () => MASK },
  { cls: 'supabase_pat', re: /\bsbp_[0-9a-f]{40}\b/g, fix: () => MASK },
  { cls: 'google_api', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, fix: () => MASK },
  { cls: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, fix: () => MASK },
  { cls: 'slack', re: /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g, fix: () => MASK },
  { cls: 'resend', re: /\bre_[A-Za-z0-9]{24,}\b/g, fix: () => MASK },
  { cls: 'mollie', re: /\b(?:live|test)_[A-Za-z0-9]{28,}\b/g, fix: () => MASK },

  // ---------- struktur: nyckeln kvar, värdet maskerat ----------
  // postgres://user:pass@host, https://user:pass@host
  {
    cls: 'url_userinfo',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@"'\\]{1,64}):([^\s/@"'\\]{1,256})@/gi,
    fix: (m, g) => (looksSecret(g[2]) ? `${g[0]}${g[1]}:${MASK}@` : m),
  },
  // -H "Authorization: Bearer …", -H "apikey: …"
  {
    cls: 'auth_header',
    re: /\b(authorization|apikey|api[-_]key|x-api-key|x-auth-token|proxy-authorization)(\s*:\s*)(bearer\s+|basic\s+|token\s+)?([^\s"'\\,}]{6,})/gi,
    fix: (m, g) => (looksSecret(g[3]) ? `${g[0]}${g[1]}${g[2] ?? ''}${MASK}` : m),
  },
  // NAME=värde (env-filer, export, inline-variabler före ett kommando)
  {
    cls: 'named_value',
    re: new RegExp(String.raw`\b(${NAME})(\s*=\s*)("[^"]*"|'[^']*'|[^\s;&|)}"']+)`, 'gi'),
    fix: (m, g) => (looksSecret(g[2]) ? `${g[0]}${g[1]}${MASK}` : m),
  },
  // "name": "värde" – och samma sak i text som redan JSON-serialiserats en eller flera
  // gånger (\"name\":\"värde\", \\\"name\\\":\\\"värde\\\"). Backreferensen \2 låser
  // citattecknens escape-nivå, så alla djup täcks av en regel. Avslutande citat lämnas
  // orört: bara värdet byts ut.
  {
    cls: 'named_value',
    re: new RegExp(String.raw`((\\*)"${NAME}\2"\s*:\s*\2")((?:(?!\2").)*)`, 'gi'),
    fix: (m, g) => (looksSecret(g[2]) ? `${g[0]}${MASK}` : m),
  },
  // --password värde, --token=värde
  {
    cls: 'cli_flag',
    re: /(\s--?(?:password|passwd|pass|token|secret|api[-_]?key|apikey|access[-_]?token)[=\s]+)("[^"]*"|'[^']*'|[^\s"']+)/gi,
    fix: (m, g) => (looksSecret(g[1]) ? `${g[0]}${MASK}` : m),
  },
  // curl -u user:pass
  {
    cls: 'cli_flag',
    re: /(\s-u\s+)([^\s"':]{1,64}):([^\s"']{4,})/g,
    fix: (m, g) => (looksSecret(g[2]) ? `${g[0]}${g[1]}:${MASK}` : m),
  },
  // mysql -plösenord (men inte -p 5432 eller -p3000:3000)
  {
    cls: 'cli_flag',
    re: /(\s-p)(?!\d+(?::|\s|$))([^\s"'=]{6,})/g,
    fix: (m, g) => (looksSecret(g[1]) ? `${g[0]}${MASK}` : m),
  },
];

function apply(text: string, r: Rule): string {
  return text.replace(r.re, (...args: any[]) => {
    const m = args[0] as string;
    const groups = args.slice(1, args.length - 2).map((x) => (typeof x === 'string' ? x : undefined));
    return r.fix(m, groups);
  });
}

/** Maskerar allt credential-format i en sträng. Returnerar texten oförändrad om inget hittas. */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const r of rules) out = apply(out, r);
  return out;
}

/**
 * Vilka klasser av hemligheter texten innehåller – för inventering utan att returnera värden.
 * En klass räknas som träffad när dess regel faktiskt ändrar texten, så samma undantag
 * (sökvägar, shell-variabler, för korta värden) gäller som vid maskering.
 */
export function classify(input: string): SecretClass[] {
  if (!input) return [];
  const hits = new Set<SecretClass>();
  for (const r of rules) if (apply(input, r) !== input) hits.add(r.cls);
  return [...hits];
}

export function containsSecret(input: string): boolean {
  return classify(input).length > 0;
}

/**
 * Rollerna i de JWT-formade värdena i texten – för triage, inte för maskering.
 * Skillnaden är hela rotationsbeslutet: en Supabase `anon`-nyckel är publik by design och
 * ligger redan i klientbundlar, medan en `service_role`-nyckel går förbi RLS och måste
 * roteras. Returnerar bara rollnamn, aldrig tokens.
 */
export function jwtRoles(input: string): string[] {
  if (!input) return [];
  const out: string[] = [];
  const re = /\beyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})(?:\.[A-Za-z0-9_-]{10,})?/g;
  for (const m of input.matchAll(re)) {
    try {
      const claims = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8')) as { role?: unknown };
      out.push(typeof claims.role === 'string' ? claims.role : 'ingen_roll');
    } catch {
      out.push('okand');
    }
  }
  return out;
}

/** Maskerar varje sträng i ett objekt/array rekursivt. Nycklar lämnas orörda. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as unknown as T;
  }
  return value;
}

/**
 * Kort, journalsäker sammanfattning av ett kommando: de första orden i varje steg.
 * Journalen ska svara på "vad gjordes", inte reproducera kommandot – hela det redigerade
 * kommandot finns i ops-audit-loggen i datamappen, som inte läses av varje agent.
 */
export function summarizeCommand(command: string, max = 160): string {
  const head = command
    .split(/&&|\|\||[;|]/)
    .map((seg) => seg.trim().split(/\s+/).slice(0, 3).join(' '))
    .filter(Boolean)
    .join(' → ');
  const safe = redact(head);
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}
