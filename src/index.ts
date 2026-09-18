import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { config } from './config.js';
import { OwnerOAuthProvider } from './auth/provider.js';
import { registerWooTools } from './woo/tools.js';
import { registerGa4Tools } from './ga4/tools.js';
import { registerDogshowproTools } from './dogshowpro/tools.js';
import { registerMerTools } from './mer.js';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'necom-data', version: '1.0.0' },
    {
      instructions:
        'NeCom butiksdata. Verktygen är läsande. Butiksnycklar: anropa woo_list_stores. Datum: YYYY-MM-DD eller relativt ("7d"). ' +
        'För MER: hämta annonskostnad från Meta Ads MCP och skicka in i mer_summary. Persondata returneras aldrig.',
    },
  );
  registerWooTools(server);
  registerGa4Tools(server);
  registerDogshowproTools(server);
  registerMerTools(server);
  return server;
}

async function main(): Promise<void> {
  const provider = new OwnerOAuthProvider();
  await provider.init();
  await provider.checkWritable();

  const app = express();
  app.set('trust proxy', 1); // bakom Caddy
  app.disable('x-powered-by');

  const issuer = new URL(config.publicUrl);
  const mcpUrl = new URL('/mcp', config.publicUrl);

  // OAuth: /authorize, /token, /register, /revoke + .well-known
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

  // Inloggningsformuläret (POST från /authorize-sidan)
  app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const { login_token, password } = req.body as { login_token?: string; password?: string };
    if (!login_token || typeof password !== 'string') return res.status(400).send('Ogiltig begäran');
    const out = await provider.completeLogin(login_token, password);
    if (out.redirect) return res.redirect(out.status, out.redirect);
    return res.status(out.status).type('html').send(out.html);
  });

  app.get('/', (_req, res) => res.type('text').send('NeCom Data MCP – endpoint: /mcp'));
  app.get('/health', (_req, res) => res.json({ ok: true, stores: config.stores.map((s) => s.key), ga4: Boolean(config.ga4Credentials), dogshowpro: Boolean(config.dogshowpro.serviceRoleKey) }));

  // MCP-endpoint, skyddad med bearer-token. Sessioner per Mcp-Session-Id.
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
    console.log(`necom-data-mcp lyssnar på ${host}:${config.port} – publik URL ${config.publicUrl}/mcp`);
    console.log(`Butiker: ${config.stores.map((s) => s.key).join(', ') || '(inga)'} | GA4: ${config.ga4Credentials ? 'ja' : 'nej'} | Dogshowpro: ${config.dogshowpro.serviceRoleKey ? 'ja' : 'nej'}`);
  });
}

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason instanceof Error ? reason.stack ?? reason.message : reason);
});

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
