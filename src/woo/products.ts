/**
 * Produktverktyg för WooCommerce: revision (hitta fel som blockerar Meta-katalogen) och rättning.
 * Skrivning kräver att varumärket har "allow_writes" i admin OCH confirm=true per anrop. Allt loggas.
 */
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { getBrand, type Brand } from '../brands.js';
import { WooClient } from './client.js';
import { textResult, errorResult } from '../util.js';

interface WooProduct {
  id: number;
  name: string;
  sku: string;
  type: string;
  status: string;
  catalog_visibility: string;
  regular_price: string;
  sale_price: string;
  price: string;
  stock_status: string;
  stock_quantity: number | null;
  manage_stock: boolean;
  global_unique_id?: string;
  description: string;
  short_description: string;
  images: { id: number; src: string }[];
  categories: { id: number; name: string }[];
  parent_id: number;
  permalink: string;
  date_modified: string;
  meta_data: { key: string; value: unknown }[];
}

type Issue = 'missing_price' | 'out_of_stock_visible' | 'missing_gtin' | 'invalid_gtin' | 'html_in_description' | 'missing_image' | 'missing_category' | 'missing_sku' | 'draft_visible';

function clientFor(b: Brand): WooClient {
  if (!b.woo || !b.url) throw new Error(`"${b.key}" har ingen WooCommerce-koppling.`);
  return new WooClient({ key: b.key, name: b.name, url: b.url, user: b.woo.user, appPassword: b.woo.appPassword });
}

function gtinValid(g: string | undefined): boolean {
  if (!g) return false;
  const d = g.replace(/\s|-/g, '');
  if (!/^\d{8}$|^\d{12,14}$/.test(d)) return false;
  // GS1 kontrollsiffra
  const digits = d.split('').map(Number);
  const check = digits.pop()!;
  let sum = 0;
  digits.reverse().forEach((n, i) => (sum += n * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10 === check;
}

const DISALLOWED_HTML = /<(script|style|iframe|table|div|span|img|form|input|button|video|audio)\b|style=|class=|on\w+=/i;

function findIssues(p: WooProduct, checks: Set<Issue>): Issue[] {
  const out: Issue[] = [];
  const visible = p.status === 'publish' && p.catalog_visibility !== 'hidden';
  if (checks.has('missing_price') && p.type !== 'variable' && (!p.regular_price || Number(p.regular_price) <= 0)) out.push('missing_price');
  if (checks.has('out_of_stock_visible') && visible && p.stock_status === 'outofstock') out.push('out_of_stock_visible');
  if (checks.has('missing_gtin') && !p.global_unique_id) out.push('missing_gtin');
  if (checks.has('invalid_gtin') && p.global_unique_id && !gtinValid(p.global_unique_id)) out.push('invalid_gtin');
  if (checks.has('html_in_description') && DISALLOWED_HTML.test(p.description ?? '')) out.push('html_in_description');
  if (checks.has('missing_image') && (!p.images || p.images.length === 0)) out.push('missing_image');
  if (checks.has('missing_category') && (!p.categories || p.categories.length === 0 || p.categories.every((c) => c.name.toLowerCase() === 'uncategorized' || c.name.toLowerCase() === 'okategoriserad'))) out.push('missing_category');
  if (checks.has('missing_sku') && !p.sku) out.push('missing_sku');
  if (checks.has('draft_visible') && p.status !== 'publish' && p.catalog_visibility === 'visible') out.push('draft_visible');
  return out;
}

async function audit(brand: string, action: string, detail: unknown): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), brand, action, detail }) + '\n';
  await fs.appendFile(`${config.dataDir}woo-writes.log`, line).catch(() => undefined);
}

