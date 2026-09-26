# Pi Web working instructions

## Working agreement

- Follow the user's objective and existing authorization. Choose tools, planning,
  delegation and verification in proportion to the change; no mandatory tGD
  phases, Jev run, extra approval ceremony or repeated passing checks.
- Preserve unrelated edits, private data and credentials. Explicit budgets and
  read-only requests remain binding. Never claim unverified completion.
- Read only the relevant sections of [development reference](docs/DEVELOPMENT.md).
  Architecture notes are reference material, not a checklist for every task.

## Development

- `npm run dev` starts on port 30141.
- Typecheck: `node_modules/.bin/tsc --noEmit`; lint: `npx eslint .`;
  tests: `npm test`; browser tests: `npm run test:e2e`.
- Use targeted checks while iterating. Runtime changes need relevant regression
  evidence; documentation changes need link/content checks, not a full rebuild.
- Never build or install dependencies over a running checkout. Use a separate
  candidate for E2E and deployment. E2E builds a fixture server on port 30177.
- Playwright is installed separately for E2E: `npm i -D --no-save @playwright/test`.
  See the development reference for browser fixtures and rendering traps.

## Delivery

- CI chooses documentation, normal or compatibility coverage from changed files.
  Matching reviewed source trees reuse successful PR checks; changed merge trees
  require their own validation. See [release policy](docs/RELEASING.md).
- `bash scripts/release.sh` checks the latest remote main in an isolated checkout
  and chooses the next UTC version automatically. `--dispatch` explicitly
  publishes; `--deploy /absolute/plan.json --execute` also deploys.
- Release preparation must not reset/clean the caller's checkout. Preserve source
  identity, immutable tags, shared update locks and rollback capability.
- Resume a failed deployment with the same tag/plan. Verify the actual running
  build and authenticated public hostname before declaring deployment complete.
- Docs/CI-only work normally ends at merge. Do not restart production unless
  deployment is requested. Never invoke `setup.sh` as a shortcut on a live service:
  it replaces source with origin/main and can remove untracked files.

More: [deployment/resume](docs/RELEASE-PIPELINE.md),
[managed recovery](docs/MANAGED-UPDATES.md), [architecture](docs/DEVELOPMENT.md).
