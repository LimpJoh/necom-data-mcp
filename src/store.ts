/**
 * Krypterad lagring av varumärkesregister och globala inställningar (data/store.enc).
 * Nyckel: data/store.key (skapas automatiskt, chmod 600). AES-256-GCM.
 * .env fungerar fortfarande som fallback – det som sparas via admin-gränssnittet vinner.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface StoredBrand {
  key: string;
  name: string;
  platform: 'woo' | 'supabase' | 'none';
  url?: string;
  woo_user?: string;
  woo_app_password?: string;
  supabase_url?: string;
  supabase_service_role_key?: string;
  sales_view?: string;
  ga4_property?: string;
  gsc_site?: string;
  meta_account?: string;
  meta_pixel?: string;
  meta_catalog?: string;
  gross_margin_pct?: number;
  target_mer?: number;
  stripe_account?: string;
  mollie_profile?: string;
  etsy_shop_id?: string;
  notes?: string;
  updated_at?: string;
}

export interface Settings {
  stripe_secret_key?: string;
  mollie_access_token?: string;
  ops_enabled?: boolean;
  ops_github_token?: string;
  ops_github_owner?: string;
  ops_supabase_access_token?: string;
  ops_supabase_org_id?: string;
  ops_hostinger_token?: string;
  ops_vps_ip?: string;
  ops_ssh_user?: string;
  updated_at?: string;
}

interface StoreData {
  brands: StoredBrand[];
  settings: Settings;
}

const dataDir = () => path.dirname(process.env.MCP_STATE_FILE ?? './data/oauth-state.json');
const storeFile = () => path.join(dataDir(), 'store.enc');
const keyFile = () => path.join(dataDir(), 'store.key');

let cache: StoreData | null = null;
let key: Buffer | null = null;
export const listeners: Array<() => void> = [];

async function loadKey(): Promise<Buffer> {
  if (key) return key;
  await fs.mkdir(dataDir(), { recursive: true });
  try {
    key = Buffer.from((await fs.readFile(keyFile(), 'utf8')).trim(), 'hex');
  } catch {
    key = randomBytes(32);
    await fs.writeFile(keyFile(), key.toString('hex'), { mode: 0o600 });
  }
  return key;
}

function encrypt(k: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(k: Buffer, b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export async function loadStore(): Promise<StoreData> {
  if (cache) return cache;
  const k = await loadKey();
  try {
    cache = JSON.parse(decrypt(k, await fs.readFile(storeFile(), 'utf8'))) as StoreData;
  } catch {
    cache = { brands: [], settings: {} };
  }
  cache.brands ??= [];
  cache.settings ??= {};
  return cache;
}

export function storeSync(): StoreData {
  return cache ?? { brands: [], settings: {} };
}

export async function saveStore(data: StoreData): Promise<void> {
  const k = await loadKey();
  cache = data;
  const tmp = `${storeFile()}.tmp`;
  await fs.writeFile(tmp, encrypt(k, JSON.stringify(data)), { mode: 0o600 });
  await fs.rename(tmp, storeFile());
  for (const l of listeners) l();
}

export async function upsertBrand(b: StoredBrand): Promise<void> {
  const s = await loadStore();
  const i = s.brands.findIndex((x) => x.key === b.key);
  const prev = i >= 0 ? s.brands[i] : undefined;
  // Tomma lösenordsfält i formuläret betyder "behåll".
  const merged: StoredBrand = { ...prev, ...b, updated_at: new Date().toISOString() };
  for (const f of ['woo_app_password', 'supabase_service_role_key'] as const) if (!b[f] && prev?.[f]) merged[f] = prev[f];
  if (i >= 0) s.brands[i] = merged;
  else s.brands.push(merged);
  await saveStore(s);
}

export async function deleteBrand(k: string): Promise<void> {
  const s = await loadStore();
  s.brands = s.brands.filter((x) => x.key !== k);
  await saveStore(s);
}

export async function updateSettings(patch: Settings): Promise<void> {
  const s = await loadStore();
  const merged: Settings = { ...s.settings, updated_at: new Date().toISOString() };
  for (const [k, v] of Object.entries(patch) as [keyof Settings, unknown][]) {
    if (typeof v === 'boolean') (merged as Record<string, unknown>)[k] = v;
    else if (typeof v === 'string' && v !== '') (merged as Record<string, unknown>)[k] = v;
    // tom sträng = behåll befintligt
  }
  s.settings = merged;
  await saveStore(s);
}

/** Inställning från store, annars env. */
export function setting(name: keyof Settings, envName: string): string {
  const v = storeSync().settings[name];
  if (typeof v === 'string' && v) return v;
  return process.env[envName] ?? '';
}
