# Publish, deploy and resume from one entrypoint

The existing `--dispatch` mode still publishes source only. Operators with a
configured [staged deployment adapter](./MANAGED-UPDATES.md) can opt into the
whole pipeline through the same entrypoint:

```bash
# Read-only: validate configuration and the exact main CI evidence.
bash scripts/release.sh vYYYY.MM.DD --deploy /absolute/operator/release-plan.json

# Publish, wait for publication, prepare the exact tag, stage, switch and verify.
bash scripts/release.sh vYYYY.MM.DD --deploy /absolute/operator/release-plan.json --execute
```

The tag is optional: the helper selects the next UTC date/sequence and prepares
remote main in an isolated checkout, preserving the caller's local work. If the
same plan has one unfinished receipt, omitting the tag resumes it automatically;
multiple unfinished receipts require an explicit tag. **Repeat the same tag and
plan to resume**, including on a later UTC day. A new request still requires
verified CI. Completed receipts remain idempotent when their tag is explicit.
Resuming validates saved source/plan identities and reads current CI evidence;
it does not require resetting the original checkout to the version commit or
rerunning tests. These commands do not merge PRs or install service adapters.

## Operator plan

Keep the plan and adapter outside application source, owned by the operator.
The executable must already exist; the pipeline does not invent service names
or stop/start commands. Use a dedicated state directory with mode `0700`.
**`stateDir` must be the same directory used by the service's managed Update
Center**, normally `<agent-dir>/updates/operations`, or the configured
`PIWEB_UPDATE_OPERATION_DIR`. Every updater of one service must share this
directory. The existing persistent operation lock coordinates browser and CLI
updates; the Update Center can display their operation records.

```json
{
  "stateDir": "/absolute/private-agent/updates/operations",
  "stageRoot": "/absolute/private-candidates",
  "liveDir": "/absolute/fixed-service-checkout",
  "stageIdentityUrl": "http://127.0.0.1:30178/api/runtime/identity",
  "liveIdentityUrl": "http://127.0.0.1:30141/api/runtime/identity",
  "publicOrigin": "https://pi.example.com",
  "commands": {
    "build": ["/absolute/operator/pi-web-deploy", "build-candidate"],
    "stageStart": ["/absolute/operator/pi-web-deploy", "start-candidate"],
    "stageStop": ["/absolute/operator/pi-web-deploy", "stop-candidate"],
    "stop": ["/absolute/operator/pi-web-deploy", "stop-live"],
    "switch": ["/absolute/operator/pi-web-deploy", "switch-to-candidate"],
    "start": ["/absolute/operator/pi-web-deploy", "start-live"],
    "rollback": ["/absolute/operator/pi-web-deploy", "restore-previous-release"]
  }
}
```

The seven commands implement the existing staged-v1 contract, including a
recoverable previous build and verification after rollback. The candidate is
created as `stageRoot/<tag>` with a clean Git checkout of the verified tag.
State, candidates and live source must be separate, non-nested directories.
Live commands receive the existing `PIWEB_STAGED_SOURCE_DIR` and
`PIWEB_LIVE_SOURCE_DIR` variables. All commands receive `PIWEB_DEPLOY_PHASE`.
Candidate commands run in the candidate cwd with the fixture environment and isolated agent data;
candidate `.env` runtime files are rejected. Never copy live data or secrets
into the candidate. No provider/model request is needed for health checks.

For an authenticated local identity endpoint, supply the existing ephemeral
`PIWEB_UPDATE_HEALTH_COOKIE`. For the public hostname, supply request headers
in `PIWEB_RELEASE_PUBLIC_HEADERS_JSON` through the operator's private
environment (for example, a valid Access service credential plus any required
application session cookie). Do not put credentials in the plan, repository,
arguments or logs. Redirects to login are failures, not successful checks.

## What is recorded and reused

The private `<stateDir>/<tag>.json` receipt pins the repository, source SHA,
CI source, configuration hash, published tag SHA, build fingerprint and
deployment/public-check progress. Writes are atomic and files use mode `0600`.
It never stores cookies, provider credentials or session-list content.

- Publication intent is saved **before** dispatch. If the connection disappears,
  resume finds the matching canonical workflow run; it never sends the same
  request automatically again. The default wait is up to 15 minutes. Failed
  runs stop the pipeline; fix and rerun that release workflow, then resume.
- A GitHub Release must be published and the matching workflow must succeed.
  Its annotated tag must contain the requested source, allowing only the
  workflow's version-only commit. An unrelated or moved tag is refused.
- A successful isolated build is reused only while its source, executable build
  files, installed dependency bytes, adapter files, Node/platform, plan and
  allowlisted environment still match. Next's mutable cache is excluded.
  Every cutover still starts a fresh isolated candidate and checks its identity.
- A verified rollback may be retried without publishing again. If the live
  service changed after that failure, the pipeline stops for inspection.
- After a successful deployment, public-check failure resumes with live identity
  readback and public checks only. It does not rebuild or restart the service.
- Success requires the exact public origin to report the same running build/PID
  and a valid authenticated session-list response. This is a small HTTP smoke
  check; the PR's browser suite remains the interaction test evidence.

Changing a plan or tag cannot silently repurpose a saved operation. A newer CI
failure also blocks resume. Completed operations can be rerun to recheck public
availability; no publication or deployment is repeated.

## Interrupted or uncertain operations

Normal errors release the operation lock after saving progress. A process killed
during execution leaves the existing managed-update lock in place. An uncertain
cutover or failed rollback retains it with `requiresRecovery: true`. These cases
are **not** automatically retried based on age or a dead parent PID: helpers may
still be running. Follow [operator recovery](./MANAGED-UPDATES.md#failure-and-recovery)
to inspect all helpers, the actual live version and the rollback build before
repairing the specific operation record/lock. Never delete the whole state
directory or clear unrelated locks to force a release.

If publication intent was saved but GitHub never accepted the request, inspect
the matching workflow/tag first. The operator may submit that exact tag/source
through the canonical release workflow, then resume the existing receipt. This
explicit recovery avoids guessing whether a lost response already published.

If the workflow already created the version commit/tag but failed before
publication, dispatch the canonical workflow for that same tag with
`expected_sha` set to the **tag commit**, as described in the release guide.
Rerunning inputs pinned to the pre-version source can correctly fail the SHA
gate. The pipeline accepts a successful recovery dispatch from a later main
only after verifying that the immutable tag still derives from its originally
pinned source by an actual version-only change.
