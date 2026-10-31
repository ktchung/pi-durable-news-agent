import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge, startBridgeFromEnvironment } from '../bridge.mjs';
const backend = 'backend-fixture-'.padEnd(43, 'b');
const read = 'read-fixture-'.padEnd(43, 'r');
const admin = 'admin-fixture-'.padEnd(43, 'a');

test('bridge refuses missing/reused capabilities and unsafe upstream origins before listening', () => {
  const options = { clientToken: backend, readToken: read, adminToken: admin };
  assert.throws(() => createBridge({ ...options, readToken: '' }));
  assert.throws(() => createBridge({ ...options, adminToken: backend }));
  for (const upstream of ['file:///etc/passwd', 'ftp://example.test', 'http://user:pass@example.test', 'http://example.test/path', 'http://example.test/?q=1', 'http://example.test/#fragment'])
    assert.throws(() => createBridge({ ...options, upstream }));
});

test('environment startup uses explicit private credential paths and upstream, rejecting unsafe fixture files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dna-bridge-start-'));
  const readPath = join(dir, 'read'), adminPath = join(dir, 'admin');
  writeFileSync(readPath, read + '\n', { mode: 0o600 });
  writeFileSync(adminPath, admin + '\n', { mode: 0o600 });
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ path: req.url, token: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ fixture: true }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const env = { DNA_CLIENT_TOKEN: backend, DNA_BRIDGE_READ_TOKEN_PATH: readPath,
    DNA_BRIDGE_ADMIN_TOKEN_PATH: adminPath, DNA_BRIDGE_UPSTREAM: `http://127.0.0.1:${upstream.address().port}` };
  const listen = { host: '127.0.0.1', port: 0 };
  let bridge;
  try {
    chmodSync(readPath, 0o644);
    assert.throws(() => startBridgeFromEnvironment(env, listen));
    chmodSync(readPath, 0o600);
    writeFileSync(readPath, 'x'.repeat(4097));
    assert.throws(() => startBridgeFromEnvironment(env, listen));
    writeFileSync(readPath, read + '\n');
    symlinkSync(readPath, join(dir, 'alias'));
    assert.throws(() => startBridgeFromEnvironment({ ...env, DNA_BRIDGE_READ_TOKEN_PATH: join(dir, 'alias') }, listen));
    assert.throws(() => startBridgeFromEnvironment({ ...env, DNA_BRIDGE_ADMIN_TOKEN_PATH: join(dir, 'missing') }, listen));
    bridge = startBridgeFromEnvironment(env, listen);
    await once(bridge, 'listening');
    const base = `http://127.0.0.1:${bridge.address().port}`;
    const response = await fetch(base + '/v1/feed?limit=5', { headers: { authorization: `Bearer ${read}` } });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { fixture: true });
    assert.deepEqual(seen, [{ path: '/v1/feed?limit=5', token: `Bearer ${backend}` }]);
  } finally {
    if (bridge) await new Promise(resolve => bridge.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI startup failures are sanitized instead of reflecting a private credential filename', () => {
  const privateName = join(tmpdir(), 'synthetic-private-token-path-that-does-not-exist');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../bridge.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, DNA_CLIENT_TOKEN: backend, DNA_BRIDGE_READ_TOKEN_PATH: privateName }, encoding: 'utf8' });
  assert.equal(run.status, 64);
  assert.match(run.stderr, /Bridge startup failed/);
  assert.ok(!run.stderr.includes(privateName));
  assert.ok(!run.stderr.includes(backend));
});
