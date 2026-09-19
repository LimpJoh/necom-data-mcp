import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config } from './config.js';
import { brands } from './brands.js';
import { OwnerOAuthProvider } from './auth/provider.js';
import { registerWooTools } from './woo/tools.js';
import { registerWooProductTools } from './woo/products.js';
import { registerGa4Tools, ga4Configured } from './ga4/tools.js';
import { registerGscTools } from './gsc/tools.js';
import { registerDogshowproTools } from './dogshowpro/tools.js';
import { registerPaymentTools } from './payments/tools.js';
import { registerSalesTools } from './sales/tools.js';
import { registerMerTools } from './mer.js';
import { registerOpsTools } from './ops/tools.js';
import { adminRouter } from './admin/router.js';
import { loadStore } from './store.js';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'necom-data', version: '1.3.0' },
    {
      instructions:
        'NeCom butiksdata och ops. Börja med brand_list (varumärken, Meta-ID:n, marginal). sales_summary/mer_summary fungerar för alla varumärken; woo_* för WooCommerce-detaljer, supabase_sales_breakdown för egna plattformar, ga4_*, gsc_*, stripe_*/mollie_* för respektive källa. ' +
        'Datum: YYYY-MM-DD eller relativt ("7d"). För MER: hämta annonskostnad från Meta Ads MCP och skicka in i mer_summary. Persondata returneras aldrig. ' +
        'ops_*-verktyg (om aktiva) ändrar infrastruktur: skrivande anrop kräver confirm=true – be alltid Linus om ja och beskriv exakt vad som händer.',
    },
  );
  registerSalesTools(server);
  registerWooTools(server);
  registerWooProductTools(server);
  registerGa4Tools(server);
  registerGscTools(server);
  registerDogshowproTools(server);
  registerPaymentTools(server);
  registerMerTools(server);
  registerOpsTools(server);
  return server;
}

async function main(): Promise<void> {
  await loadStore();
  const provider = new OwnerOAuthProvider();
  await provider.init();
  await provider.checkWritable();

  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const issuer = new URL(config.publicUrl);
  const mcpUrl = new URL('/mcp', config.publicUrl);

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      baseUrl: issuer,
      resourceServerUrl: mcpUrl,
      resourceName: 'NeCom Data MCP',
      scopesSupported: ['read'],
      clientRegistrationOptions: { clientSecretExpirySeconds: undefined },
    }),
  );

  app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const { login_token, password } = req.body as { login_token?: string; password?: string };
    if (!login_token || typeof password !== 'string') return res.status(400).send('Ogiltig begäran');
    const out = await provider.completeLogin(login_token, password);
    if (out.redirect) return res.redirect(out.status, out.redirect);
    return res.status(out.status).type('html').send(out.html);
  });

  app.use('/admin', adminRouter());
  app.get('/', (_req, res) => res.redirect('/admin'));
  app.get('/health', (_req, res) =>
    res.json({
      ok: true,
      version: '1.3.0',
      brands: brands().map((b) => ({ key: b.key, platform: b.platform, sales: Boolean(b.woo || b.supabase), ga4: Boolean(b.ga4Property), gsc: Boolean(b.gscSite), meta: Boolean(b.metaAccount) })),
      ga4: ga4Configured(),
      stripe: Boolean(config.stripeSecretKey),
      mollie: Boolean(config.mollieAccessToken),
      ops: config.ops.enabled,
    }),
  );

  const transports = new Map<string, StreamableHTTPServerTransport>();
  const auth = requireBearerAuth({ verifier: provider, requiredScopes: ['read'], resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource/mcp` });

  app.all('/mcp', auth, express.json({ limit: '2mb' }), async (req, res) => {
    const sessionId = req.header('mcp-session-id');
    let transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      if (req.method !== 'POST' || sessionId) {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Ogiltig eller saknad session. Skicka initialize först.' }, id: null });
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport!);
        },
        onsessionclosed: (id) => {
          transports.delete(id);
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };
      await buildServer().connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  });

  const host = process.env.HOST ?? '127.0.0.1';
  app.listen(config.port, host, () => {
    console.log(`necom-data-mcp 1.3.0 lyssnar på ${host}:${config.port} – publik URL ${config.publicUrl}/mcp`);
    console.log(`Varumärken: ${brands().map((b) => `${b.key}(${b.platform})`).join(', ') || '(inga)'} | GA4/GSC: ${config.ga4Credentials ? 'ja' : 'nej'} | Stripe: ${config.stripeSecretKey ? 'ja' : 'nej'} | Mollie: ${config.mollieAccessToken ? 'ja' : 'nej'} | Ops: ${config.ops.enabled ? 'PÅ' : 'av'}`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
