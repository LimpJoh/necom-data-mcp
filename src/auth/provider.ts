/**
 * Minimal OAuth 2.1-provider för en enda ägare (Linus).
 *
 * - Dynamisk klientregistrering (claude.ai registrerar sig själv).
 * - /authorize visar en lösenordssida. Rätt lösenord => auktoriseringskod (PKCE-bunden).
 * - Access tokens (kort livslängd) + refresh tokens (roterande).
 * - Allt persisteras i en JSON-fil så att PM2-omstarter inte bryter kopplingen.
 *
 * Ingen användardata lagras – bara klienter, koder och tokens.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { config } from '../config.js';

interface PendingCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number; // unix sekunder
  resource?: string;
}

interface State {
  clients: Record<string, OAuthClientInformationFull>;
  codes: Record<string, PendingCode>;
  accessTokens: Record<string, TokenRecord>; // nyckel = sha256(token)
  refreshTokens: Record<string, TokenRecord>;
}

const SCOPES = ['read'];

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class OwnerOAuthProvider implements OAuthServerProvider {
  private state: State = { clients: {}, codes: {}, accessTokens: {}, refreshTokens: {} };
  private loaded = false;
  private saving: Promise<void> = Promise.resolve();
  /** Kortlivade inloggningsförsök: loginToken -> params */
  private loginSessions = new Map<string, { client: OAuthClientInformationFull; params: AuthorizationParams; expiresAt: number }>();
  private failedLogins: { count: number; until: number } = { count: 0, until: 0 };

  async init(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(config.stateFile, 'utf8');
      this.state = { ...this.state, ...JSON.parse(raw) };
    } catch {
      /* första start */
    }
    this.loaded = true;
    this.gc();
  }

  private persist(): void {
    this.saving = this.saving
      .then(async () => {
        await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
        const tmp = `${config.stateFile}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
        await fs.rename(tmp, config.stateFile);
      })
      .catch((err: unknown) => {
        // Får aldrig krascha processen – då tappas klienter/tokens i minnet och inloggningen bryts.
        console.error(`[oauth] kunde inte spara ${config.stateFile}: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  /** Kontrollerar vid start att state-filen går att skriva, så felet syns i loggen direkt. */
  async checkWritable(): Promise<boolean> {
    try {
      await fs.mkdir(path.dirname(config.stateFile), { recursive: true });
      await fs.access(path.dirname(config.stateFile), fs.constants.W_OK);
      return true;
    } catch {
      console.error(`[oauth] VARNING: ${path.dirname(config.stateFile)} är inte skrivbar – OAuth-klienter och tokens överlever inte en omstart. Kör: chown -R 10001:10001 <data-mappen>`);
      return false;
    }
  }

  private gc(): void {
    const t = now();
    for (const [k, v] of Object.entries(this.state.codes)) if (v.expiresAt < t) delete this.state.codes[k];
    for (const [k, v] of Object.entries(this.state.accessTokens)) if (v.expiresAt < t) delete this.state.accessTokens[k];
    for (const [k, v] of Object.entries(this.state.refreshTokens)) if (v.expiresAt < t) delete this.state.refreshTokens[k];
    for (const [k, v] of this.loginSessions) if (v.expiresAt < t) this.loginSessions.delete(k);
  }

  // ---------- Klienter ----------
  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.state.clients[clientId],
      registerClient: (client) => {
        const full: OAuthClientInformationFull = {
          ...client,
          client_id: randomBytes(16).toString('hex'),
          client_id_issued_at: now(),
        };
        this.state.clients[full.client_id] = full;
        this.persist();
        return full;
      },
    };
  }

  // ---------- Authorize ----------
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.gc();
    const loginToken = randomBytes(24).toString('hex');
    this.loginSessions.set(loginToken, { client, params, expiresAt: now() + 600 });
    res.status(200).type('html').send(loginPage(loginToken, client.client_name ?? 'Claude', null));
  }

  /** Anropas från POST /login. Returnerar redirect-URL eller HTML för nytt försök. */
  async completeLogin(loginToken: string, password: string): Promise<{ redirect?: string; html?: string; status: number }> {
    this.gc();
    const session = this.loginSessions.get(loginToken);
    if (!session) return { status: 400, html: errorPage('Inloggningen har gått ut. Starta om kopplingen från Claude.') };

    if (this.failedLogins.until > now()) {
      return { status: 429, html: loginPage(loginToken, session.client.client_name ?? 'Claude', 'För många försök. Vänta en minut.') };
    }
    if (!safeEqual(password, config.loginPassword)) {
      this.failedLogins.count += 1;
      if (this.failedLogins.count >= 5) this.failedLogins = { count: 0, until: now() + 60 };
      return { status: 401, html: loginPage(loginToken, session.client.client_name ?? 'Claude', 'Fel lösenord.') };
    }
    this.failedLogins = { count: 0, until: 0 };
    this.loginSessions.delete(loginToken);

    const code = randomBytes(32).toString('hex');
    this.state.codes[sha(code)] = {
      clientId: session.client.client_id,
      codeChallenge: session.params.codeChallenge,
      redirectUri: session.params.redirectUri,
      scopes: session.params.scopes?.length ? session.params.scopes : SCOPES,
      resource: session.params.resource?.toString(),
      expiresAt: now() + 300,
    };
    this.persist();

    const url = new URL(session.params.redirectUri);
    url.searchParams.set('code', code);
    if (session.params.state) url.searchParams.set('state', session.params.state);
    return { status: 302, redirect: url.toString() };
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const rec = this.state.codes[sha(authorizationCode)];
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < now()) throw new InvalidGrantError('Ogiltig eller utgången kod');
    return rec.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = sha(authorizationCode);
    const rec = this.state.codes[key];
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < now()) throw new InvalidGrantError('Ogiltig eller utgången kod');
    if (redirectUri && redirectUri !== rec.redirectUri) throw new InvalidGrantError('redirect_uri matchar inte');
    delete this.state.codes[key];
    return this.issueTokens(client.client_id, rec.scopes, resource?.toString() ?? rec.resource);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = sha(refreshToken);
    const rec = this.state.refreshTokens[key];
    if (!rec || rec.clientId !== client.client_id || rec.expiresAt < now()) throw new InvalidGrantError('Ogiltig refresh token');
    delete this.state.refreshTokens[key]; // rotation
    const granted = scopes?.length ? scopes.filter((s) => rec.scopes.includes(s)) : rec.scopes;
    return this.issueTokens(client.client_id, granted, resource?.toString() ?? rec.resource);
  }

  private issueTokens(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const access = randomBytes(32).toString('hex');
    const refresh = randomBytes(32).toString('hex');
    const t = now();
    this.state.accessTokens[sha(access)] = { clientId, scopes, expiresAt: t + config.accessTokenTtl, resource };
    this.state.refreshTokens[sha(refresh)] = { clientId, scopes, expiresAt: t + 60 * 60 * 24 * 90, resource };
    this.persist();
    return {
      access_token: access,
      token_type: 'bearer',
      expires_in: config.accessTokenTtl,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const rec = this.state.accessTokens[sha(token)];
    if (!rec) throw new InvalidTokenError('Okänd token');
    if (rec.expiresAt < now()) throw new InvalidTokenError('Token har gått ut');
    return {
      token,
      clientId: rec.clientId,
      scopes: rec.scopes,
      expiresAt: rec.expiresAt,
      resource: rec.resource ? new URL(rec.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const key = sha(request.token);
    delete this.state.accessTokens[key];
    delete this.state.refreshTokens[key];
    this.persist();
  }
}

// ---------- HTML ----------
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function shell(body: string): string {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>NeCom Data MCP</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1e293b;padding:2rem;border-radius:12px;width:min(92vw,380px);box-shadow:0 10px 30px rgba(0,0,0,.4)}
h1{font-size:1.1rem;margin:0 0 .25rem}p{margin:.25rem 0 1rem;color:#94a3b8;font-size:.9rem}
input{width:100%;box-sizing:border-box;padding:.7rem;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;font-size:1rem}
button{margin-top:1rem;width:100%;padding:.75rem;border:0;border-radius:8px;background:#38bdf8;color:#0f172a;font-weight:600;font-size:1rem;cursor:pointer}
.err{color:#fca5a5;font-size:.9rem;margin-top:.5rem}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function loginPage(loginToken: string, clientName: string, error: string | null): string {
  return shell(`<h1>Koppla ${esc(clientName)} till NeCom Data</h1>
<p>Ange serverns lösenord för att ge läsåtkomst till butiks- och analysdata.</p>
<form method="post" action="/login">
<input type="hidden" name="login_token" value="${esc(loginToken)}">
<input type="password" name="password" placeholder="Lösenord" autofocus autocomplete="current-password" required>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<button type="submit">Godkänn</button></form>`);
}

function errorPage(msg: string): string {
  return shell(`<h1>Det gick inte</h1><p>${esc(msg)}</p>`);
}
