import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createBridge } from '../bridge.mjs';

const read = 'read-fixture-'.padEnd(43, 'r');
const admin = 'admin-fixture-'.padEnd(43, 'a');
const backend = 'backend-fixture-'.padEnd(43, 'b');

async function fixture(fn) {
  const seen = [];
  const upstream = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/v1/cards/8' ? { diagnostic: backend } : { fixture: true }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const bridge = createBridge({ clientToken: backend, readToken: read, adminToken: admin,
    upstream: `http://127.0.0.1:${upstream.address().port}` });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  const request = (path, { token = read, method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: bridge.address().port, path, method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers } }, res => {
      let text = '';
      res.on('data', data => { text += data; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.once('error', reject);
    req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
  });
  try { await fn(request, seen); }
  finally {
    await Promise.all([new Promise(r => bridge.close(r)), new Promise(r => upstream.close(r))]);
  }
}

test('real HTTP: independent read/admin credentials, exact schedule forwarding, no paid/chat route and secret reflection', async () => {
  await fixture(async (request, seen) => {
    assert.equal((await request('/healthz', { token: null })).status, 200);
    assert.equal((await request('/v1/schedule', { token: null })).status, 401);
    assert.equal((await request('/v1/schedule', { token: backend })).status, 401);
    for (const path of ['/v1/schedule', '/v1/sweeps?limit=100&before=42', '/v1/feed?limit=1000', '/v1/cards/7', '/v1/sweeps/5'])
      assert.equal((await request(path)).status, 200);
    const before = seen.length;
    assert.equal((await request('/v1/schedule', { method: 'PATCH', body: { cronExpression: '0 6,18 * * *' } })).status, 403);
    for (const path of ['/v1/agent/messages', '/v1/workflows/news-sweep', '/v1/agent/config'])
      assert.equal((await request(path, { token: admin, method: 'POST', body: {} })).status, 403);
    assert.equal(seen.length, before);
    const body = { cronExpression: '0 6,18 * * *', timezone: 'Asia/Taipei' };
    assert.equal((await request('/v1/schedule', { token: admin, method: 'PATCH', body })).status, 200);
    assert.deepEqual(seen.at(-1), { method: 'PATCH', path: '/v1/schedule', auth: `Bearer ${backend}`, body });
    const response = await request('/v1/cards/8');
    assert.ok(response.text.includes('[redacted]'));
    assert.ok(!response.text.includes(backend));
  });
});

test('real HTTP: path/query/header/body allowlists reject before upstream access', async () => {
  await fixture(async (request, seen) => {
    for (const path of ['//attacker.example/v1/schedule', '/v1/feed/../schedule', '/v1/%63ards/1', '/v1/feed?limit=0', '/v1/feed?limit=1001', '/v1/feed?limit=1&limit=2', '/v1/feed?url=http://attacker', '/v1/cards/0', '/hub/healthz', '/api/v1/feed', '/v1/info', '/'])
      assert.ok((await request(path)).status >= 400, path);
    assert.equal((await request('/v1/schedule', { headers: { origin: 'http://evil.test' } })).status, 403);
    assert.equal((await request('/v1/schedule', { headers: { cookie: 'session=fixture' } })).status, 403);
    for (const body of [{ cronExpression: '* * * * *', cardsPerSweep: 30 }, { timezone: 'UTC' }, { cronExpression: '@daily' }, { cronExpression: '0 0 8 * * *' }, []])
      assert.equal((await request('/v1/schedule', { token: admin, method: 'PATCH', body })).status, 400);
    assert.equal((await request('/v1/schedule', { token: admin, method: 'PATCH', body: 'x'.repeat(3000) })).status, 413);
    assert.equal(seen.length, 0);
  });
});
