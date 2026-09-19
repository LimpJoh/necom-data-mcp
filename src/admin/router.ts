/**
 * Admin-gränssnitt på /admin: inloggning (MCP_LOGIN_PASSWORD), varumärkesregister, inställningar, hälsotavla.
 * Server-renderad HTML, inga externa beroenden. CSRF-token per session, httpOnly-cookie, lösenordsspärr.
 */
import express, { type Request, type Response, type NextFunction, type Router } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { config } from '../config.js';
import { brands, brandCard } from '../brands.js';
import { loadStore, upsertBrand, deleteBrand, updateSettings, storeSync, type StoredBrand } from '../store.js';
import { checkAll, checkBrand, serviceAccountEmail } from './health.js';

interface Session {
  csrf: string;
  expiresAt: number;
}
const sessions = new Map<string, Session>();
let failed = { count: 0, until: 0 };
const now = () => Math.floor(Date.now() / 1000);

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function cookie(req: Request): string | undefined {
  const m = /(?:^|;\s*)necom_admin=([a-f0-9]+)/.exec(req.headers.cookie ?? '');
  return m?.[1];
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const id = cookie(req);
  const s = id ? sessions.get(id) : undefined;
  if (!s || s.expiresAt < now()) {
    res.redirect('/admin/login');
    return;
  }
  s.expiresAt = now() + 3600 * 8;
  (req as unknown as { session: Session }).session = s;
  next();
}

function csrfOk(req: Request): boolean {
  const s = (req as Request & { session?: Session }).session;
  const t = (req.body as Record<string, string>)?._csrf;
  return Boolean(s && t && t.length === s.csrf.length && timingSafeEqual(Buffer.from(t), Buffer.from(s.csrf)));
}

const CSS = `
:root{--bg:#0b1220;--card:#131c2e;--line:#243247;--tx:#e6edf7;--mut:#8ea0b8;--ok:#22c55e;--warn:#f59e0b;--err:#ef4444;--off:#64748b;--acc:#38bdf8}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--tx)}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
header{display:flex;gap:1.5rem;align-items:center;padding:.9rem 1.5rem;border-bottom:1px solid var(--line);background:#0e1628}
header b{font-size:1.05rem}header nav a{margin-right:1rem;color:var(--mut)}header nav a.on{color:var(--tx)}
main{max-width:1100px;margin:0 auto;padding:1.5rem}
h1{font-size:1.4rem;margin:.2rem 0 1rem}h2{font-size:1.05rem;margin:1.4rem 0 .6rem;color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.25rem;margin-bottom:1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:1rem}
.row{display:flex;justify-content:space-between;align-items:center;gap:1rem}
.dot{display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.5rem;vertical-align:middle}
.ok{background:var(--ok)}.warn{background:var(--warn)}.err{background:var(--err)}.error{background:var(--err)}.off{background:var(--off)}
.chk{padding:.45rem 0;border-top:1px solid var(--line);font-size:.92rem}.chk:first-child{border-top:0}
.chk small{display:block;color:var(--mut);margin-left:1.2rem}.chk .fix{color:var(--warn)}
.score{font-size:1.6rem;font-weight:700}
label{display:block;font-size:.82rem;color:var(--mut);margin:.7rem 0 .25rem}
input,select,textarea{width:100%;padding:.55rem .7rem;border-radius:8px;border:1px solid var(--line);background:#0b1220;color:var(--tx);font-size:.95rem}
textarea{min-height:120px;font-family:ui-monospace,monospace;font-size:.85rem}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 1rem}@media(max-width:700px){.two{grid-template-columns:1fr}}
button,.btn{display:inline-block;margin-top:1rem;padding:.6rem 1rem;border:0;border-radius:8px;background:var(--acc);color:#04111f;font-weight:600;cursor:pointer;font-size:.95rem}
.btn.sec{background:#243247;color:var(--tx)}.btn.danger{background:#7f1d1d;color:#fff}
.flash{padding:.7rem 1rem;border-radius:8px;margin-bottom:1rem;background:#0f2a1a;border:1px solid #14532d}.flash.err{background:#2a0f0f;border-color:#7f1d1d}
table{width:100%;border-collapse:collapse;font-size:.9rem}td,th{padding:.5rem .4rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
code{background:#0b1220;padding:.1rem .35rem;border-radius:4px;font-size:.85em}
.muted{color:var(--mut)}.small{font-size:.85rem}
`;

