import 'dotenv/config';
import { brands, type Brand } from './brands.js';
import { setting, storeSync } from './store.js';

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

const stateFile = env('MCP_STATE_FILE', './data/oauth-state.json');
const dataDir = stateFile.replace(/[^/\\]+$/, '') || './data/';

export const config = {
  port: Number(env('PORT', '3010')),
  publicUrl: env('PUBLIC_URL', 'http://localhost:3010').replace(/\/$/, ''),
  loginPassword: env('MCP_LOGIN_PASSWORD'),
  stateFile,
  dataDir,
  accessTokenTtl: Number(env('MCP_ACCESS_TOKEN_TTL', '3600')),
  ga4Credentials: process.env.GOOGLE_APPLICATION_CREDENTIALS ?? `${dataDir}ga4-service-account.json`,
  ga4Extra: parseKv(process.env.GA4_EXTRA_PROPERTIES ?? ''),
  get stripeSecretKey(): string {
    return setting('stripe_secret_key', 'STRIPE_SECRET_KEY');
  },
  get mollieAccessToken(): string {
    return setting('mollie_access_token', 'MOLLIE_ACCESS_TOKEN');
  },
  dogshowpro: {
    get url(): string {
      return process.env.DOGSHOWPRO_SUPABASE_URL ?? brands().find((b) => b.key === 'dogshowpro')?.supabase?.url ?? '';
    },
    get serviceRoleKey(): string {
      return process.env.DOGSHOWPRO_SUPABASE_SERVICE_ROLE_KEY ?? brands().find((b) => b.key === 'dogshowpro')?.supabase?.serviceRoleKey ?? '';
    },
  },
  ops: {
    get enabled(): boolean {
      const s = storeSync().settings.ops_enabled;
      if (typeof s === 'boolean') return s;
      return (process.env.OPS_ENABLED ?? 'false').toLowerCase() === 'true';
    },
    get githubToken(): string {
      return setting('ops_github_token', 'OPS_GITHUB_TOKEN');
    },
    get githubOwner(): string {
      return setting('ops_github_owner', 'OPS_GITHUB_OWNER');
    },
    get supabaseAccessToken(): string {
      return setting('ops_supabase_access_token', 'OPS_SUPABASE_ACCESS_TOKEN');
    },
    get supabaseOrgId(): string {
      return setting('ops_supabase_org_id', 'OPS_SUPABASE_ORG_ID');
    },
    get hostingerToken(): string {
      return setting('ops_hostinger_token', 'OPS_HOSTINGER_TOKEN');
    },
    get vpsIp(): string {
      return setting('ops_vps_ip', 'OPS_VPS_IP');
    },
    sshHost: process.env.OPS_SSH_HOST ?? 'host.docker.internal',
    get sshUser(): string {
      return setting('ops_ssh_user', 'OPS_SSH_USER') || 'deploy';
    },
    sshKeyFile: process.env.OPS_SSH_KEY_FILE ?? `${dataDir}ops_ssh_key`,
    auditLog: process.env.OPS_AUDIT_LOG ?? `${dataDir}ops-audit.log`,
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
