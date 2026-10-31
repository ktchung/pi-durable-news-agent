const role = process.argv[2];
const url = role === 'api'
  ? `http://127.0.0.1:${process.env.DNA_PORT ?? 4850}/healthz`
  : role === 'hub' ? `http://127.0.0.1:${process.env.DNA_HUB_PORT ?? 4851}/hub/healthz` : null;
if (!url) process.exit(64);
try {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  const body = await response.json();
  if (!response.ok || body.ok !== true) process.exit(1);
} catch {
  process.exit(1);
}
