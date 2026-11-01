import test from 'node:test';
import assert from 'node:assert/strict';
import { compose, runCompose } from './compose-command.mjs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
function config(profiles = [], fixtureEnv = {}) {
  const args = ['--env-file', '/dev/null', '-f', root + 'compose.yaml'];
  for (const profile of profiles) args.push('--profile', profile);
  args.push('config', '--format', 'json');
  // No inherited secrets, .env values or active profiles. No Docker daemon calls.
  const result = runCompose(args, { PATH: process.env.PATH, HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR, COMPOSE_DISABLE_ENV_FILE: '1', ...fixtureEnv });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function assertBoundaries(document) {
  const services = document.services;
  const authHolders = [];
  for (const [name, service] of Object.entries(services)) {
    const mounts = service.volumes ?? [];
    if (mounts.some((mount) => mount.target === '/auth')) authHolders.push(name);
    if (['api', 'hub', 'ticker', 'auth'].includes(name)) {
      assert.equal(service.network_mode, 'service:gluetun');
      assert.equal(service.read_only, true);
      assert.equal(service.ports, undefined);
      assert.equal(service.environment.WIREGUARD_PRIVATE_KEY, undefined);
    }
    if (['hub', 'ticker', 'auth'].includes(name)) {
      for (const key of ['OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'TYPESAFE_API_KEY', 'FIRECRAWL_API_KEY'])
        assert.equal(service.environment?.[key], undefined);
    }
    for (const mount of mounts) {
      assert.equal(mount.type, 'bind');
      assert.equal(mount.bind?.create_host_path ?? false, false);
      assert.ok(!/hermes|\.env|docker\.sock/.test(mount.source));
    }
  }
  assert.deepEqual(authHolders.sort(), services.auth ? ['api', 'auth'] : ['api']);
  assert.equal(services.api.environment.DNA_PROVIDER, 'codex');
  assert.equal(services.api.environment.DNA_MODEL, '');
  assert.equal(services.api.environment.DNA_RESEARCH_MODEL, '');
  assert.equal(services.api.environment.DNA_CODEX_AUTH_DIR, '/auth');
  assert.equal(services.api.environment.DNA_SWEEP_CRON, '0 */8 * * *');
  assert.equal(services.api.environment.DNA_SWEEP_TIMEZONE, 'Asia/Taipei');
  assert.equal(services.api.environment.DNA_CRON_SCHEDULE, '* * * * *', 'tick transport is not the persisted sweep cron');
  const ports = Object.entries(services).flatMap(([name, service]) => (service.ports ?? []).map((port) => ({ name, ...port })));
  assert.equal(ports.length, 1);
  assert.equal(ports[0].name, 'gluetun');
  assert.equal(ports[0].host_ip, '127.0.0.1');
  assert.equal(ports[0].target, 4851);
  assert.equal(String(ports[0].published), '4851');
}

test('base Compose defaults to Codex with isolated API auth and no auth helper/ticker running', { skip: !compose }, () => {
  const document = config();
  assert.deepEqual(Object.keys(document.services).sort(), ['api', 'gluetun', 'hub']);
  assertBoundaries(document);
  assert.equal(document.services.gluetun.environment.WIREGUARD_ENDPOINT_PORT, '0');
  const surfshark = config([], { VPN_SERVICE_PROVIDER: 'surfshark', WIREGUARD_ENDPOINT_PORT: '' });
  assert.equal(surfshark.services.gluetun.environment.WIREGUARD_ENDPOINT_PORT, '0', 'an empty managed-provider setting must not inject port 51820');
  const custom = config([], { VPN_SERVICE_PROVIDER: 'custom', WIREGUARD_ENDPOINT_PORT: '51820' });
  assert.equal(custom.services.gluetun.environment.WIREGUARD_ENDPOINT_PORT, '51820', 'explicit custom peer port is preserved');
  const scheduled = config(['scheduler'], {
    TZ: 'Europe/London', DNA_SWEEP_CRON: '15 6,18 * * 1-5', DNA_SWEEP_TIMEZONE: '', DNA_AUTOMATION_ENABLED: 'true',
  });
  assert.equal(scheduled.services.api.environment.DNA_SWEEP_CRON, '15 6,18 * * 1-5');
  assert.equal(scheduled.services.api.environment.DNA_SWEEP_TIMEZONE, 'Europe/London', 'empty explicit timezone follows TZ');
  assert.equal(scheduled.services.ticker.environment.DNA_CRON_SCHEDULE, '* * * * *');
  assert.equal(scheduled.services.ticker.environment.DNA_AUTOMATION_ENABLED, 'true');
  const explicitZone = config([], { TZ: 'Europe/London', DNA_SWEEP_TIMEZONE: 'Asia/Taipei' });
  assert.equal(explicitZone.services.api.environment.DNA_SWEEP_TIMEZONE, 'Asia/Taipei');
});

test('auth profile contains only dedicated auth mount and no API, cron, Jev or provider keys', { skip: !compose }, () => {
  const document = config(['auth']);
  assertBoundaries(document);
  assert.equal(document.services.ticker, undefined);
  const auth = document.services.auth;
  assert.equal(auth.restart, 'no');
  assert.deepEqual(auth.command, ['auth-status']);
  assert.deepEqual(Object.keys(auth.environment).sort(), ['DNA_CODEX_AUTH_DIR', 'DNA_ENV_FILE', 'HOME']);
  assert.deepEqual(auth.volumes.map((volume) => volume.target), ['/auth']);
  assert.equal(auth.volumes[0].source, document.services.api.volumes.find((volume) => volume.target === '/auth').source);
});

test('scheduler profile remains private with automation disabled by default', { skip: !compose }, () => {
  const document = config(['scheduler', 'auth']);
  assertBoundaries(document);
  assert.equal(document.services.ticker.environment.DNA_AUTOMATION_ENABLED, 'false');
  assert.equal(document.services.ticker.environment.DNA_CLIENT_TOKEN, undefined);
  assert.equal(document.services.hub.environment.DNA_CRON_TOKEN, undefined);
  assert.deepEqual(Object.keys(document.services.gluetun.networks), ['default']);
  assert.deepEqual(Object.keys(document.networks), ['default']);
  assert.equal(document.networks.default.external, undefined);
  assert.equal(document.services.api.build.context, root.replace(/\/$/, ''));
  assert.deepEqual(Object.keys(document.services.api.build.args), ['NODE_IMAGE']);
});
