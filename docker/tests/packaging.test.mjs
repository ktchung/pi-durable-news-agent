import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('Dockerfile declares local locked workspace on Node 24 without fetching source or applying patches', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /ARG NODE_IMAGE=node:24-bookworm-slim/);
  assert.match(dockerfile, /COPY \. \./);
  assert.match(dockerfile, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(dockerfile, /npm run build --workspace=apps\/dna-client-browser/);
  assert.doesNotMatch(dockerfile, /git (fetch|clone|apply)|UPSTREAM_REF|COPY patches|npm install|omit=dev/);
  assert.match(dockerfile, /USER node/);
});

test('build context allowlists source and finally denies env, dependencies and private runtime trees', () => {
  const lines = read('.dockerignore').split('\n').filter(line => line && !line.startsWith('#'));
  assert.equal(lines[0], '**');
  for (const pattern of ['!package.json', '!package-lock.json', '!apps/', '!apps/**', '!shared-app-configuration/**', '!just/**', '!docker/*.mjs', '!docker/entrypoint.sh'])
    assert.ok(lines.includes(pattern), pattern);
  const lastAllow = lines.reduce((last, line, index) => line.startsWith('!') ? index : last, -1);
  for (const pattern of ['**/.git/**', '**/.env', '**/.env.*', '**/*.env', '**/node_modules/**', '**/auth/**', '**/data/**', '**/logs/**', '**/gluetun/**', '**/integrations/**', '**/state/**', '**/.hermes/**'])
    assert.ok(lines.indexOf(pattern) > lastAllow, pattern);
  assert.ok(!lines.includes('!patches/**'));
  assert.ok(!lines.includes('!integrations/**'));
});
