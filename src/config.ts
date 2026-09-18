import 'dotenv/config';

export interface WooStore {
  key: string;
  name: string;
  url: string;
  user: string;
  appPassword: string;
  ga4Property?: string;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Saknad miljövariabel: ${name}`);
  }
  return v;
}

export const config = {
  port: Number(env('PORT', '3010')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3010').replace(/\/$/, ''),
  loginPassword: env('MCP_LOGIN_PASSWORD'),
  stateFile: env('MCP_STATE_FILE', './data/oauth-state.json'),
  accessTokenTtl: Number(env('MCP_ACCESS_TOKEN_TTL', '3600')),
  ga4Credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
  ga4Extra: parseGa4Extra(process.env.GA4_EXTRA_PROPERTIES ?? ''),
  dogshowpro: {
    url: process.env.DOGSHOWPRO_SUPABASE_URL ?? '',
    serviceRoleKey: process.env.DOGSHOWPRO_SUPABASE_SERVICE_ROLE_KEY ?? '',
  },
  stores: loadStores(),
};

function loadStores(): WooStore[] {
  const keys = (process.env.WOO_STORES ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  const stores: WooStore[] = [];
  for (const key of keys) {
    const user = process.env[`WOO_${key}_USER`] ?? '';
    const appPassword = process.env[`WOO_${key}_APP_PASSWORD`] ?? '';
    const url = (process.env[`WOO_${key}_URL`] ?? '').replace(/\/$/, '');
    if (!url || !user || !appPassword) {
      console.warn(`[config] Butik "${key}" hoppas över – URL/USER/APP_PASSWORD saknas.`);
      continue;
    }
    stores.push({
      key,
      name: process.env[`WOO_${key}_NAME`] ?? key,
      url,
      user,
      appPassword: appPassword.replace(/\s+/g, ''),
      ga4Property: process.env[`WOO_${key}_GA4_PROPERTY`] || undefined,
    });
  }
  return stores;
}

function parseGa4Extra(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s?.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

/** Alla GA4-properties: butiksnyckel -> propertyId, plus extra. */
export function ga4Properties(): Record<string, string> {
  const out: Record<string, string> = { ...config.ga4Extra };
  for (const s of config.stores) if (s.ga4Property) out[s.key] = s.ga4Property;
  return out;
}

export function getStore(key: string): WooStore {
  const s = config.stores.find((x) => x.key === key);
  if (!s) {
    throw new Error(
      `Okänd butik "${key}". Tillgängliga: ${config.stores.map((x) => x.key).join(', ') || '(inga konfigurerade)'}`,
    );
  }
  return s;
}
