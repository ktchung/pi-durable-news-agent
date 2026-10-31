import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const base = process.env.DNA_TEST_BASE || root;
const executable = process.env.DNA_TEST_COMPOSE;
function config(overrides = {}) {
  const args = ['--env-file', '/dev/null', '-f', base + '/compose.yaml', '-f', root + 'compose.hermes-bridge.yaml',
    '--profile', 'auth', '--profile', 'scheduler', 'config', '--format', 'json'];
  const result = spawnSync(executable, args, { env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    COMPOSE_DISABLE_ENV_FILE: '1', ...overrides }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('scoped bridge alone joins the external network, using the same image without inline code or provider secrets', { skip: !executable }, () => {
  const document = config();
  const services = document.services, bridge = services['hermes-bridge'];
  assert.deepEqual(Object.keys(services).sort(), ['api', 'auth', 'gluetun', 'hermes-bridge', 'hub', 'ticker']);
  assert.equal(bridge.image, services.api.image);
  assert.deepEqual(bridge.command, ['bridge']);
  assert.equal(bridge.build, undefined);
  assert.equal(bridge.ports, undefined);
  assert.equal(bridge.read_only, true);
  assert.deepEqual(Object.keys(bridge.networks).sort(), ['default', 'hermes-control']);
  assert.deepEqual(Object.keys(services.gluetun.networks), ['default']);
  assert.deepEqual(services.gluetun.networks.default.aliases, ['news-private-api']);
  assert.equal(services.gluetun.environment.FIREWALL_INPUT_PORTS, '4850,4851');
  assert.equal(document.networks['hermes-control'].external, true);
  assert.equal(document.networks['hermes-control'].name, 'shared-services');
  assert.deepEqual(bridge.networks['hermes-control'].aliases, ['news-control']);
  assert.deepEqual(Object.keys(bridge.environment).sort(), ['DNA_BRIDGE_ADMIN_TOKEN_PATH', 'DNA_BRIDGE_READ_TOKEN_PATH', 'DNA_BRIDGE_UPSTREAM', 'DNA_CLIENT_TOKEN']);
  assert.equal(bridge.environment.DNA_BRIDGE_UPSTREAM, 'http://news-private-api:4850');
  assert.deepEqual(bridge.volumes.map(v => v.target).sort(), ['/run/news-admin.token', '/run/news-read.token']);
  for (const mount of bridge.volumes) {
    assert.equal(mount.read_only, true);
    assert.equal(mount.bind.create_host_path, false);
    assert.ok(!/docker\.sock|\/auth$|\.env$/.test(mount.source));
  }
  for (const name of ['api', 'hub', 'ticker', 'auth']) {
    assert.equal(services[name].network_mode, 'service:gluetun');
    assert.equal(services[name].networks, undefined);
    assert.equal(services[name].ports, undefined);
  }
  const ports = Object.values(services).flatMap(s => s.ports || []);
  assert.equal(ports.length, 1);
  assert.equal(ports[0].host_ip, '127.0.0.1');
  assert.equal(ports[0].target, 4851);
  assert.equal(services.ticker.environment.DNA_AUTOMATION_ENABLED, 'false');
  assert.deepEqual(bridge.healthcheck.test, ['CMD', 'node', '/opt/dna-container/healthcheck.mjs', 'bridge']);
});

test('bridge host token paths, existing network, both aliases, image and upstream are portable settings', { skip: !executable }, () => {
  const document = config({ DNA_IMAGE: 'example/news:review', DNA_BRIDGE_NETWORK: 'example-control',
    DNA_BRIDGE_ALIAS: 'example-news', DNA_BRIDGE_PRIVATE_ALIAS: 'example-api',
    DNA_BRIDGE_UPSTREAM: 'http://example-api:4850',
    DNA_BRIDGE_READ_TOKEN_FILE: '/example/credentials/read-token', DNA_BRIDGE_ADMIN_TOKEN_FILE: '/example/credentials/admin-token' });
  const bridge = document.services['hermes-bridge'];
  assert.equal(bridge.image, 'example/news:review');
  assert.equal(bridge.image, document.services.api.image);
  assert.equal(document.networks['hermes-control'].name, 'example-control');
  assert.deepEqual(bridge.networks['hermes-control'].aliases, ['example-news']);
  assert.deepEqual(document.services.gluetun.networks.default.aliases, ['example-api']);
  assert.equal(bridge.environment.DNA_BRIDGE_UPSTREAM, 'http://example-api:4850');
  assert.deepEqual(bridge.volumes.map(v => v.source).sort(), ['/example/credentials/admin-token', '/example/credentials/read-token']);
});
