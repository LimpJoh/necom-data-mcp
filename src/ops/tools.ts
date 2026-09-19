/**
 * OPS-lager: låter Claude sätta upp och drifta projekt via servern – GitHub, Supabase Management API,
 * Hostinger DNS och kommandon på VPS:en (SSH till värden från containern).
 *
 * Säkerhet:
 *  - Registreras bara när OPS_ENABLED=true.
 *  - Alla skrivande anrop kräver `confirm: true` och loggas till OPS_AUDIT_LOG (data/ops-audit.log).
 *  - Tokens ligger i .env på servern; inget returneras till klienten.
 *  - vps_exec kör som OPS_SSH_USER (rekommenderat: en `deploy`-användare med sudo bara för caddy reload).
 */
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from '../config.js';
import { brands, brandCard } from '../brands.js';
import { textResult, errorResult } from '../util.js';
import { appendJournal } from '../journal.js';

const ops = config.ops;

async function audit(action: string, detail: unknown): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), action, detail }) + '\n';
  await fs.appendFile(ops.auditLog, line).catch(() => undefined);
  await appendJournal({ brand: 'platform', type: action === 'vps_exec' || action === 'caddy_add_site' ? 'deploy' : 'change', title: `ops: ${action}`, detail: JSON.stringify(detail).slice(0, 4000), source: `ops_${action}` }).catch(() => undefined);
}

function needConfirm(confirm: boolean | undefined, what: string): void {
  if (!confirm) throw new Error(`Skrivande åtgärd (${what}) kräver confirm=true. Beskriv för Linus vad som kommer att hända och be om ja först.`);
}

// ---------- GitHub ----------
async function gh<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!ops.githubToken) throw new Error('OPS_GITHUB_TOKEN saknas.');
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${ops.githubToken}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'necom-data-mcp' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return (res.status === 204 ? {} : await res.json()) as T;
}

// ---------- Supabase Management ----------
async function sbm<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!ops.supabaseAccessToken) throw new Error('OPS_SUPABASE_ACCESS_TOKEN saknas (skapa på supabase.com/dashboard/account/tokens).');
  const res = await fetch(`https://api.supabase.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${ops.supabaseAccessToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return (await res.json()) as T;
}

// ---------- Hostinger ----------
async function hostinger<T>(method: string, path: string, body?: unknown): Promise<T> {
  if (!ops.hostingerToken) throw new Error('OPS_HOSTINGER_TOKEN saknas (hPanel → API).');
  const res = await fetch(`https://developers.hostinger.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${ops.hostingerToken}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Hostinger ${res.status}: ${(await res.text()).slice(0, 400)}`);
  return (await res.json().catch(() => ({}))) as T;
}

// ---------- SSH till VPS ----------
function ssh(command: string, timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const args = ['-i', ops.sshKeyFile, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes', '-o', `ConnectTimeout=10`, `${ops.sshUser}@${ops.sshHost}`, command];
    const p = spawn('ssh', args);
    let stdout = '';
    let stderr = '';
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout: stdout.slice(-20_000), stderr: stderr.slice(-5_000) });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, stdout: '', stderr: String(e) });
    });
  });
}

