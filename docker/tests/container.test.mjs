import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../preflight.mjs';
import { untilNextMinute } from '../ticker.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const tokens = { DNA_CLIENT_TOKEN: 'c'.repeat(43), DNA_CRON_TOKEN: 'r'.repeat(43) };

test('preflight accepts explicit live or fully fixture configurations and rejects unsafe/missing values', () => {
  const live = { ...tokens, DNA_PROVIDER: 'openrouter', JEV_BACKEND: 'typesafe',
    DNA_SEARCH_MODE: 'web', OPENROUTER_API_KEY: 'test-not-a-real-key', TYPESAFE_API_KEY: 'test-not-a-real-key' };
  const fixture = { ...tokens, DNA_PROVIDER: 'faux', JEV_BACKEND: 'fixture', DNA_SEARCH_MODE: 'fixture' };
  assert.deepEqual(validate('api', live), []);
  assert.deepEqual(validate('api', fixture), []);
  assert.ok(validate('api', { ...live, TYPESAFE_API_KEY: '' }).length);
  assert.ok(validate('api', { ...live, DNA_PROVIDER: 'typo' }).length);
  assert.ok(validate('api', { ...fixture, JEV_BACKEND: 'typesafe' }).length);
  assert.ok(validate('api', { ...live, DNA_CRON_TOKEN: tokens.DNA_CLIENT_TOKEN }).length);
  assert.ok(validate('api', { ...live, DNA_CRON_TOKEN: ' ' + tokens.DNA_CLIENT_TOKEN + ' ' }).length);
  assert.deepEqual(validate('hub', { DNA_CLIENT_TOKEN: tokens.DNA_CLIENT_TOKEN }), []);
  assert.ok(validate('ticker', { DNA_CRON_TOKEN: tokens.DNA_CRON_TOKEN }).length);
  assert.deepEqual(validate('ticker', { DNA_CRON_TOKEN: tokens.DNA_CRON_TOKEN, DNA_AUTOMATION_ENABLED: 'true' }), []);
  assert.ok(validate('unexpected', live).length);
});

test('Codex is default, requires TypeSafe for API but auth roles need no service/API keys', () => {
  const codex = { ...tokens, DNA_CODEX_AUTH_DIR: '/auth', JEV_BACKEND: 'typesafe',
    DNA_SEARCH_MODE: 'web', TYPESAFE_API_KEY: 'test-not-a-real-key' };
  assert.deepEqual(validate('api', codex), []);
  assert.deepEqual(validate('api', { ...codex, DNA_PROVIDER: 'codex' }), []);
  assert.ok(validate('api', { ...codex, TYPESAFE_API_KEY: '' }).length);
  assert.ok(validate('api', { ...codex, JEV_BACKEND: 'openrouter', OPENROUTER_API_KEY: 'test' }).length);
  assert.ok(validate('api', { ...codex, DNA_CODEX_AUTH_DIR: '' }).length);
  for (const role of ['auth-login', 'auth-status', 'auth-logout']) {
    assert.deepEqual(validate(role, { DNA_CODEX_AUTH_DIR: '/auth' }), []);
    assert.ok(validate(role, {}).length);
  }
});

