# Docker / Gluetun deployment

This package runs the checked-out repository, not an independently fetched upstream revision. It requires the Codex authentication, provider-default and cron-scheduler source changes in the same checkout. Keep the repository-root `package.json`, `package-lock.json`, `apps/`, `shared-app-configuration/` and `just/` layout intact. No legacy patch directory is used.

## Boundaries and defaults

- API, token-holding browser hub, optional ticker and on-demand auth helper share Gluetun's network namespace. Gluetun uses the private Compose project network only.
- Only hub port 4851 is published, at `127.0.0.1:4851`. API port 4850 is not published. There is no shared external network in the base deployment.
- The hub deliberately has no additional app login. Anyone able to reach its HTTP endpoint effectively has its client capability. Use a trusted host reverse proxy plus an independent access policy; private DNS alone is not authorization. `news.example.test` is an editable example, not a working domain. Preserve external Host/Origin headers; do not rewrite Origin to bypass CSRF checks.
- API alone receives provider keys and durable data. API and the auth helper alone receive the dedicated private OAuth store. Hub gets only the client token; ticker gets only the distinct cron token. No whole-file `env_file` injection is used.
- Codex is the default main/research provider. Login belongs to this app, not to Hermes. TypeSafe has a separate key for Jev; there is no implicit OpenRouter fallback. Subscription quota is not unlimited, and zero reported USD does not measure quota consumption.
- Timezone defaults to `Asia/Taipei`; explicit `TZ` and `DNA_SWEEP_TIMEZONE` overrides are preserved. The source/Compose sweep seed remains `0 */8 * * *`. The example env shows this owner's editable `0 6,18 * * *` seed. Persisted UI schedule settings win over later seed changes.
- Automation is off: the scheduler profile is absent and `DNA_AUTOMATION_ENABLED=false`. Enabling a profile alone is insufficient. Disabling the profile does not stop an already-running ticker; it also does not cancel manual workflows or durable work already in progress.
- Optional paid search/image keys remain blank. Query/source/card limits are not a hard provider-spend cap.

## First installation (operator actions, not performed by preparing this package)

Requirements: Docker Engine with Compose v2 or newer, a working `/dev/net/tun`, outbound build access, Python 3 for directory preparation, and a reviewed checkout containing all source changes. Use a dedicated checkout for runtime files; do not overwrite an existing installation with an overlay copy. The repository's `.gitignore` already excludes local credentials and runtime state; it does not replace a separate private backup.

Run from that checkout as the intended deployment user:

```sh
python3 docker/prepare.py
# Generates distinct local client/cron tokens without printing them.
# Existing private .env bytes and state are preserved on repeat runs.
# Edit .env locally: VPN credentials, TYPESAFE_API_KEY and your allowed hub host.
# Keep .env mode 600 and auth/ mode 700. Do not paste their contents into chat.
docker compose config --quiet
docker compose build api
# Build/pull traffic occurs outside the runtime VPN namespace.
docker compose up -d --no-deps --wait gluetun
docker compose --profile auth run --rm --no-deps auth auth-login
docker compose --profile auth run --rm --no-deps auth auth-status
docker compose up -d --wait api hub
docker compose exec -T api node /opt/dna-container/control.mjs info
docker compose exec -T api node /opt/dna-container/control.mjs schedule
```

`docker/prepare.py` creates only dedicated auth/data/log/Gluetun directories and a new private env file. It refuses symlinked directories and unsafe existing auth/env permissions. It sets generated PUID/PGID to the invoking user; preexisting configuration is never repaired or replaced silently. Ensure these directories are writable by the configured PUID/PGID. The image otherwise runs as the unprivileged `node` user on a read-only root filesystem.

For managed WireGuard providers such as Surfshark, leave manual endpoint fields blank and endpoint port 0; use the provider's own tunnel address/private key and selection filters. For a custom peer, supply its actual endpoint IP, public key and port. Avoid broad `FIREWALL_OUTBOUND_SUBNETS` exemptions and never set `0.0.0.0/0`.

Visit `http://127.0.0.1:4851` on the host, or use your separately secured host reverse proxy. A bridge-networked proxy cannot reach the host's loopback through its own `127.0.0.1`; resolve that topology separately without widening the unauthenticated hub to the LAN. No nginx relay override is included.

## Manual operation and opt-in scheduling

Read-only inspection and schedule writes keep credentials inside the API container:

```sh
docker compose exec -T api node /opt/dna-container/control.mjs schedule
docker compose exec -T api node /opt/dna-container/control.mjs set-cron '0 6,18 * * *' Asia/Taipei
docker compose exec -T api node /opt/dna-container/control.mjs schedule
# This explicit command may spend provider quota/money; obtain approval first:
docker compose exec -T api node /opt/dna-container/control.mjs sweep --allow-spend
```

After approval to automate, set `DNA_AUTOMATION_ENABLED=true` privately, then run `docker compose --profile scheduler up -d ticker`. The ticker starts at the next absolute minute, reuses the source cron client's retry/idempotency behavior, never overlaps child ticks and forwards termination. It is transport; the API applies the persisted sweep cron and timezone. Confirm recent scheduler heartbeat and actual workflow history, not only a displayed next scheduled time.

To pause, stop the ticker with `docker compose --profile scheduler stop ticker`, set the env opt-in back to false, and run `control.mjs pause` followed by `control.mjs schedule`. Review already-running durable work separately. On a lost mutation response, inspect current schedule/sweeps rather than blindly retrying a paid workflow.

## Updating and recovery

Back up private state offline before an operator-approved upgrade, preserve `.env`/auth/data/logs/Gluetun directories, update source, rebuild the image and recreate affected services. Replacing Gluetun changes the namespace used by all core consumers, so coordinate their recreation too. An image rebuild alone changes no running service. Auth logout removes this app's local grant; it is not a claim of server-side session revocation. A backup copy is not a tested restore.

## Offline verification

With Node 24. Compose tests use `docker compose` (no daemon needed), or a standalone binary set in `DNA_TEST_COMPOSE`, and are skipped when neither exists:

```sh
node --test docker/tests/*.test.mjs
# Separate installed + built fixture source; never point this at production data.
DNA_TEST_SOURCE=/path/to/fixture-checkout PYTHONDONTWRITEBYTECODE=1 \
  python3 docker/tests/smoke.py --node-dir /path/to/node24/bin --ticker
```

Use a writable disposable `TMPDIR` for tests. Compose tests pass `--env-file /dev/null` and an allowlisted environment, so they do not read deployment env files. Native smoke runs the real API/hub/ticker entrypoints with faux inference, fixture Jev/search, private temporary tokens/state and no provider keys. It checks authentication, Host/Origin guarding, static UI, helpers, workflow completion, idempotent replay, restart persistence and a real minute-boundary ticker.

Parser, static packaging assertions and native-process tests are **not** a Docker image build, container boot, network-isolation proof, VPN/DNS/kill-switch test, live subscription test or backup-restore test. Before enabling paid operation, the operator must verify those deployment-specific properties and read back the exact running targets. Do not export raw rendered Compose environments or private logs.