export function registerOpsTools(server: McpServer): void {
  if (!ops.enabled) return;

  server.registerTool(
    'ops_status',
    { title: 'Ops – vad är konfigurerat', description: 'Visar vilka ops-integrationer som är aktiva (GitHub, Supabase, Hostinger, SSH) och varumärkesregistret. Inga hemligheter.', inputSchema: {} },
    async () => {
      const sshOk = await ssh('echo ok', 15_000);
      return textResult({
        github: Boolean(ops.githubToken) ? { owner: ops.githubOwner } : null,
        supabase_management: Boolean(ops.supabaseAccessToken) ? { org: ops.supabaseOrgId || null } : null,
        hostinger: Boolean(ops.hostingerToken),
        vps: { ip: ops.vpsIp || null, ssh_user: ops.sshUser, ssh_reachable: sshOk.stdout.trim() === 'ok', ssh_error: sshOk.stdout.trim() === 'ok' ? null : sshOk.stderr.trim() },
        brands: brands().map(brandCard),
      });
    },
  );

  // ----- GitHub -----
  server.registerTool(
    'ops_github_list_repos',
    { title: 'GitHub – lista repon', description: 'Listar ägarens repon (namn, privat/publikt, default branch, senast pushat).', inputSchema: { limit: z.number().int().min(1).max(100).optional() } },
    async ({ limit }) => {
      try {
        const repos = await gh<{ name: string; private: boolean; default_branch: string; pushed_at: string; html_url: string }[]>('GET', `/user/repos?per_page=${limit ?? 50}&sort=pushed`);
        return textResult(repos.map((r) => ({ name: r.name, private: r.private, default_branch: r.default_branch, pushed_at: r.pushed_at, url: r.html_url })));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ops_github_create_repo',
    {
      title: 'GitHub – skapa repo',
      description: 'Skapar ett nytt repo under ägaren (privat som default) och lägger valfritt in startfiler (README, .gitignore, workflow). Kräver confirm=true.',
      inputSchema: {
        name: z.string().regex(/^[a-z0-9._-]+$/i),
        description: z.string().optional(),
        private: z.boolean().optional(),
        files: z.array(z.object({ path: z.string(), content: z.string() })).optional().describe('Startfiler som committas till main.'),
        confirm: z.boolean().optional(),
      },
    },
    async ({ name, description, private: priv, files, confirm }) => {
      try {
        needConfirm(confirm, `skapa repo ${name}`);
        const repo = await gh<{ full_name: string; html_url: string; default_branch: string }>('POST', '/user/repos', { name, description, private: priv ?? true, auto_init: true, default_branch: 'main' });
        const written: string[] = [];
        for (const f of files ?? []) {
          await gh('PUT', `/repos/${repo.full_name}/contents/${f.path}`, { message: `chore: add ${f.path}`, content: Buffer.from(f.content).toString('base64'), branch: 'main' });
          written.push(f.path);
        }
        await audit('github_create_repo', { name, files: written });
        return textResult({ repo: repo.full_name, url: repo.html_url, files_written: written });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ops_github_put_file',
    {
      title: 'GitHub – skriv/uppdatera fil',
      description: 'Skapar eller uppdaterar en fil i ett repo på angiven branch (commit via API). Kräver confirm=true.',
      inputSchema: { repo: z.string().describe('owner/name'), path: z.string(), content: z.string(), message: z.string(), branch: z.string().optional(), confirm: z.boolean().optional() },
    },
    async ({ repo, path, content, message, branch, confirm }) => {
      try {
        needConfirm(confirm, `skriva ${path} i ${repo}`);
        const br = branch ?? 'main';
        let sha: string | undefined;
        try {
          const cur = await gh<{ sha: string }>('GET', `/repos/${repo}/contents/${path}?ref=${br}`);
          sha = cur.sha;
        } catch {
          /* ny fil */
        }
        const res = await gh<{ commit: { sha: string; html_url: string } }>('PUT', `/repos/${repo}/contents/${path}`, { message, content: Buffer.from(content).toString('base64'), branch: br, sha });
        await audit('github_put_file', { repo, path, branch: br });
        return textResult({ repo, path, branch: br, commit: res.commit.sha, url: res.commit.html_url });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ops_github_workflow_runs',
    { title: 'GitHub – senaste workflow-körningar', description: 'Status och slutsats för de senaste Actions-körningarna i ett repo.', inputSchema: { repo: z.string(), limit: z.number().int().min(1).max(20).optional() } },
    async ({ repo, limit }) => {
      try {
        const r = await gh<{ workflow_runs: { name: string; status: string; conclusion: string | null; head_branch: string; created_at: string; html_url: string }[] }>('GET', `/repos/${repo}/actions/runs?per_page=${limit ?? 5}`);
        return textResult(r.workflow_runs.map((x) => ({ name: x.name, status: x.status, conclusion: x.conclusion, branch: x.head_branch, created_at: x.created_at, url: x.html_url })));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // ----- Supabase Management -----
  server.registerTool(
    'ops_supabase_list_projects',
    { title: 'Supabase – lista projekt', description: 'Projekt i organisationen med ref, region, status.', inputSchema: {} },
    async () => {
      try {
        const p = await sbm<{ id: string; name: string; region: string; status: string; organization_id: string }[]>('GET', '/v1/projects');
        return textResult(p.map((x) => ({ ref: x.id, name: x.name, region: x.region, status: x.status, org: x.organization_id })));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ops_supabase_run_sql',
    {
      title: 'Supabase – kör SQL (migration/vy)',
      description: 'Kör SQL mot ett projekt via Management API, t.ex. för att skapa v_sales-vyn i ett nytt projekt. Kräver confirm=true. Läsande SELECT går utan confirm.',
      inputSchema: { project_ref: z.string(), sql: z.string(), confirm: z.boolean().optional() },
    },
    async ({ project_ref, sql, confirm }) => {
      try {
        const readOnly = /^\s*(select|with|explain)\b/i.test(sql) && !/;\s*\S/.test(sql.trim().replace(/;$/, ''));
        if (!readOnly) needConfirm(confirm, `köra SQL i ${project_ref}`);
        const res = await sbm<unknown>('POST', `/v1/projects/${project_ref}/database/query`, { query: sql });
        if (!readOnly) await audit('supabase_run_sql', { project_ref, sql: sql.slice(0, 2000) });
        return textResult({ project_ref, read_only: readOnly, result: res });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ops_supabase_create_project',
    {
      title: 'Supabase – skapa projekt',
      description: 'Skapar ett nytt Supabase-projekt i organisationen (region eu-north-1 default). Databaslösenordet genereras på servern och returneras EN gång – spara det i .env direkt. Kräver confirm=true.',
      inputSchema: { name: z.string(), region: z.string().optional(), plan: z.enum(['free', 'pro']).optional(), confirm: z.boolean().optional() },
    },
    async ({ name, region, plan, confirm }) => {
      try {
        needConfirm(confirm, `skapa Supabase-projekt ${name}`);
        if (!ops.supabaseOrgId) throw new Error('OPS_SUPABASE_ORG_ID saknas.');
        const { randomBytes } = await import('node:crypto');
        const dbPass = randomBytes(24).toString('base64url');
        const res = await sbm<{ id: string; name: string; region: string; status: string }>('POST', '/v1/projects', { organization_id: ops.supabaseOrgId, name, region: region ?? 'eu-north-1', plan: plan ?? 'free', db_pass: dbPass });
        await audit('supabase_create_project', { name, ref: res.id });
        return textResult({ ref: res.id, name: res.name, region: res.region, status: res.status, db_password_once: dbPass, next: 'Vänta tills status=ACTIVE_HEALTHY, kör sedan ops_supabase_run_sql med sql/v_sales.sql.' });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // ----- Hostinger DNS -----
  server.registerTool(
    'ops_dns_get',
    { title: 'Hostinger – DNS-poster', description: 'Läser DNS-zonen för en domän.', inputSchema: { domain: z.string() } },
    async ({ domain }) => {
      try {
        return textResult(await hostinger('GET', `/api/dns/v1/zones/${domain}`));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ops_dns_upsert',
    {
      title: 'Hostinger – skapa/uppdatera DNS-post',
      description: 'Sätter en A/CNAME/TXT-post (ersätter poster med samma namn+typ). Kräver confirm=true.',
      inputSchema: { domain: z.string(), name: z.string().describe('t.ex. "shop" eller "@"'), type: z.enum(['A', 'AAAA', 'CNAME', 'TXT']), content: z.string(), ttl: z.number().int().optional(), confirm: z.boolean().optional() },
    },
    async ({ domain, name, type, content, ttl, confirm }) => {
      try {
        needConfirm(confirm, `DNS ${name}.${domain} ${type} → ${content}`);
        const res = await hostinger('PUT', `/api/dns/v1/zones/${domain}`, { overwrite: true, zone: [{ name, type, ttl: ttl ?? 300, records: [{ content }] }] });
        await audit('dns_upsert', { domain, name, type, content });
        return textResult({ ok: true, res });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  // ----- VPS -----
  server.registerTool(
    'ops_vps_exec',
    {
      title: 'VPS – kör kommando (SSH)',
      description:
        'Kör ett shell-kommando på VPS:en som OPS_SSH_USER. Läsande kommandon (ls, cat, docker ps, pm2 list, logs, ss, df) går direkt; allt annat kräver confirm=true och loggas. Använd för att läsa loggar, lista portar, deploya (git pull && docker compose up -d --build), lägga Caddy-block m.m.',
      inputSchema: { command: z.string(), timeout_seconds: z.number().int().min(5).max(600).optional(), confirm: z.boolean().optional() },
    },
    async ({ command, timeout_seconds, confirm }) => {
      try {
        const readOnly = /^\s*(ls|cat|head|tail|grep|docker (ps|logs|images|compose ls)|pm2 (list|ls|logs|status)|ss|df|free|uptime|systemctl status|caddy validate|git (status|log))\b/.test(command) && !/[|;&>]\s*(rm|mv|cp|tee|sh|bash)\b/.test(command);
        if (!readOnly) needConfirm(confirm, `köra "${command.slice(0, 80)}" på VPS:en`);
        const res = await ssh(command, (timeout_seconds ?? 120) * 1000);
        if (!readOnly) await audit('vps_exec', { command, code: res.code });
        return textResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ops_vps_free_port',
    { title: 'VPS – nästa lediga port', description: 'Listar lyssnande portar och returnerar första lediga i intervallet 3000–3999.', inputSchema: {} },
    async () => {
      try {
        const res = await ssh(`ss -ltnH | awk '{print $4}' | awk -F: '{print $NF}' | sort -un`);
        const used = new Set(res.stdout.split(/\s+/).filter(Boolean).map(Number));
        let free: number | null = null;
        for (let p = 3000; p < 4000; p++)
          if (!used.has(p)) {
            free = p;
            break;
          }
        return textResult({ listening: [...used].sort((a, b) => a - b), next_free: free });
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'ops_caddy_add_site',
    {
      title: 'VPS – lägg till Caddy-block',
      description: 'Lägger till ett reverse_proxy-block för ett värdnamn i Caddyfile (om det inte redan finns), validerar och laddar om Caddy. Kräver confirm=true och att OPS_SSH_USER får köra `sudo systemctl reload caddy` samt skriva /etc/caddy/Caddyfile (eller en importerad conf.d-katalog).',
      inputSchema: { hostname: z.string(), port: z.number().int(), caddyfile: z.string().optional().describe('Default /etc/caddy/Caddyfile'), confirm: z.boolean().optional() },
    },
    async ({ hostname, port, caddyfile, confirm }) => {
      try {
        needConfirm(confirm, `Caddy-block ${hostname} → 127.0.0.1:${port}`);
        const file = caddyfile ?? '/etc/caddy/Caddyfile';
        const block = `\n${hostname} {\n\tencode gzip\n\treverse_proxy 127.0.0.1:${port} {\n\t\tflush_interval -1\n\t}\n}\n`;
        const script = `grep -q '^${hostname} ' ${file} && echo EXISTS || { printf '%s' '${block.replace(/'/g, "'\\''")}' | sudo tee -a ${file} >/dev/null && sudo caddy validate --config ${file} && sudo systemctl reload caddy && echo ADDED; }`;
        const res = await ssh(script);
        await audit('caddy_add_site', { hostname, port, code: res.code, out: res.stdout.trim() });
        return textResult(res);
      } catch (e) {
        return errorResult(e);
      }
    },
  );
}
