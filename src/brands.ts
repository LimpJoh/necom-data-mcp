/**
 * Varumärkesregister. Ett varumärke = en nyckel (t.ex. "outlets"); alla källor hänger på nyckeln.
 *
 *   BRANDS=outlets,dogshowpro
 *   BRAND_outlets_NAME=Outlets.se
 *   BRAND_outlets_PLATFORM=woo | supabase | none
 *   BRAND_outlets_URL=https://outlets.se
 *   BRAND_outlets_WOO_USER / _WOO_APP_PASSWORD
 *   BRAND_outlets_SUPABASE_URL / _SUPABASE_SERVICE_ROLE_KEY / _SALES_VIEW (default v_sales)
 *   BRAND_outlets_GA4_PROPERTY, _GSC_SITE, _META_ACCOUNT, _META_PIXEL, _META_CATALOG
 *   BRAND_outlets_GROSS_MARGIN_PCT, _TARGET_MER, _STRIPE_ACCOUNT, _MOLLIE_PROFILE, _ETSY_SHOP_ID
 *
 * Bakåtkompatibelt: WOO_STORES + WOO_<key>_* läses också och blir varumärken med platform=woo.
 */

import { storeSync, listeners } from './store.js';

export type Platform = 'woo' | 'supabase' | 'none';

export interface Brand {
  key: string;
  name: string;
  platform: Platform;
  url?: string;
  woo?: { user: string; appPassword: string };
  supabase?: { url: string; serviceRoleKey: string; salesView: string };
  ga4Property?: string;
  gscSite?: string;
  metaAccount?: string;
  metaPixel?: string;
  metaCatalog?: string;
  grossMarginPct?: number;
  targetMer?: number;
  stripeAccount?: string;
  mollieProfile?: string;
  etsyShopId?: string;
  allowWrites?: boolean;
}

const e = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};
const num = (k: string): number | undefined => {
  const v = e(k);
  return v === undefined ? undefined : Number(v);
};
const list = (v?: string): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

let cache: Brand[] | null = null;