test('auth preflight enforces a private dedicated mount, skips service state/log directories, and dispatches roles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dna-auth-wrapper-'));
  try {
    const auth = join(dir, 'auth');
    mkdirSync(auth, { mode: 0o700 });
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // Run real preflight, but substitute the final source CLI so login never runs.
    writeFileSync(join(bin, 'node'), '#!/bin/sh\ncase "$1" in\n' +
      '  */preflight.mjs) exec "' + process.execPath + '" "$@" ;;\n' +
      '  *) printf "%s\\n" "$@" ;;\nesac\n', { mode: 0o700 });
    const env = { PATH: bin + ':' + process.env.PATH, DNA_APP_ROOT: dir,
      DNA_CODEX_AUTH_DIR: auth, DNA_LOG_DIR: join(dir, 'must-not-create-logs'), DNA_DATA_DIR: join(dir, 'must-not-create-data') };
    for (const role of ['auth-login', 'auth-status', 'auth-logout']) {
      const run = spawnSync('/bin/sh', [root + 'docker/entrypoint.sh', role], { env, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, '--import\ntsx\napps/shared/packages/durable-agent/src/codex-login.ts\n' + role + '\n');
      assert.equal(existsSync(env.DNA_LOG_DIR), false);
      assert.equal(existsSync(env.DNA_DATA_DIR), false);
    }
    const preflight = () => spawnSync(process.execPath, [root + 'docker/preflight.mjs', 'auth-status'], { env, encoding: 'utf8' });
    chmodSync(auth, 0o755);
    assert.equal(preflight().status, 73);
    chmodSync(auth, 0o700);
    symlinkSync(auth, join(dir, 'alias'));
    env.DNA_CODEX_AUTH_DIR = join(dir, 'alias');
    assert.equal(preflight().status, 73);
    env.DNA_CODEX_AUTH_DIR = join(dir, 'missing');
    assert.equal(preflight().status, 73);
    assert.equal(existsSync(env.DNA_CODEX_AUTH_DIR), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('host preparation creates private auth and preserves existing env/state without reading real deployment secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dna-prepare-'));
  try {
    cpSync(root + '.env.example', join(dir, '.env.example'));
    const prepare = () => spawnSync('python3', [root + 'docker/prepare.py', '--directory', dir], {
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8',
    });
    assert.equal(prepare().status, 0);
    assert.equal(statSync(join(dir, 'auth')).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600);
    const env = readFileSync(join(dir, '.env'), 'utf8'); // disposable generated fixture only
    const lines = Object.fromEntries(env.split('\n').filter((line) => /^[A-Z_]+=/.test(line)).map((line) => line.split(/=(.*)/s).slice(0, 2)));
    assert.equal(lines.DNA_PROVIDER, 'codex');
    assert.equal(lines.DNA_MODEL, '');
    assert.equal(lines.DNA_RESEARCH_MODEL, '');
    assert.notEqual(lines.DNA_CLIENT_TOKEN, lines.DNA_CRON_TOKEN);
    assert.ok(lines.DNA_CLIENT_TOKEN.length >= 32);
    for (const name of ['OPENROUTER_API_KEY', 'TYPESAFE_API_KEY', 'WIREGUARD_PRIVATE_KEY']) assert.equal(lines[name], '');
    writeFileSync(join(dir, 'auth', 'sentinel'), 'preserve-me');
    assert.equal(prepare().status, 0);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), env);
    assert.equal(readFileSync(join(dir, 'auth', 'sentinel'), 'utf8'), 'preserve-me');
    chmodSync(join(dir, 'auth'), 0o755);
    assert.equal(prepare().status, 1);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), env);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('disabled ticker fails closed before any API call; preflight never reflects secret values', () => {
  const env = { PATH: process.env.PATH, DNA_AUTOMATION_ENABLED: 'false', DNA_CRON_TOKEN: 'private-test-value' };
  const result = spawnSync(process.execPath, [root + 'docker/ticker.mjs'], { env, encoding: 'utf8' });
  assert.equal(result.status, 64);
  assert.match(result.stderr, /disabled/);
  const preflight = spawnSync(process.execPath, [root + 'docker/preflight.mjs', 'api'], { env, encoding: 'utf8' });
  assert.equal(preflight.status, 64);
  assert.ok(!preflight.stderr.includes('private-test-value'));
});

test('ticker aligns to the next minute, avoids an immediate tick, and handles SIGTERM while idle', async () => {
  assert.equal(untilNextMinute(0), 60000);
  assert.equal(untilNextMinute(59999), 1);
  const child = spawn(process.execPath, [root + 'docker/ticker.mjs'], {
    env: { PATH: process.env.PATH, DNA_AUTOMATION_ENABLED: 'true' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test('healthcheck exits successfully only for a healthy JSON endpoint', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const child = spawn(process.execPath, [root + 'docker/healthcheck.mjs', 'api'], {
      env: { PATH: process.env.PATH, DNA_PORT: String(server.address().port) }, stdio: 'ignore',
    });
    assert.equal((await once(child, 'exit'))[0], 0);
  } finally { await new Promise((resolve) => server.close(resolve)); }
  const failed = spawnSync(process.execPath, [root + 'docker/healthcheck.mjs', 'api'], {
    env: { PATH: process.env.PATH, DNA_PORT: String(server.address()?.port ?? 1) }, stdio: 'ignore',
  });
  assert.notEqual(failed.status, 0);
});
