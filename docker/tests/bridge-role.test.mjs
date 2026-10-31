import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validate } from '../preflight.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const tokens = { DNA_CLIENT_TOKEN: 'c'.repeat(43) };

test('baked bridge role needs only client capability, dispatches its file and creates no state/auth/log directories', () => {
  assert.deepEqual(validate('bridge', { DNA_CLIENT_TOKEN: tokens.DNA_CLIENT_TOKEN }), []);
  assert.ok(validate('bridge', {}).length);
  const dir = mkdtempSync(join(tmpdir(), 'dna-bridge-wrapper-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'node'), '#!/bin/sh\ncase "$1" in\n' +
      '  */preflight.mjs) exec "' + process.execPath + '" "$@" ;;\n' +
      '  *) printf "%s\\n" "$@" ;;\nesac\n', { mode: 0o700 });
    const env = { PATH: bin + ':' + process.env.PATH, DNA_APP_ROOT: dir,
      DNA_CLIENT_TOKEN: tokens.DNA_CLIENT_TOKEN, DNA_LOG_DIR: join(dir, 'must-not-create-logs'),
      DNA_DATA_DIR: join(dir, 'must-not-create-data'), DNA_CODEX_AUTH_DIR: join(dir, 'must-not-create-auth') };
    const run = spawnSync('/bin/sh', [root + 'docker/entrypoint.sh', 'bridge'], { env, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), root + 'docker/bridge.mjs');
    for (const key of ['DNA_LOG_DIR', 'DNA_DATA_DIR', 'DNA_CODEX_AUTH_DIR']) assert.equal(existsSync(env[key]), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

