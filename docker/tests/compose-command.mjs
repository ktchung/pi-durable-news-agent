// Locate a Compose CLI for parser-only tests: DNA_TEST_COMPOSE (a standalone binary) if set, otherwise the
// `docker compose` plugin. `config` renders files without contacting a Docker daemon. Undefined means skip.
import { spawnSync } from 'node:child_process';

function resolve() {
  if (process.env.DNA_TEST_COMPOSE) return { command: process.env.DNA_TEST_COMPOSE, prefix: [] };
  const probe = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  return probe.status === 0 ? { command: 'docker', prefix: ['compose'] } : undefined;
}

export const compose = resolve();

export function runCompose(args, env) {
  return spawnSync(compose.command, [...compose.prefix, ...args], { env, encoding: 'utf8' });
}
