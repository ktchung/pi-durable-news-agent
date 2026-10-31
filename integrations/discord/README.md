# Optional Discord publisher

A deterministic, separately deployed integration for publishing completed news
sweeps to one configured Discord channel. The core news application does not
import this directory and does not depend on Hermes or Discord. Installing these
files does not start a service, modify a schedule, run research, or call a model.
No schedule-administration client is included.

## Requirements and installation

- Python 3.11+ with SQLite, `zoneinfo`, and system IANA timezone data.
- A POSIX host (Linux or macOS); the sender uses `fcntl.flock` for process locking.
- The scoped **read-only** news API and a dedicated read token. Use HTTPS across
  untrusted networks; HTTP is suitable only for a trusted local transport.
- A Discord bot with View Channel, Send Messages, and Read Message History in the
  configured channel. Do not use a personal account token or webhook credential.

The standalone code uses only the standard library; no `pip install` is needed.
Run commands below from the repository root. Keep deployment configuration,
secrets, journals, and databases **outside the checkout**:

```sh
python3 -m unittest discover -s integrations/discord/tests -v

install -d -m 700 "$HOME/.config/news-discord"
install -d -m 700 "$HOME/.config/news-discord/secrets"
cp integrations/discord/client.example.json "$HOME/.config/news-discord/client.json"
chmod 600 "$HOME/.config/news-discord/client.json"
```

Edit the copied JSON. Every example value is synthetic; the example channel does
not designate a real destination. Provision the read token separately into the
configured `token_file`, with mode `600` or stricter. Do not paste keys into this
repository, command-line arguments, or JSON settings. `token_file` and `state_dir`
resolve relative to the JSON file, not the current working directory. The state
directory is created privately (mode `700`); existing permissive directories are
rejected. Use a distinct state directory per deployment/target.

| Setting | Purpose |
| --- | --- |
| `base_url` | Scoped news API origin, without an endpoint path, query, or fragment |
| `token_file` | Private file containing only the scoped news read token |
| `state_dir` | Private publisher ledger, lock, and durable receipt journals |
| `target` | `discord:` followed by the intended 17–20 digit channel ID |
| `timezone` | IANA timezone; the public example and default are `Asia/Taipei` |
| `news_url` | Public UI link displayed once per sweep; independent of API origin |

### Discord credential resolution

When Hermes is installed and importable, the sender uses
`agent.secret_scope.build_profile_secret_scope(get_hermes_home())`, then resolves
only `DISCORD_BOT_TOKEN`. Run with the intended active profile environment and
Hermes's Python interpreter/import path. No fixed Hermes installation or profile
path is assumed. A missing/denied credential in an available profile scope fails
closed; it is not replaced by an environment credential.

When the Hermes modules are unavailable, standalone deployments may inject
`DISCORD_BOT_TOKEN` into the process environment using their secret manager. The
sender does not open or parse `.env` files, export a secret mapping, or persist the
bot token. Hermes is an optional installed dependency, not a core news dependency.
The collector, preview, and baseline never resolve a Discord credential.

## Preview and explicit one-time cutover

These commands make only scoped news **GET** requests and never send to Discord:

```sh
CONFIG="$HOME/.config/news-discord/client.json"
python3 integrations/discord/publisher.py --config "$CONFIG" preview-latest
python3 integrations/discord/publisher.py --config "$CONFIG" status
```

Preview returns JSON containing the exact message chunks and card IDs for the
latest completed sweep. It does not create an outbox, baseline, delivery receipt,
or delivered-card row. Opening the publisher can create its empty private state
schema. Local `status`/`show` do not read the API token or access the network.

Before enabling publication, explicitly establish **one** baseline:

```sh
# Skip all currently completed, clean-audit history (not a delivery).
python3 integrations/discord/publisher.py --config "$CONFIG" baseline

# ALTERNATIVE, on a fresh state directory only: leave sweep 42 and newer eligible.
# python3 integrations/discord/publisher.py --config "$CONFIG" baseline --before-sweep-id 42
```

A baseline records validated historical sweep/card IDs as intentionally skipped;
it never claims that those cards were delivered. The cutoff is exclusive and
applies only to completed clean-audit sweeps observed at cutover. A sweep still
running at cutover may become publishable later. A second baseline is refused.
Neither `tick` nor the adapter creates or resets a baseline automatically. Do not
delete the ledger to clear a blocked send: that loses deduplication history and
can cause duplicate publication.

For operator inspection, `prepare` freezes an immutable outbox and `show OUTBOX_ID`
returns it. These do not send or acknowledge anything. The sender can consume a
prepared, never-claimed outbox once; it never claims an already claimed outbox.

## Opt-in publication and scheduler adapter

**The following command can send Discord messages.** Run only after reviewing the
configuration, preview, baseline, and bot permissions:

```sh
sh integrations/discord/run-publisher.sh "$CONFIG"
# Equivalent:
# python3 integrations/discord/sender.py --config "$CONFIG" tick
```

