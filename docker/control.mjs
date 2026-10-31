// Run with `docker compose exec -T api node /opt/dna-container/control.mjs ...`.
// Credentials are read inside the container, never put in shell arguments.
import { randomUUID } from 'node:crypto';
const [command = 'info', ...args] = process.argv.slice(2);
const actions = {
  info: ['GET', '/v1/info'],
  schedule: ['GET', '/v1/schedule'],
  sources: ['GET', '/v1/sources'],
  keywords: ['GET', '/v1/keywords'],
  usage: ['GET', '/v1/usage'],
  sweeps: ['GET', '/v1/sweeps?limit=5'],
  pause: ['PATCH', '/v1/schedule', { cronExpression: null }],
};
let action = actions[command];
let token = process.env.DNA_CLIENT_TOKEN;
if (command === 'set-cron' && (args.length === 1 || args.length === 2)) {
  action = ['PATCH', '/v1/schedule', {
    cronExpression: args[0],
    ...(args[1] !== undefined ? { timezone: args[1] } : {}),
  }];
} else if (command === 'sweep' && args.length === 1 && args[0] === '--allow-spend') {
  action = ['POST', '/v1/workflows/news-sweep', {
    requestId: `manual:${randomUUID()}`, trigger: 'manual', scheduled: false, cards: 1,
  }];
  token = process.env.DNA_CRON_TOKEN;
} else if (args.length || command === 'sweep') action = undefined;
if (!action || !token) {
  console.error('Usage: control.mjs info|schedule|sources|keywords|usage|sweeps|pause | set-cron "<five-field expression>" [IANA-timezone] | sweep --allow-spend');
  process.exit(64);
}
const [method, path, body] = action;
try {
  const response = await fetch(`http://127.0.0.1:${process.env.DNA_PORT ?? 4850}${path}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    console.error(`Control request failed (HTTP ${response.status}); inspect private application logs`);
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
} catch {
  // A lost POST response is ambiguous: never retry a paid sweep automatically.
  console.error('Control request did not complete. Inspect sweeps before retrying a mutation.');
  process.exit(1);
}
