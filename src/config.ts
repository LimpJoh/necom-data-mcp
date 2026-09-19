import 'dotenv/config';
import { brands, type Brand } from './brands.js';

/** Woo-butik i det format Woo-verktygen använder (härlett ur varumärkesregistret). */
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

function wooStores(): WooStore[] {
  return brands()
    .filter((b): b is Brand & { woo: NonNullable<Brand['woo']>; url: string } => Boolean(b.woo && b.url))
    .map((b) => ({ key: b.key, name: b.name, url: b.url, user: b.woo.user, appPassword: b.woo.appPassword, ga4Property: b.ga4Property }));
}

export const config = {
  port: Number(env('PORT', '3010')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3010').replace(/\/$/, ''),
  loginPassword: env('MCP_LOGIN_PASSWORD'),
  stateFile: env('MCP_STATE_FILE', './data/oauth-state.json'),
  accessTokenTtl: Number(env('MCP_ACCESS_TOKEN_TTL', '3600')),
  ga4Credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '',
  ga4Extra: parseKv(process.env.GA4_EXTRA_PROPERTIES ?? ''),
  stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
  mollieAccessToken: process.env.MOLLIE_ACCESS_TOKEN ?? '',
  dogshowpro: {
    url: process.env.DOGSHOWPRO_SUPABASE_URL ?? brands().find((b) => b.key === 'dogshowpro')?.supabase?.url ?? '',
    serviceRoleKey: process.env.DOGSHOWPRO_SUPABASE_SERVICE_ROLE_KEY ?? brands().find((b) => b.key === 'dogshowpro')?.supabase?.serviceRoleKey ?? '',
  },
  ops: {
    enabled: (process.env.OPS_ENABLED ?? 'false').toLowerCase() === 'true',
    githubToken: process.env.OPS_GITHUB_TOKEN ?? '',
    githubOwner: process.env.OPS_GITHUB_OWNER ?? '',
    supabaseAccessToken: process.env.OPS_SUPABASE_ACCESS_TOKEN ?? '',
    supabaseOrgId: process.env.OPS_SUPABASE_ORG_ID ?? '',
    hostingerToken: process.env.OPS_HOSTINGER_TOKEN ?? '',
    vpsIp: process.env.OPS_VPS_IP ?? '',
    sshHost: process.env.OPS_SSH_HOST ?? 'host.docker.internal',
    sshUser: process.env.OPS_SSH_USER ?? 'deploy',
    sshKeyFile: process.env.OPS_SSH_KEY_FILE ?? '/app/data/ops_ssh_key',
    auditLog: process.env.OPS_AUDIT_LOG ?? './data/ops-audit.log',
  },
  get stores(): WooStore[] {
    return wooStores();
  },
};

function parseKv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split('=').map((s) => s?.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

/** Alla GA4-properties: varumärkesnyckel -> propertyId, plus extra. */
export function ga4Properties(): Record<string, string> {
  const out: Record<string, string> = { ...config.ga4Extra };
  for (const b of brands()) if (b.ga4Property) out[b.key] = b.ga4Property;
  return out;
}

export function getStore(key: string): WooStore {
  const s = config.stores.find((x) => x.key === key);
  if (!s) {
    throw new Error(`Okänd Woo-butik "${key}". Tillgängliga: ${config.stores.map((x) => x.key).join(', ') || '(inga konfigurerade)'}`);
  }
  return s;
}
