// Real local HTTP fixture; never contacts the news app or a paid provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
const control = fileURLToPath(new URL('../control.mjs', import.meta.url));

test('control forwards exact cron/timezone, pauses canonically, reads status and refuses malformed invocation', async () => {
  const seen = [];
  const token = 'synthetic-client-fixture';
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ fixture: true, cronExpression: '0 */8 * * *', schedulerStatus: 'waiting' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    DNA_PORT: String(server.address().port), DNA_CLIENT_TOKEN: token };
  const run = async (...args) => {
    const child = spawn(process.execPath, [control, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; });
    child.stderr.on('data', data => { err += data; });
    const [code] = await once(child, 'close');
    assert.ok(!out.includes(token) && !err.includes(token));
    return { code, out, err };
  };
  try {
    assert.equal((await run('set-cron', '0 */8 * * *', 'Asia/Tokyo')).code, 0);
    assert.deepEqual(seen.at(-1).body, { cronExpression: '0 */8 * * *', timezone: 'Asia/Tokyo' });
    assert.equal((await run('set-cron', '15 6,18 * * 1-5')).code, 0);
    assert.deepEqual(seen.at(-1).body, { cronExpression: '15 6,18 * * 1-5' });
    assert.equal((await run('pause')).code, 0);
    assert.deepEqual(seen.at(-1).body, { cronExpression: null });
    const read = await run('schedule');
    assert.equal(read.code, 0);
    assert.equal(JSON.parse(read.out).schedulerStatus, 'waiting');
    assert.equal(seen.at(-1).method, 'GET');
    assert.equal((await run('set-cron')).code, 64);
    assert.equal((await run('set-cron', '* * * * *', 'UTC', 'extra')).code, 64);
    assert.equal(seen.length, 4);
    assert.ok(seen.every(req => req.path === '/v1/schedule' && req.authorization === `Bearer ${token}`));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
