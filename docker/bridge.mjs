// Scoped credential broker: backend client credentials never leave this process.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest();
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
const fail = (res, status) => json(res, status, { error: { code: `bridge_${status}` } });
const rules = [
  [/^\/v1\/schedule$/, []],
  [/^\/v1\/sweeps$/, ['limit', 'before']],
  [/^\/v1\/sweeps\/[1-9]\d*$/, []],
  [/^\/v1\/feed$/, ['limit', 'before']],
  [/^\/v1\/cards\/[1-9]\d*$/, []],
];

export function createBridge({ clientToken, readToken, adminToken, upstream = 'http://news-private-api:4850' }) {
  for (const value of [clientToken, readToken, adminToken])
    if (typeof value !== 'string' || value.length < 32) throw new Error('Missing bridge credential');
  if (new Set([clientToken, readToken, adminToken]).size !== 3) throw new Error('Bridge credentials must differ');
  // Accept only an origin: never allow credentials, paths, queries or fragments.
  const target = new URL(upstream);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password ||
      target.pathname !== '/' || target.search || target.hash) throw new Error('Invalid bridge upstream origin');
  upstream = target.origin;
  const readHash = hash(readToken), adminHash = hash(adminToken);
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    const deadline = setTimeout(() => req.destroy(), 12_000);
    const controller = new AbortController();
    res.once('close', () => { clearTimeout(deadline); controller.abort(); });
    try {
      if (req.url === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true, role: 'scoped-news-bridge' });
      // This endpoint is not a browser UI and cannot use browser cookies/CSRF bypasses.
      if (req.headers.origin || req.headers.cookie) return fail(res, 403);
      const header = req.headers.authorization ?? '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
      const digest = hash(bearer);
      const admin = timingSafeEqual(digest, adminHash);
      if (!admin && !timingSafeEqual(digest, readHash)) return fail(res, 401);
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) return fail(res, 400);
      const rawPath = req.url.split('?')[0];
      if (/[%\\]/.test(rawPath) || rawPath.includes('..')) return fail(res, 400);
      const url = new URL(req.url, 'http://bridge.invalid');
      let body;
      if (req.method === 'GET') {
        const rule = rules.find(([pattern]) => pattern.test(url.pathname));
        if (!rule) return fail(res, 403);
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] ?? 0) !== 0) return fail(res, 400);
        const seen = new Set();
        for (const [key, value] of url.searchParams) {
          if (!rule[1].includes(key) || seen.has(key) || !/^[1-9]\d{0,8}$/.test(value)) return fail(res, 400);
          if (key === 'limit' && Number(value) > 1000) return fail(res, 400);
          seen.add(key);
        }
      } else if (req.method === 'PATCH' && url.pathname === '/v1/schedule' && !url.search) {
        if (!admin) return fail(res, 403);
        if (req.headers['content-type']?.split(';')[0] !== 'application/json') return fail(res, 415);
        let text = '', size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 2048) return fail(res, 413);
          text += chunk;
        }
        let input;
        try { input = JSON.parse(text); } catch { return fail(res, 400); }
        if (!input || Array.isArray(input) || typeof input !== 'object') return fail(res, 400);
        const keys = Object.keys(input);
        if (!keys.includes('cronExpression') || keys.some(key => !['cronExpression', 'timezone'].includes(key))) return fail(res, 400);
        if (input.cronExpression !== null && (typeof input.cronExpression !== 'string' || input.cronExpression.length > 128 || input.cronExpression.trim().split(/\s+/).length !== 5)) return fail(res, 400);
        if (input.timezone !== undefined && (typeof input.timezone !== 'string' || input.timezone.length > 80)) return fail(res, 400);
        body = JSON.stringify(input);
      } else return fail(res, 403);
      const response = await fetch(upstream + url.pathname + url.search, {
        method: req.method, redirect: 'error', signal: controller.signal,
        headers: { authorization: `Bearer ${clientToken}`, 'content-type': 'application/json' },
        ...(body !== undefined ? { body } : {}),
      });
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > 4 * 1024 * 1024) { await response.body?.cancel(); return fail(res, 502); }
      let text = '', length = 0;
      const decoder = new TextDecoder();
      for await (const chunk of response.body ?? []) {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) { controller.abort(); return fail(res, 502); }
        text += decoder.decode(chunk, { stream: true });
      }
      text += decoder.decode();
      // Refuse secret reflection even if an upstream diagnostic accidentally contains one.
      for (const secret of [clientToken, readToken, adminToken]) text = text.replaceAll(secret, '[redacted]');
      let result;
      try { result = JSON.parse(text); } catch { return fail(res, 502); }
      return json(res, response.status, result);
    } catch {
      if (!res.headersSent && !res.destroyed) fail(res, 502);
    } finally {
      clearTimeout(deadline);
    }
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 12_000;
  server.keepAliveTimeout = 1000;
  server.maxConnections = 32;
  return server;
}

export function startBridgeFromEnvironment(env = process.env, listen = { port: 4852, host: '0.0.0.0' }) {
  const secret = path => {
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 4096) throw new Error('Private regular credential file required');
    return readFileSync(path, 'utf8').trim();
  };
  const server = createBridge({
    clientToken: env.DNA_CLIENT_TOKEN?.trim(),
    readToken: secret(env.DNA_BRIDGE_READ_TOKEN_PATH || '/run/news-read.token'),
    adminToken: secret(env.DNA_BRIDGE_ADMIN_TOKEN_PATH || '/run/news-admin.token'),
    upstream: env.DNA_BRIDGE_UPSTREAM || 'http://news-private-api:4850',
  });
  server.listen(listen, () => console.log('Scoped news API bridge ready'));
  const stop = () => server.close(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  server.once('close', () => {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { startBridgeFromEnvironment(); }
  catch { console.error('Bridge startup failed: check private credentials and upstream origin'); process.exitCode = 64; }
}
