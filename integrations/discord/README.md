# Optional Discord publisher

Posts each new news sweep to one Discord channel. It reads the news API (GET
only), formats the sweep's cards, and posts them with a bot. It never starts a
sweep, calls a model, or changes news settings. The core app does not import
this directory.

Requirements: Python 3.11+ (standard library only), Linux or macOS, the scoped
**read** token from the [bridge](../../docs/BRIDGE.md), and a Discord bot with
View Channel and Send Messages in the target channel.

## How it works

Each run:

1. Lists sweeps newer than the last one posted, oldest first. It stops at the
   first sweep still queued or running, so an unfinished sweep is never skipped.
2. Collects those sweeps' cards from the feed. The feed shows one card per story,
   its latest development, so a story that developed again before the post
   appears once. Stories the news agent judged duplicates never become cards.
3. Posts one dated header with a link to the UI, then the cards sorted by Facts,
   then Signal. Each card shows source, title, published time (collection time
   when unknown), its top Hype/Facts/Signal category with the three scores, and
   its excerpt. Text is escaped, mentions are disabled, and long sweeps split
   across messages under Discord's size limit.
4. Saves the sweep's ID to `state_dir/last-sweep.json` after its messages post.

The first run only records the latest finished sweep and posts nothing, so
existing history is not dumped into the channel. Finished sweeps without cards
(failed, no news) just advance the saved ID.

**Duplicates:** if the process dies after posting a sweep but before saving its
ID, the next run posts that sweep again. Discord rate limits (HTTP 429) are
retried, since Discord rejected those messages; any other error stops the run,
and the next run starts from the last saved sweep.

## Setup

Keep configuration, the token and state outside the checkout:

```sh
install -d -m 700 "$HOME/.config/news-discord"
cp integrations/discord/client.example.json "$HOME/.config/news-discord/client.json"
chmod 600 "$HOME/.config/news-discord/client.json"
```

| Setting | Purpose |
| --- | --- |
| `base_url` | News API origin (the bridge), without a path |
| `token_file` | File holding only the read token, mode `600` |
| `state_dir` | Private directory for `last-sweep.json` and the run lock |
| `target` | `discord:` followed by the channel ID |
| `timezone` | IANA timezone for dates and times (default `Asia/Taipei`) |
| `news_url` | Public UI link shown once per sweep |

`token_file` and `state_dir` are relative to the JSON file unless absolute.

**Bot token:** when Hermes is importable, the publisher reads `DISCORD_BOT_TOKEN`
from the active Hermes profile (`agent.secret_scope`). Without Hermes it reads the
`DISCORD_BOT_TOKEN` environment variable. It never writes the token anywhere.

## Running

```sh
CONFIG="$HOME/.config/news-discord/client.json"
python3 integrations/discord/publisher.py --config "$CONFIG" preview  # what the next run posts; changes nothing
sh integrations/discord/run-publisher.sh "$CONFIG"                   # post (same as: publisher.py --config "$CONFIG" run)
```

`run` prints its JSON result to stderr and nothing to stdout, so a script-only
scheduler has nothing to forward as an extra message. A second run while one is
in progress exits immediately with `{"status": "busy"}`.

Schedule it after your sweeps, for example sweeps at `0 6,18 * * *` and the
publisher at `0 7 * * *`, both in `Asia/Taipei`. With system cron:

```cron
CRON_TZ=Asia/Taipei
0 7 * * * /bin/sh /path/to/checkout/integrations/discord/run-publisher.sh /path/to/client.json
```

With Hermes cron, register a script-only job (`no_agent=true`) whose wrapper
`exec`s `run-publisher.sh` with absolute paths, so no model runs and nothing is
delivered twice.

**To re-post or skip:** edit `last-sweep.json` (`{"last_sweep_id": N}`); the next
run posts every finished sweep after `N`. Delete it to start over from the latest
sweep.

## Upgrading from the receipt-gated version

The earlier publisher kept a SQLite ledger, outboxes and receipt journals. This
version uses none of them. Delete the old files in `state_dir`
(`publisher.sqlite3`, `*.receipt.json`, `sender.lock`) and keep `client.json`
as it is. `run-publisher.sh` takes the same argument, so a scheduled job needs no
change. The first run records the latest sweep; set `last_sweep_id` lower first
if you want recent sweeps posted.

## Tests

```sh
python3 -m unittest discover -s integrations/discord/tests -v
```

Offline: an in-memory news API, a recording Discord double, synthetic tokens and
temporary state. Also run by `npm run test:deploy` and `just test deploy`.
