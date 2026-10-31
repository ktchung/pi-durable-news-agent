#!/bin/sh
# Script-only scheduler adapter; never initializes or resets a baseline.
set -eu
if [ "$#" -gt 1 ]; then
    printf '%s\n' 'Usage: run-publisher.sh [client.json]' >&2
    exit 64
fi
CONFIG=${1:-${NEWS_DISCORD_CONFIG:-}}
if [ -z "$CONFIG" ]; then
    printf '%s\n' 'Pass client.json or set NEWS_DISCORD_CONFIG.' >&2
    exit 64
fi
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${PYTHON:-python3}" "$SCRIPT_DIR/sender.py" --config "$CONFIG" tick
