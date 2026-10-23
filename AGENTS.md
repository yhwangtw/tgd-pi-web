# Pi Web working instructions

## Working agreement

- Follow the user's objective and existing authorization. Choose tools, planning,
  delegation and verification in proportion to the change; no mandatory tGD
  phases, Jev run, extra approval ceremony or repeated passing checks.
- Preserve unrelated edits, private data and credentials. Explicit budgets and
  read-only requests remain binding. Never claim unverified completion.
- Read only the relevant sections of [development reference](docs/DEVELOPMENT.md).
  Architecture notes are reference material, not a checklist for every task.

## Model delegation and ownership

- The lead agent owns product judgment within the user's objective, task
  decomposition, integration and final acceptance across this repository.
  Delegate execution while retaining responsibility for the delivered result.
- Prefer OpenCode Go 2 Muse 1.3
  (`opencode-go-2/muse-spark-1.3-contributor`) and WorkBuddy DeepSeek v4.1 Flash
  (`workbuddy-ai/deepseek-v4.1-flash`) through available authorized integrations.
  These are priorities, not hard requirements; use other available models or
  handle the work directly when fit, availability or verified quality warrants it.
- Delegate bounded work when it adds value; handle small tasks directly and
  parallelize independent tasks when worthwhile. Choose for quality and total
  cost, including coordination and retries, rather than token count alone.
- Give each delegate a concrete task, relevant source and dependencies, scope
  boundaries and acceptance criteria. Request concise findings or patches;
  preserve governing rules and context instead of sending the whole conversation
  or trimming away dependencies that affect correctness.
- The lead agent verifies evidence and reviews changes before integration,
  using checks proportional to risk. A model response or NO_FINDINGS is not proof
  of correctness; incomplete output and unsupported hypotheses are not accepted.
  Retry only with a concrete adjustment; take over or change models when retries
  stop adding value.
- When reporting savings, include failed attempts and retries, distinguish
  delegate usage from coordinator usage, and state any unmeasured overhead.
  Delegation does not expand the user's authorization or existing budgets.


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
- After a successful deployment and public verification, keep the current build
  plus one recoverable previous build. Preserve failed/unverified attempts and
  manual backups; cleanup failure must not restart or roll back a healthy release.
- Resume a failed deployment with the same tag/plan. Verify the actual running
  build and authenticated public hostname before declaring deployment complete.
- Docs/CI-only work normally ends at merge. Do not restart production unless
  deployment is requested. Never invoke `setup.sh` as a shortcut on a live service:
  it replaces source with origin/main and can remove untracked files.

More: [deployment/resume](docs/RELEASE-PIPELINE.md),
[managed recovery](docs/MANAGED-UPDATES.md), [architecture](docs/DEVELOPMENT.md).