The adapter accepts a config argument or `NEWS_DISCORD_CONFIG`, and optionally
`PYTHON` for a specific installed interpreter. It returns the sender exit status
and leaves stdout empty. Diagnostics are JSON on stderr, not a second delivery
payload. The collector's own `publisher.py tick` only prepares; it never sends.
`sender.py check` performs only bot identity GET and does not prove channel access
or message delivery.

Recommended publisher schedule: **`0 7 * * *`, timezone `Asia/Taipei`**. Keep the
news service's own sweep schedule separate, for example **`0 6,18 * * *`** in the
same timezone. The publisher does not initiate a sweep or manage that schedule.
A morning publication covers all newly eligible sweeps, not only the latest one.
No schedule is installed by this integration. Example system-cron command (replace
the placeholder paths; set the timezone using your cron implementation):

```cron
CRON_TZ=Asia/Taipei
0 7 * * * /bin/sh /path/to/news-agent/integrations/discord/run-publisher.sh /path/to/private/client.json
```

For Hermes cron, install an operator-owned wrapper in the **active profile's**
script directory and register its relative script filename with `no_agent=true`,
the same cron expression, and the explicit timezone. The wrapper should `exec`
this adapter with absolute checkout/config paths and the intended interpreter.
Do not schedule an agent prompt or add scheduler-to-Discord delivery on top of the
sender. Script-only execution avoids model calls and duplicate cron delivery.
Check your installed Hermes cron interface for those fields; no cron state needs
to be edited manually. A successful cron run is **not** a delivery receipt.

## Safety and recovery contract

- News access is GET-only and allowlisted to `/v1/sweeps`, `/v1/feed`, and positive
  numeric `/v1/sweeps/ID` / `/v1/cards/ID` detail endpoints. No redirects or
  environment proxies are followed, and pagination/time/record budgets fail
  closed instead of silently accepting a partial scan.
- All eligible sweeps are enumerated with exact cardinality and membership checks.
  Hidden feed cards are recovered only from exact successful `present_news`
  audit references (`status=done`, `isError=false`), never by probing guessed IDs.
  Missing, changed, foreign, or ambiguous evidence blocks the outbox.
- Normal cards stay whole within 1,800 UTF-16-unit chunks. Oversized excerpts are
  split without truncation; each sweep has one header and one UI link. The format
  is `YYYY-MM-DD News:`, italic news count, the UI link, a separator, and each
  card's source, bold title, publication time, highest HFS category, F/S/H
  percentages, and existing excerpt. Times use configured `Asia/Taipei` by default;
  missing publication times are explicitly marked collected/unavailable.
  Cards sort by Facts descending, Signal descending, then ID ascending. Text is
  escaped and mentions disabled; original excerpts are not translated or rewritten.
- Outbox content/target is frozen and hashed. A transactional one-shot claim is
  committed before sending; durable journal intent precedes each POST. No POST
  is retried, including on rate limits, timeout, or process interruption.
- Each chunk must be read back by exact message ID with the configured channel,
  authenticated bot author, exact content/hash, and no unexpected mentions.
  Only a complete all-chunk receipt advances the delivered ledger atomically.
- A claimed/unknown outcome blocks subsequent sends, including after restart.
  Nonces are a secondary safeguard, not proof of delivery or permission to retry.
  Changing the configured channel cannot retarget a frozen outbox.

After an uncertain send, inspect `status`, `show OUTBOX_ID`, and the matching
private `OUTBOX_ID.receipt.json` in `state_dir`. Do not publish it again. If the
journal contains **every** message ID, this explicit recovery command performs
Discord **GET-only** verification and may acknowledge the existing messages:

```sh
python3 integrations/discord/sender.py --config "$CONFIG" reconcile OUTBOX_ID
```

Reconciliation binds the journal to the immutable outbox and verifies all chunks
again; it never sends missing chunks. If an ID is missing, or channel/author/content
cannot be verified, it leaves the ledger unresolved for manual investigation.
There is intentionally no automatic unlock/resend or baseline-reset command.
The low-level `claim`/`ack`/`failure` collector commands are for a trusted adapter;
never fabricate an ack from a cron status. Protect state as trusted local evidence,
retain it across upgrades, and do not share receipt journals publicly.

## Offline tests

```sh
python3 -m unittest discover -s integrations/discord/tests -v
sh -n integrations/discord/run-publisher.sh
```

Tests use synthetic tokens/configuration, temporary private SQLite/journals,
loopback-only HTTP fixtures, and an in-memory Discord double. Secret-resolution
tests replace the Hermes modules and environment with synthetic values. They do
not import the news application, call a model, contact production APIs/Discord,
read deployment credentials/state, or change cron. Coverage emphasizes cutover,
full pagination and hidden-card recovery, immutable target binding, one-shot
claims, exact all-chunk readback, uncertain outcomes, GET-only reconciliation,
and portable configuration. Actual credentials, permissions, and live delivery
must be verified separately by the deploying operator.