function page(title: string, body: string, active = '', flash?: { ok?: string; err?: string }): string {
  const nav = [
    ['/admin', 'Översikt'],
    ['/admin/brands', 'Varumärken'],
    ['/admin/settings', 'Inställningar'],
    ['/admin/connect', 'Koppla Claude'],
  ]
    .map(([h, t]) => `<a href="${h}" class="${active === h ? 'on' : ''}">${t}</a>`)
    .join('');
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · NeCom Data</title><style>${CSS}</style></head>
<body><header><b>NeCom Data</b><nav>${nav}</nav><span style="margin-left:auto"><a href="/admin/logout" class="muted">Logga ut</a></span></header>
<main>${flash?.ok ? `<div class="flash">${esc(flash.ok)}</div>` : ''}${flash?.err ? `<div class="flash err">${esc(flash.err)}</div>` : ''}${body}</main></body></html>`;
}

function statusClass(s: string): string {
  return s === 'error' ? 'err' : s;
}

function brandForm(b: Partial<StoredBrand>, csrf: string, isNew: boolean): string {
  const v = (k: keyof StoredBrand) => esc((b as Record<string, unknown>)[k] ?? '');
  const sel = (val: string) => (b.platform === val ? 'selected' : '');
  return `<form method="post" action="/admin/brands/save"><input type="hidden" name="_csrf" value="${csrf}">
<div class="card"><h2>Identitet</h2><div class="two">
<div><label>Nyckel (gemener, a–z0–9, ändras inte)</label><input name="key" value="${v('key')}" ${isNew ? '' : 'readonly'} required pattern="[a-z0-9_-]+" placeholder="presentfabriken"></div>
<div><label>Namn</label><input name="name" value="${v('name')}" required placeholder="Presentfabriken"></div>
<div><label>Plattform</label><select name="platform"><option value="woo" ${sel('woo')}>WooCommerce</option><option value="supabase" ${sel('supabase')}>Egen (Next.js + Supabase v_sales)</option><option value="none" ${sel('none')}>Ingen försäljningskälla än</option></select></div>
<div><label>Butikens URL</label><input name="url" value="${v('url')}" placeholder="https://presentfabriken.com"></div></div></div>

<div class="card"><h2>WooCommerce</h2><div class="two">
<div><label>WP-användarnamn (roll Butiksansvarig)</label><input name="woo_user" value="${v('woo_user')}" autocomplete="off"></div>
<div><label>Applikationslösenord ${b.woo_app_password ? '<span class="muted">(sparat – lämna tomt för att behålla)</span>' : ''}</label><input name="woo_app_password" type="password" autocomplete="new-password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"></div></div>
<p class="small muted">WP-admin → Användare → Profil → Applikationslösenord → "necom-data-mcp". Order Attribution ska vara på.</p></div>

<div class="card"><h2>Egen plattform (Supabase)</h2><div class="two">
<div><label>Supabase URL</label><input name="supabase_url" value="${v('supabase_url')}" placeholder="https://xxxx.supabase.co"></div>
<div><label>service_role-nyckel ${b.supabase_service_role_key ? '<span class="muted">(sparad – lämna tomt för att behålla)</span>' : ''}</label><input name="supabase_service_role_key" type="password" autocomplete="new-password"></div>
<div><label>Försäljningsvy</label><input name="sales_view" value="${v('sales_view') || 'v_sales'}"></div></div>
<p class="small muted">Vyn skapas med <code>sql/v_sales.sql</code> anpassad till projektets tabeller.</p></div>

<div class="card"><h2>Google</h2><div class="two">
<div><label>GA4 property-ID (siffror)</label><input name="ga4_property" value="${v('ga4_property')}" placeholder="123456789"></div>
<div><label>Search Console-sajt</label><input name="gsc_site" value="${v('gsc_site')}" placeholder="sc-domain:presentfabriken.com"></div></div>
<p class="small muted">Servicekontot ${esc(serviceAccountEmail() ?? '(ladda upp JSON under Inställningar)')} ska vara Läsare på GA4-propertyn och användare i Search Console.</p></div>

<div class="card"><h2>Meta</h2><div class="two">
<div><label>Annonskonto-ID</label><input name="meta_account" value="${v('meta_account')}"></div>
<div><label>Pixel/dataset-ID</label><input name="meta_pixel" value="${v('meta_pixel')}"></div>
<div><label>Katalog-ID</label><input name="meta_catalog" value="${v('meta_catalog')}"></div></div></div>

<div class="card"><h2>Ekonomi och mål</h2><div class="two">
<div><label>Bruttomarginal %</label><input name="gross_margin_pct" type="number" step="0.1" min="0" max="100" value="${v('gross_margin_pct')}"></div>
<div><label>Mål-MER</label><input name="target_mer" type="number" step="0.1" min="0" value="${v('target_mer')}" placeholder="3"></div>
<div><label>Stripe Connect-konto (valfritt)</label><input name="stripe_account" value="${v('stripe_account')}" placeholder="acct_…"></div>
<div><label>Mollie-profil (valfritt)</label><input name="mollie_profile" value="${v('mollie_profile')}" placeholder="pfl_…"></div>
<div><label>Etsy shop-ID (valfritt)</label><input name="etsy_shop_id" value="${v('etsy_shop_id')}"></div></div>
<label><input type="checkbox" name="allow_writes" value="1" ${b.allow_writes ? 'checked' : ''} style="width:auto;margin-right:.5rem">Tillåt produktändringar via Claude (woo_products_update – varje ändring kräver ditt ja i chatten och loggas)</label>
<label>Anteckningar</label><textarea name="notes">${v('notes')}</textarea>
<button type="submit">Spara</button> <a class="btn sec" href="/admin/brands">Avbryt</a></div></form>`;
}

export function adminRouter(): Router {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false, limit: '1mb' }));

  r.get('/login', (_req, res) => {
    res.type('html').send(`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Logga in · NeCom Data</title><style>${CSS}main{max-width:380px;margin-top:10vh}</style></head><body><main><div class="card"><h1>NeCom Data – admin</h1><form method="post" action="/admin/login"><label>Lösenord</label><input type="password" name="password" autofocus required><button type="submit">Logga in</button></form></div></main></body></html>`);
  });

  r.post('/login', (req, res) => {
    const { password } = req.body as { password?: string };
    if (failed.until > now()) {
      res.status(429).type('text').send('För många försök. Vänta en minut.');
      return;
    }
    const ok = typeof password === 'string' && password.length === config.loginPassword.length && timingSafeEqual(Buffer.from(password), Buffer.from(config.loginPassword));
    if (!ok) {
      failed.count += 1;
      if (failed.count >= 5) failed = { count: 0, until: now() + 60 };
      res.redirect('/admin/login');
      return;
    }
    failed = { count: 0, until: 0 };
    const id = randomBytes(24).toString('hex');
    sessions.set(id, { csrf: randomBytes(16).toString('hex'), expiresAt: now() + 3600 * 8 });
    const secure = config.publicUrl.startsWith('https');
    res.setHeader('Set-Cookie', `necom_admin=${id}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=28800${secure ? '; Secure' : ''}`);
    res.redirect('/admin');
  });

  r.get('/logout', (req, res) => {
    const id = cookie(req);
    if (id) sessions.delete(id);
    res.setHeader('Set-Cookie', 'necom_admin=; Path=/admin; Max-Age=0');
    res.redirect('/admin/login');
  });

  r.use(requireAuth);

  // ---------- Översikt / hälsotavla ----------
  r.get('/', async (req, res) => {
    await loadStore();
    const h = await checkAll();
    const cards = h.brands
      .map(
        (b) => `<div class="card"><div class="row"><div><b>${esc(b.name)}</b> <span class="muted small">${esc(b.key)}</span></div><div class="score" style="color:${b.score >= 80 ? 'var(--ok)' : b.score >= 50 ? 'var(--warn)' : 'var(--err)'}">${b.score}</div></div>
${b.checks.map((c) => `<div class="chk"><span class="dot ${statusClass(c.status)}"></span><b>${esc(c.name)}</b> <span class="muted">${esc(c.detail)}</span>${c.fix ? `<small class="fix">→ ${esc(c.fix)}</small>` : ''}</div>`).join('')}
<a class="btn sec" href="/admin/brands/${esc(b.key)}">Redigera</a></div>`,
      )
      .join('');
    const g = h.global.map((c) => `<div class="chk"><span class="dot ${statusClass(c.status)}"></span><b>${esc(c.name)}</b> <span class="muted">${esc(c.detail)}</span>${c.fix ? `<small class="fix">→ ${esc(c.fix)}</small>` : ''}</div>`).join('');
    const warnings = h.brands.flatMap((b) => b.checks.filter((c) => c.status === 'error').map((c) => `${b.name}: ${c.name} – ${c.detail}`));
    res.type('html').send(
      page(
        'Översikt',
        `<h1>Översikt</h1>${warnings.length ? `<div class="flash err"><b>${warnings.length} fel som stoppar data:</b><br>${warnings.map(esc).join('<br>')}</div>` : '<div class="flash">Inga blockerande fel.</div>'}
<div class="card"><h2>Globalt</h2>${g}</div><h2>Varumärken</h2><div class="grid">${cards || '<p class="muted">Inga varumärken än. <a href="/admin/brands/new">Lägg till</a>.</p>'}</div>
<p class="small muted">Kontrollerna körs live vid varje sidladdning (Woo, GA4, Search Console, Supabase).</p>`,
        '/admin',
        req.query.ok ? { ok: String(req.query.ok) } : undefined,
      ),
    );
  });

  // ---------- Varumärken ----------
  r.get('/brands', async (req, res) => {
    await loadStore();
    const st = storeSync();
    const rows = brands()
      .map((b) => {
        const inStore = st.brands.some((x) => x.key === b.key);
        const c = brandCard(b);
        return `<tr><td><b>${esc(b.name)}</b><br><span class="muted small">${esc(b.key)} · ${esc(b.platform)}${inStore ? '' : ' · <i>från .env</i>'}</span></td>
<td class="small">${c.woo_configured || c.supabase_configured ? '✓ försäljning' : '– försäljning'}<br>${c.ga4_property ? '✓ GA4' : '– GA4'} · ${c.gsc_site ? '✓ GSC' : '– GSC'}<br>${c.meta_account ? '✓ Meta' : '– Meta'} · ${c.gross_margin_pct !== null ? `${c.gross_margin_pct} %` : '– marginal'}</td>
<td><a class="btn sec" href="/admin/brands/${esc(b.key)}">Redigera</a></td></tr>`;
      })
      .join('');
    res.type('html').send(
      page(
        'Varumärken',
        `<div class="row"><h1>Varumärken</h1><a class="btn" href="/admin/brands/new">+ Nytt varumärke</a></div><div class="card"><table><thead><tr><th>Varumärke</th><th>Källor</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="small muted">Varumärken från .env visas här och kan tas över genom att redigera och spara – då gäller det som sparats här.</p>`,
        '/admin/brands',
        req.query.ok ? { ok: String(req.query.ok) } : req.query.err ? { err: String(req.query.err) } : undefined,
      ),
    );
  });

  r.get('/brands/new', (req, res) => {
    const s = (req as unknown as { session: Session }).session;
    res.type('html').send(page('Nytt varumärke', `<h1>Nytt varumärke</h1>${brandForm({ platform: 'woo' }, s.csrf, true)}`, '/admin/brands'));
  });

  r.get('/brands/:key', async (req, res) => {
    await loadStore();
    const s = (req as unknown as { session: Session }).session;
    const key = String(req.params.key);
    const stored = storeSync().brands.find((x) => x.key === key);
    const env = brands().find((x) => x.key === key);
    if (!stored && !env) {
      res.redirect('/admin/brands?err=Okänt varumärke');
      return;
    }
    const b: Partial<StoredBrand> = stored ?? {
      key,
      name: env!.name,
      platform: env!.platform,
      url: env!.url,
      woo_user: env!.woo?.user,
      woo_app_password: env!.woo?.appPassword,
      supabase_url: env!.supabase?.url,
      supabase_service_role_key: env!.supabase?.serviceRoleKey,
      sales_view: env!.supabase?.salesView,
      ga4_property: env!.ga4Property,
      gsc_site: env!.gscSite,
      meta_account: env!.metaAccount,
      meta_pixel: env!.metaPixel,
      meta_catalog: env!.metaCatalog,
      gross_margin_pct: env!.grossMarginPct,
      target_mer: env!.targetMer,
      stripe_account: env!.stripeAccount,
      mollie_profile: env!.mollieProfile,
      etsy_shop_id: env!.etsyShopId,
    };
    let health = '';
    if (req.query.check && env) {
      const h = await checkBrand(env);
      health = `<div class="card"><h2>Kontroll</h2>${h.checks.map((c) => `<div class="chk"><span class="dot ${statusClass(c.status)}"></span><b>${esc(c.name)}</b> <span class="muted">${esc(c.detail)}</span>${c.fix ? `<small class="fix">→ ${esc(c.fix)}</small>` : ''}</div>`).join('')}</div>`;
    }
    res.type('html').send(
      page(
        b.name ?? key,
        `<div class="row"><h1>${esc(b.name ?? key)}</h1><div><a class="btn sec" href="/admin/brands/${esc(key)}?check=1">Testa kopplingar</a> <form method="post" action="/admin/brands/delete" style="display:inline" onsubmit="return confirm('Ta bort ${esc(key)} ur registret?')"><input type="hidden" name="_csrf" value="${s.csrf}"><input type="hidden" name="key" value="${esc(key)}"><button class="btn danger" type="submit">Ta bort</button></form></div></div>${health}${brandForm(b, s.csrf, false)}`,
        '/admin/brands',
        req.query.ok ? { ok: String(req.query.ok) } : undefined,
      ),
    );
  });

  r.post('/brands/save', async (req, res) => {
    if (!csrfOk(req)) {
      res.status(403).send('CSRF');
      return;
    }
    const f = req.body as Record<string, string>;
    const key = (f.key ?? '').trim().toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(key)) {
      res.redirect('/admin/brands?err=Ogiltig nyckel');
      return;
    }
    const num = (v: string) => (v === undefined || v === '' ? undefined : Number(v));
    const b: StoredBrand = {
      key,
      name: (f.name ?? key).trim(),
      platform: (['woo', 'supabase', 'none'].includes(f.platform) ? f.platform : 'none') as StoredBrand['platform'],
      url: f.url?.trim().replace(/\/$/, '') || undefined,
      woo_user: f.woo_user?.trim() || undefined,
      woo_app_password: f.woo_app_password?.trim() || undefined,
      supabase_url: f.supabase_url?.trim().replace(/\/$/, '') || undefined,
      supabase_service_role_key: f.supabase_service_role_key?.trim() || undefined,
      sales_view: f.sales_view?.trim() || 'v_sales',
      ga4_property: f.ga4_property?.trim() || undefined,
      gsc_site: f.gsc_site?.trim() || undefined,
      meta_account: f.meta_account?.trim() || undefined,
      meta_pixel: f.meta_pixel?.trim() || undefined,
      meta_catalog: f.meta_catalog?.trim() || undefined,
      gross_margin_pct: num(f.gross_margin_pct),
      target_mer: num(f.target_mer),
      stripe_account: f.stripe_account?.trim() || undefined,
      mollie_profile: f.mollie_profile?.trim() || undefined,
      etsy_shop_id: f.etsy_shop_id?.trim() || undefined,
      allow_writes: f.allow_writes === '1',
      notes: f.notes?.trim() || undefined,
    };
    // Om varumärket bara finns i .env och lösenordsfält lämnats tomma: ta med .env-värdena
    const env = brands().find((x) => x.key === key);
    if (env && !storeSync().brands.some((x) => x.key === key)) {
      b.woo_app_password ??= env.woo?.appPassword;
      b.supabase_service_role_key ??= env.supabase?.serviceRoleKey;
    }
    await upsertBrand(b);
    res.redirect(`/admin/brands/${key}?ok=Sparat&check=1`);
  });

  r.post('/brands/delete', async (req, res) => {
    if (!csrfOk(req)) {
      res.status(403).send('CSRF');
      return;
    }
    await deleteBrand(String((req.body as Record<string, string>).key));
    res.redirect('/admin/brands?ok=Borttaget ur registret (finns det i .env visas det fortfarande därifrån)');
  });

  // ---------- Inställningar ----------
  r.get('/settings', async (req, res) => {
    await loadStore();
    const s = (req as unknown as { session: Session }).session;
    const st = storeSync().settings;
    const has = (v: string) => (v ? '<span class="muted">(sparad – lämna tomt för att behålla)</span>' : '');
    res.type('html').send(
      page(
        'Inställningar',
        `<h1>Inställningar</h1>
<form method="post" action="/admin/settings/google" enctype="application/x-www-form-urlencoded"><input type="hidden" name="_csrf" value="${s.csrf}"><div class="card"><h2>Google (GA4 + Search Console)</h2>
<p class="small muted">Nuvarande servicekonto: <b>${esc(serviceAccountEmail() ?? 'inget')}</b>. Klistra in hela JSON-nyckeln från Google Cloud (IAM → Servicekonton → Nycklar). Aktivera <i>Google Analytics Data API</i> och <i>Search Console API</i> i projektet.</p>
<label>Servicekonto-JSON</label><textarea name="ga4_json" placeholder='{"type":"service_account", ...}'></textarea><button type="submit">Spara JSON</button></div></form>

<form method="post" action="/admin/settings/save"><input type="hidden" name="_csrf" value="${s.csrf}">
<div class="card"><h2>Betalleverantörer</h2><div class="two">
<div><label>Stripe restricted key ${has(config.stripeSecretKey)}</label><input name="stripe_secret_key" type="password" autocomplete="new-password" placeholder="rk_live_…"></div>
<div><label>Mollie organisationstoken ${has(config.mollieAccessToken)}</label><input name="mollie_access_token" type="password" autocomplete="new-password"></div></div></div>
<div class="card"><h2>Ops-lager (skrivande verktyg för nya projekt)</h2>
<label><input type="checkbox" name="ops_enabled" value="1" ${config.ops.enabled ? 'checked' : ''} style="width:auto;margin-right:.5rem">Aktivera ops_*-verktyg (kräver omstart av containern: <code>docker compose restart</code>)</label>
<div class="two">
<div><label>GitHub fine-grained token ${has(config.ops.githubToken)}</label><input name="ops_github_token" type="password" autocomplete="new-password"></div>
<div><label>GitHub-ägare</label><input name="ops_github_owner" value="${esc(config.ops.githubOwner)}" placeholder="LimpJoh"></div>
<div><label>Supabase access token ${has(config.ops.supabaseAccessToken)}</label><input name="ops_supabase_access_token" type="password" autocomplete="new-password"></div>
<div><label>Supabase org-ID</label><input name="ops_supabase_org_id" value="${esc(config.ops.supabaseOrgId)}"></div>
<div><label>Hostinger API-token ${has(config.ops.hostingerToken)}</label><input name="ops_hostinger_token" type="password" autocomplete="new-password"></div>
<div><label>VPS IP</label><input name="ops_vps_ip" value="${esc(config.ops.vpsIp)}" placeholder="76.13.11.64"></div>
<div><label>SSH-användare på VPS:en</label><input name="ops_ssh_user" value="${esc(config.ops.sshUser)}"></div></div>
<p class="small muted">SSH-nyckel: lägg den privata nyckeln som <code>${esc(config.ops.sshKeyFile)}</code> (ägare 10001, chmod 600).</p>
<button type="submit">Spara</button></div></form>
<p class="small muted">Senast ändrat: ${esc(st.updated_at ?? '–')}. Allt sparas krypterat i <code>data/store.enc</code>.</p>`,
        '/admin/settings',
        req.query.ok ? { ok: String(req.query.ok) } : req.query.err ? { err: String(req.query.err) } : undefined,
      ),
    );
  });

  r.post('/settings/save', async (req, res) => {
    if (!csrfOk(req)) {
      res.status(403).send('CSRF');
      return;
    }
    const f = req.body as Record<string, string>;
    await updateSettings({
      stripe_secret_key: f.stripe_secret_key?.trim(),
      mollie_access_token: f.mollie_access_token?.trim(),
      ops_enabled: f.ops_enabled === '1',
      ops_github_token: f.ops_github_token?.trim(),
      ops_github_owner: f.ops_github_owner?.trim(),
      ops_supabase_access_token: f.ops_supabase_access_token?.trim(),
      ops_supabase_org_id: f.ops_supabase_org_id?.trim(),
      ops_hostinger_token: f.ops_hostinger_token?.trim(),
      ops_vps_ip: f.ops_vps_ip?.trim(),
      ops_ssh_user: f.ops_ssh_user?.trim(),
    });
    res.redirect('/admin/settings?ok=Sparat');
  });

  r.post('/settings/google', async (req, res) => {
    if (!csrfOk(req)) {
      res.status(403).send('CSRF');
      return;
    }
    const raw = String((req.body as Record<string, string>).ga4_json ?? '').trim();
    try {
      const j = JSON.parse(raw) as { type?: string; client_email?: string; private_key?: string };
      if (j.type !== 'service_account' || !j.client_email || !j.private_key) throw new Error('Inte en servicekonto-nyckel');
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.writeFile(config.ga4Credentials, raw, { mode: 0o600 });
      const { listeners } = await import('../store.js');
      for (const l of listeners) l();
      res.redirect(`/admin/settings?ok=Servicekonto sparat: ${encodeURIComponent(j.client_email)}`);
    } catch (e) {
      res.redirect(`/admin/settings?err=${encodeURIComponent((e as Error).message)}`);
    }
  });

  // ---------- Koppla Claude ----------
  r.get('/connect', (_req, res) => {
    res.type('html').send(
      page(
        'Koppla Claude',
        `<h1>Koppla Claude</h1><div class="card"><ol class="small" style="line-height:1.8">
<li>claude.ai → Inställningar → Connectors → <b>Lägg till anpassad connector</b>.</li>
<li>Namn <code>NeCom Data</code>, URL <code>${esc(config.publicUrl)}/mcp</code>, OAuth-fälten tomma.</li>
<li>Klicka Anslut och ange samma lösenord som här.</li>
<li>Slå på connectorn i varje projekt/chatt som ska använda den. Testa med "brand_list".</li></ol>
<p class="muted small">Tvinga ny inloggning för alla: stoppa containern, radera <code>data/oauth-state.json</code>, starta.</p></div>`,
        '/admin/connect',
      ),
    );
  });

  return r;
}
