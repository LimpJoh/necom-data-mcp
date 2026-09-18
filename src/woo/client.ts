/**
 * WooCommerce REST-klient med Application Password (Basic auth över HTTPS).
 * Använder både /wc/v3 (ordrar, produkter) och /wc-analytics (WooCommerce Analytics-rapporter).
 */
import type { WooStore } from '../config.js';

export interface WooOrder {
  id: number;
  status: string;
  currency: string;
  date_created: string;
  date_paid?: string | null;
  total: string;
  total_tax: string;
  shipping_total: string;
  discount_total: string;
  customer_id: number;
  billing?: { email?: string; country?: string; city?: string };
  line_items: { product_id: number; variation_id: number; name: string; quantity: number; total: string; sku?: string }[];
  coupon_lines: { code: string; discount: string }[];
  meta_data: { key: string; value: unknown }[];
  created_via?: string;
}

export class WooClient {
  constructor(private store: WooStore) {}

  private get authHeader(): string {
    return 'Basic ' + Buffer.from(`${this.store.user}:${this.store.appPassword}`).toString('base64');
  }

  async get<T>(namespace: 'wc/v3' | 'wc-analytics', endpoint: string, params: Record<string, string | number | undefined> = {}): Promise<{ data: T; totalPages: number; total: number }> {
    const url = new URL(`${this.store.url}/wp-json/${namespace}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      headers: { Authorization: this.authHeader, Accept: 'application/json', 'User-Agent': 'necom-data-mcp/1.0' },
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${this.store.name}: ${res.status} ${res.statusText} på ${namespace}/${endpoint} – ${body.slice(0, 300)}`);
    }
    return {
      data: (await res.json()) as T,
      totalPages: Number(res.headers.get('x-wp-totalpages') ?? '1'),
      total: Number(res.headers.get('x-wp-total') ?? '0'),
    };
  }

  /** Hämtar alla ordrar i ett datumintervall (skapade), paginerat. maxOrders skyddar mot jättebutiker. */
  async orders(since: string, until: string, statuses: string[], maxOrders = 2000): Promise<WooOrder[]> {
    const out: WooOrder[] = [];
    let page = 1;
    const perPage = 100;
    for (;;) {
      const { data, totalPages } = await this.get<WooOrder[]>('wc/v3', 'orders', {
        after: `${since}T00:00:00`,
        before: `${until}T23:59:59`,
        status: statuses.join(','),
        per_page: perPage,
        page,
        orderby: 'date',
        order: 'desc',
        _fields: 'id,status,currency,date_created,date_paid,total,total_tax,shipping_total,discount_total,customer_id,billing,line_items,coupon_lines,meta_data,created_via',
      });
      out.push(...data);
      if (page >= totalPages || out.length >= maxOrders || data.length < perPage) break;
      page += 1;
    }
    return out;
  }
}

/** Plockar WooCommerce Order Attribution (Woo ≥ 8.5) ur order-meta. */
export function attributionOf(order: WooOrder): { source_type: string; source: string; medium: string; campaign: string; device: string } {
  const m = (key: string): string => {
    const hit = order.meta_data?.find((x) => x.key === key);
    return hit && typeof hit.value === 'string' ? hit.value : '';
  };
  return {
    source_type: m('_wc_order_attribution_source_type') || 'unknown',
    source: m('_wc_order_attribution_utm_source') || m('_wc_order_attribution_referrer') || '(none)',
    medium: m('_wc_order_attribution_utm_medium') || '(none)',
    campaign: m('_wc_order_attribution_utm_campaign') || '(none)',
    device: m('_wc_order_attribution_device_type') || '',
  };
}
