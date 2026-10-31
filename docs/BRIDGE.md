# Optional scoped bridge

Apply this overlay after the core Docker overlay. It replaces the Dockerfile, entrypoint, preflight and healthcheck with final versions that add the bridge role, and adds the bridge source, tests and Compose override. Rebuild the **same custom app image** before starting the extra `hermes-bridge` service. No inline application script or separate nginx relay is needed.

## Access and isolation

The bridge joins the private project network and one existing external Docker network. Gluetun, API, hub, ticker and auth remain private; the hub is still published only on host loopback. Opening Gluetun input port 4850 in this override permits the bridge's private-network API connection, not a host API port mapping. The bridge has no host port mapping, Docker socket, provider keys, cron token, OAuth directory, durable app data or logs mount. It receives the backend client token plus two distinct file-backed capabilities:

| Credential | Permitted operations |
| --- | --- |
| Read token | `GET /v1/schedule`, `/v1/sweeps`, `/v1/sweeps/:id`, `/v1/feed`, `/v1/cards/:id` |
| Admin token | The same reads, plus `PATCH /v1/schedule` containing `cronExpression` and optionally `timezone` |

The read token cannot change schedules. Neither capability can invoke chat, settings, arbitrary upstream URLs or a sweep endpoint. Schedule administration can nevertheless **enable future paid work when the ticker is running**, so treat admin-token custody and schedule changes as consequential authorization. Keep the admin token out of read-only integrations.

List reads permit only positive integer `limit` (at most 1000) and `before` parameters where supported; duplicates and unrelated parameters fail. Paths, methods and schedule body fields are allowlisted. The API performs authoritative cron/timezone validation. Cookies and Origin headers are rejected; this is not a browser UI. The unauthenticated `/healthz` checks only the local bridge process, not upstream access, VPN state or provider health. Upstream redirects are not followed. Credentials are not returned intentionally, and exact credential strings in JSON responses are redacted as defense in depth.

## Operator setup

From the reviewed repository root, copy `.env.bridge.example` to a new private `.env.bridge` (mode 600), then edit it. It contains paths/settings, not tokens. Do not overwrite an existing private configuration.

- `DNA_BRIDGE_READ_TOKEN_FILE` / `DNA_BRIDGE_ADMIN_TOKEN_FILE`: host paths to private regular token files, not the token values. Paths may be absolute or relative to the Compose project directory. They default to `./bridge-secrets/read-token` and `./bridge-secrets/admin-token`. Bind creation is disabled, so files must exist before startup.
- `DNA_BRIDGE_NETWORK`: name of an **already existing** external Docker network. Default `shared-services` is an editable example; no external network is needed by the core package.
- `DNA_BRIDGE_ALIAS`: bridge alias on that external network (default `news-control`); the caller's URL is `http://news-control:4852` with that default.
- `DNA_BRIDGE_PRIVATE_ALIAS`: private Gluetun/API alias (default `news-private-api`). If changed, also change `DNA_BRIDGE_UPSTREAM` (default `http://news-private-api:4850`). Upstream must be an HTTP(S) origin without credentials, a path, query or fragment. Keep it directed at the private API, never the token-holding hub.

If using the default token directory, generate two local secrets without printing them. Run as the same user configured by PUID/PGID. This block refuses an existing token rather than rotating silently:

```sh
python3 - <<'PY'
import os, secrets, stat
from pathlib import Path
root = Path('bridge-secrets')
if root.is_symlink():
    raise SystemExit('Refusing symlinked token directory')
root.mkdir(mode=0o700, exist_ok=True)
if root.stat().st_uid != os.getuid() or stat.S_IMODE(root.stat().st_mode) != 0o700:
    raise SystemExit('Token directory must belong to this user and have mode 700')
paths = [root / 'read-token', root / 'admin-token']
if any(p.exists() or p.is_symlink() for p in paths):
    raise SystemExit('Refusing to overwrite existing token files')
for path in paths:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        out.write(secrets.token_urlsafe(32) + '\n')
PY
```

Keep all three credentials different and at least 32 characters. Store the read token only in the authorized caller's private credential store; grant admin separately only when needed. Do not share a whole Hermes data directory or put secrets in command arguments. Runtime file targets are `/run/news-read.token` and `/run/news-admin.token`; the module also supports explicit `DNA_BRIDGE_READ_TOKEN_PATH` / `DNA_BRIDGE_ADMIN_TOKEN_PATH` for native testing, while Compose sets the fixed container paths.

After operator review and authorization:

```sh
docker compose --env-file .env --env-file .env.bridge \
  -f compose.yaml -f compose.hermes-bridge.yaml config --quiet
docker compose --env-file .env --env-file .env.bridge \
  -f compose.yaml -f compose.hermes-bridge.yaml build api
# Coordinate recreation of Gluetun and all running namespace-sharing consumers.
# Initial installation (auth grant already prepared as described in DOCKER.md):
docker compose --env-file .env --env-file .env.bridge \
  -f compose.yaml -f compose.hermes-bridge.yaml up -d --wait gluetun api hub hermes-bridge
```

For an existing deployment, schedule a maintenance window; replacing Gluetun can interrupt every namespace-sharing core service. Recreate any already-running ticker/auth consumer too, without enabling new profiles or automation accidentally. A successful configuration render or image build does not itself update a running container.

Verify from the actual caller network: unauthenticated and backend-token requests fail; the read token succeeds for allowed reads but cannot patch; the admin token can patch only the approved schedule, followed by exact GET readback; hub/chat/sweep routes fail. Keep credential values inside the caller process and report only status/sanitized results. Verify real Docker network membership and VPN fail-closed behavior separately. Removing an override from a command does not stop a bridge that already exists; explicitly stop/remove only that approved service and retire its caller tokens.

## Tests

After applying both overlays to one checkout (Compose tests use `docker compose`, or `DNA_TEST_COMPOSE=/path/to/docker-compose`):

```sh
node --test docker/tests/*.test.mjs
```

When reviewing the two overlays without merging them, set `DNA_TEST_BASE=/path/to/docker-base` for the bridge Compose tests. Wrapper and HTTP tests need a merged temporary copy for shared base helpers. Use Node 24 and a disposable writable `TMPDIR`. All credentials are synthetic, HTTP upstreams are loopback fixtures, Compose interpolation ignores actual env files, and no Docker daemon or live provider is contacted. These checks do not establish a built/booted image, Docker network isolation or live integration readiness.