export function brands(): Brand[] {
  if (cache) return cache;
  const out = new Map<string, Brand>();

  // Nytt format
  for (const key of list(e('BRANDS'))) {
    const P = `BRAND_${key}_`;
    const platform = (e(`${P}PLATFORM`) ?? (e(`${P}WOO_USER`) ? 'woo' : e(`${P}SUPABASE_URL`) ? 'supabase' : 'none')) as Platform;
    const b: Brand = {
      key,
      name: e(`${P}NAME`) ?? key,
      platform,
      url: e(`${P}URL`)?.replace(/\/$/, ''),
      ga4Property: e(`${P}GA4_PROPERTY`),
      gscSite: e(`${P}GSC_SITE`),
      metaAccount: e(`${P}META_ACCOUNT`),
      metaPixel: e(`${P}META_PIXEL`),
      metaCatalog: e(`${P}META_CATALOG`),
      grossMarginPct: num(`${P}GROSS_MARGIN_PCT`),
      targetMer: num(`${P}TARGET_MER`),
      stripeAccount: e(`${P}STRIPE_ACCOUNT`),
      mollieProfile: e(`${P}MOLLIE_PROFILE`),
      etsyShopId: e(`${P}ETSY_SHOP_ID`),
    };
    if (platform === 'woo') {
      const user = e(`${P}WOO_USER`);
      const pw = e(`${P}WOO_APP_PASSWORD`);
      if (!b.url || !user || !pw) {
        console.warn(`[brands] "${key}" (woo) saknar URL/WOO_USER/WOO_APP_PASSWORD – Woo-verktyg inaktiva för det varumärket.`);
      } else b.woo = { user, appPassword: pw.replace(/\s+/g, '') };
    }
    if (platform === 'supabase') {
      const url = e(`${P}SUPABASE_URL`);
      const k = e(`${P}SUPABASE_SERVICE_ROLE_KEY`);
      if (!url || !k) console.warn(`[brands] "${key}" (supabase) saknar SUPABASE_URL/SERVICE_ROLE_KEY.`);
      else b.supabase = { url, serviceRoleKey: k, salesView: e(`${P}SALES_VIEW`) ?? 'v_sales' };
    }
    out.set(key, b);
  }

  // Gammalt format (WOO_STORES) – fylls bara om nyckeln inte redan finns
  for (const key of list(e('WOO_STORES'))) {
    if (out.has(key)) continue;
    const url = e(`WOO_${key}_URL`)?.replace(/\/$/, '');
    const user = e(`WOO_${key}_USER`);
    const pw = e(`WOO_${key}_APP_PASSWORD`);
    if (!url || !user || !pw) continue;
    out.set(key, {
      key,
      name: e(`WOO_${key}_NAME`) ?? key,
      platform: 'woo',
      url,
      woo: { user, appPassword: pw.replace(/\s+/g, '') },
      ga4Property: e(`WOO_${key}_GA4_PROPERTY`),
      metaAccount: e(`WOO_${key}_META_ACCOUNT`),
      grossMarginPct: num(`WOO_${key}_GROSS_MARGIN_PCT`),
    });
  }

  // Dogshowpro-legacy
  if (!out.has('dogshowpro') && e('DOGSHOWPRO_SUPABASE_URL') && e('DOGSHOWPRO_SUPABASE_SERVICE_ROLE_KEY')) {
    out.set('dogshowpro', {
      key: 'dogshowpro',
      name: 'Dogshowpro',
      platform: 'supabase',
      supabase: { url: e('DOGSHOWPRO_SUPABASE_URL')!, serviceRoleKey: e('DOGSHOWPRO_SUPABASE_SERVICE_ROLE_KEY')!, salesView: 'v_sales' },
      ga4Property: e('GA4_EXTRA_PROPERTIES')?.match(/dogshowpro=(\d+)/)?.[1],
    });
  }

  // Admin-gränssnittets register (data/store.enc) vinner över .env för samma nyckel.
  for (const s of storeSync().brands) {
    const b: Brand = {
      key: s.key,
      name: s.name || s.key,
      platform: s.platform,
      url: s.url?.replace(/\/$/, ''),
      ga4Property: s.ga4_property || undefined,
      gscSite: s.gsc_site || undefined,
      metaAccount: s.meta_account || undefined,
      metaPixel: s.meta_pixel || undefined,
      metaCatalog: s.meta_catalog || undefined,
      grossMarginPct: s.gross_margin_pct ?? undefined,
      targetMer: s.target_mer ?? undefined,
      stripeAccount: s.stripe_account || undefined,
      mollieProfile: s.mollie_profile || undefined,
      etsyShopId: s.etsy_shop_id || undefined,
      allowWrites: Boolean(s.allow_writes),
    };
    if (s.platform === 'woo' && s.url && s.woo_user && s.woo_app_password) b.woo = { user: s.woo_user, appPassword: s.woo_app_password.replace(/\s+/g, '') };
    if (s.platform === 'supabase' && s.supabase_url && s.supabase_service_role_key)
      b.supabase = { url: s.supabase_url, serviceRoleKey: s.supabase_service_role_key, salesView: s.sales_view || 'v_sales' };
    out.set(s.key, b);
  }

  cache = [...out.values()];
  return cache;
}

/** Anropas när registret ändrats via admin. */
export function invalidateBrands(): void {
  cache = null;
}
listeners.push(invalidateBrands);

export function getBrand(key: string): Brand {
  const b = brands().find((x) => x.key === key);
  if (!b) throw new Error(`Okänt varumärke "${key}". Tillgängliga: ${brands().map((x) => x.key).join(', ') || '(inga)'}`);
  return b;
}

/** Publik vy utan hemligheter – det Claude får se. */
export function brandCard(b: Brand) {
  return {
    key: b.key,
    name: b.name,
    platform: b.platform,
    url: b.url ?? null,
    woo_configured: Boolean(b.woo),
    supabase_configured: Boolean(b.supabase),
    sales_view: b.supabase?.salesView ?? null,
    ga4_property: b.ga4Property ?? null,
    gsc_site: b.gscSite ?? null,
    meta_account: b.metaAccount ?? null,
    meta_pixel: b.metaPixel ?? null,
    meta_catalog: b.metaCatalog ?? null,
    gross_margin_pct: b.grossMarginPct ?? null,
    target_mer: b.targetMer ?? null,
    stripe_account: b.stripeAccount ?? null,
    mollie_profile: b.mollieProfile ?? null,
    etsy_shop_id: b.etsyShopId ?? null,
    allow_writes: Boolean(b.allowWrites),
  };
}
