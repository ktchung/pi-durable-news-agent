# Test suites. `live` uses real models; the rest are free. Recipes run in apps/.

set shell := ["zsh", "-cu"]
set positional-arguments
set working-directory := "../../apps"

# List test commands
[default]
default:
    @just --list test

# Types, lint, format check and unit tests
unit:
    npx tsc -p shared/packages/dna-sdk && npx tsc -p shared/packages/jev && npx tsc -p shared/packages/durable-agent
    npx tsc -p dna-server-api && npx tsc -p dna-server-cron && npx tsc -p dna-cli && npx tsc -p dna-client-tui
    npm run check -w dna-client-browser
    npx oxlint dna-* shared
    npx oxfmt -c ../shared-app-configuration/.oxfmtrc.json --check dna-* shared
    NODE_NO_WARNINGS=1 npm test -w @dna/sdk -w @dna/jev -w @dna/durable-agent -w dna-server-api -w dna-server-cron -w dna-cli -w dna-client-tui
    NODE_NO_WARNINGS=1 npx tsx --test dna-client-browser/hub/tests/*.test.ts

# Faux sweep, recovery, scopes, stream
faux:
    NODE_NO_WARNINGS=1 npx tsx --test dna-server-api/tests/sweep-faux.test.ts dna-server-api/tests/recovery.test.ts dna-server-api/tests/auth.test.ts dna-server-api/tests/workflow.test.ts dna-server-api/tests/stream.test.ts dna-server-api/tests/executions.test.ts

# Prompt files and no inline prompts
prompts:
    NODE_NO_WARNINGS=1 npx tsx --test shared/packages/durable-agent/tests/prompts.test.ts

# Docker packaging, Compose (skipped without docker compose), bridge and Discord publisher
deploy:
    cd .. && npm run test:deploy

# Browser suite against a faux API
ui:
    npm run build -w dna-client-browser
    node dna-client-browser/tests/ui-faux.mjs

# Real jev on three fixture items
jev-live:
    JEV_LIVE=1 NODE_NO_WARNINGS=1 npx tsx --test shared/packages/jev/tests/live.test.ts

# Live end to end on one device
live DEVICE *ARGS:
    node shared/tests/live/e2e.mjs "$@"

# README links and images resolve
docs:
    node shared/tests/docs.mjs

# Format every app, package and test
fmt:
    npx oxfmt -c ../shared-app-configuration/.oxfmtrc.json dna-* shared