export function registerWooProductTools(server: McpServer): void {
  server.registerTool(
    'woo_products_audit',
    {
      title: 'Produktrevision (fel som stoppar Meta-katalogen)',
      description:
        'Går igenom butikens produkter (och varianter) och listar fel: pris saknas, slut i lager men synlig, GTIN saknas/ogiltig (GS1-kontroll), otillåten HTML i beskrivning, bild saknas, kategori saknas, SKU saknas. Matchar det Meta rapporterar i ads_catalog_get_diagnostics. Returnerar id, SKU, namn, permalink och fel per produkt.',
      inputSchema: {
        brand: z.string(),
        checks: z.array(z.enum(['missing_price', 'out_of_stock_visible', 'missing_gtin', 'invalid_gtin', 'html_in_description', 'missing_image', 'missing_category', 'missing_sku', 'draft_visible'])).optional().describe('Default: alla.'),
        include_variations: z.boolean().optional().describe('Kontrollera även varianter (default true).'),
        skus: z.array(z.string()).optional().describe('Begränsa till dessa SKU:er (t.ex. från Metas diagnostik).'),
        limit: z.number().int().min(1).max(3000).optional().describe('Max produkter att läsa. Default 1500.'),
      },
    },
    async ({ brand, checks, include_variations, skus, limit }) => {
      try {
        const b = getBrand(brand);
        const c = clientFor(b);
        const set = new Set<Issue>(checks ?? ['missing_price', 'out_of_stock_visible', 'missing_gtin', 'invalid_gtin', 'html_in_description', 'missing_image', 'missing_category', 'missing_sku', 'draft_visible']);
        const fields = 'id,name,sku,type,status,catalog_visibility,regular_price,sale_price,price,stock_status,stock_quantity,manage_stock,global_unique_id,description,images,categories,parent_id,permalink,date_modified';
        const products: WooProduct[] = [];
        if (skus?.length) {
          for (const sku of skus) {
            const { data } = await c.get<WooProduct[]>('wc/v3', 'products', { sku, _fields: fields, status: 'any' });
            products.push(...data);
            const { data: v } = await c.get<WooProduct[]>('wc/v3', 'products/variations', { sku }).catch(() => ({ data: [] as WooProduct[] }));
            products.push(...v);
          }
        } else {
          for (let page = 1; products.length < (limit ?? 1500); page++) {
            const { data, totalPages } = await c.get<WooProduct[]>('wc/v3', 'products', { per_page: 100, page, status: 'any', _fields: fields });
            products.push(...data);
            if (page >= totalPages || data.length < 100) break;
          }
          if (include_variations !== false) {
            const parents = products.filter((p) => p.type === 'variable');
            for (const parent of parents) {
              for (let page = 1; ; page++) {
                const { data, totalPages } = await c.get<WooProduct[]>('wc/v3', `products/${parent.id}/variations`, { per_page: 100, page, _fields: fields });
                products.push(...data.map((v) => ({ ...v, name: v.name || `${parent.name} (variant ${v.id})`, type: 'variation', parent_id: parent.id, categories: parent.categories, status: v.status ?? parent.status, catalog_visibility: parent.catalog_visibility })));
                if (page >= totalPages || data.length < 100) break;
              }
            }
          }
        }
        const rows = products
          .map((p) => ({ id: p.id, parent_id: p.parent_id || null, type: p.type, sku: p.sku || null, name: p.name, status: p.status, stock_status: p.stock_status, regular_price: p.regular_price || null, gtin: p.global_unique_id || null, permalink: p.permalink, issues: findIssues(p, set) }))
          .filter((r) => r.issues.length > 0);
        const counts: Record<string, number> = {};
        for (const r of rows) for (const i of r.issues) counts[i] = (counts[i] ?? 0) + 1;
        return textResult({ brand: b.key, scanned: products.length, with_issues: rows.length, counts, products: rows.slice(0, 500), truncated: rows.length > 500 });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'woo_product_get',
    {
      title: 'Hämta en produkt',
      description: 'Full produktinfo (inkl. beskrivning, pris, lager, GTIN, bilder, kategorier, meta) via id eller SKU.',
      inputSchema: { brand: z.string(), id: z.number().int().optional(), sku: z.string().optional() },
    },
    async ({ brand, id, sku }) => {
      try {
        const b = getBrand(brand);
        const c = clientFor(b);
        let p: WooProduct | undefined;
        if (id) p = (await c.get<WooProduct>('wc/v3', `products/${id}`)).data;
        else if (sku) p = (await c.get<WooProduct[]>('wc/v3', 'products', { sku, status: 'any' })).data[0];
        if (!p) throw new Error('Produkten hittades inte.');
        const { meta_data, ...rest } = p;
        return textResult({ ...rest, meta_keys: meta_data?.map((m) => m.key) });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'woo_products_update',
    {
      title: 'Uppdatera produkter (batch, kräver confirm)',
      description:
        'Rättar produkter i WooCommerce: pris, lagerstatus, GTIN (global_unique_id), beskrivning, kategori-synlighet, status. Kräver att varumärket har skrivning tillåten i admin och confirm=true. Max 100 per anrop. Alla ändringar loggas. Använd woo_products_audit först och visa Linus exakt vad som ändras.',
      inputSchema: {
        brand: z.string(),
        updates: z
          .array(
            z.object({
              id: z.number().int(),
              parent_id: z.number().int().optional().describe('Sätt för varianter.'),
              regular_price: z.string().optional(),
              sale_price: z.string().optional(),
              stock_status: z.enum(['instock', 'outofstock', 'onbackorder']).optional(),
              stock_quantity: z.number().int().optional(),
              manage_stock: z.boolean().optional(),
              global_unique_id: z.string().optional().describe('GTIN/EAN. Tom sträng tar bort.'),
              description: z.string().optional(),
              short_description: z.string().optional(),
              catalog_visibility: z.enum(['visible', 'catalog', 'search', 'hidden']).optional(),
              status: z.enum(['publish', 'draft', 'private']).optional(),
            }),
          )
          .min(1)
          .max(100),
        confirm: z.boolean().optional(),
      },
    },
    async ({ brand, updates, confirm }) => {
      try {
        const b = getBrand(brand);
        if (!b.allowWrites) throw new Error(`Skrivning är inte tillåten för "${b.key}". Slå på "Tillåt produktändringar" under Varumärken → Redigera i admin.`);
        if (!confirm) throw new Error('Skrivande åtgärd kräver confirm=true. Visa Linus listan över ändringar och be om ja först.');
        const c = clientFor(b);
        const results: { id: number; ok: boolean; error?: string }[] = [];
        const simple = updates.filter((u) => !u.parent_id);
        const variations = updates.filter((u) => u.parent_id);
        if (simple.length) {
          const res = await c.post<{ update: { id: number; error?: { message: string } }[] }>('wc/v3', 'products/batch', { update: simple.map(({ parent_id: _p, ...u }) => u) });
          for (const r of res.update ?? []) results.push({ id: r.id, ok: !r.error, error: r.error?.message });
        }
        for (const v of variations) {
          const { parent_id, ...fields } = v;
          try {
            await c.put(`wc/v3`, `products/${parent_id}/variations/${v.id}`, fields);
            results.push({ id: v.id, ok: true });
          } catch (e) {
            results.push({ id: v.id, ok: false, error: (e as Error).message.slice(0, 200) });
          }
        }
        await audit(b.key, 'products_update', { updates, results });
        return textResult({ brand: b.key, updated: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok), results });
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
