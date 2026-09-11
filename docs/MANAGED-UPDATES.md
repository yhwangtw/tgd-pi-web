# Managed updates: staged-v1 contract

The Update Center does not install a launchd/systemd deployment adapter. The
default remains **operator-managed and disabled until configured**. A helper PID
or a changed `package.json` is not evidence that production changed.

## What is protected

- `setup.sh` checks Node/npm, then checks whether its **own canonical checkout**
  is running, before Git fetch/reset/clean, backup, dependency installation, or
  build. It uses `.piweb-runtime/<launcher-pid>.json`, verifies live PIDs and
  their actual cwd, and also detects older Next processes without markers.
  Unreadable live process identity or unsafe marker symlinks stop setup.
- A normal offline setup still skips Git synchronization only, not npm
  networking. The existing private dirty-source backup/confirmation is retained.
- The browser reserves a filesystem-backed operation lock **before** automatic
  backup. Two tabs/processes cannot start two managed actions concurrently.
- A detached supervisor records reserved/running/verifying and terminal results
  outside the checkout. Reopening the Update Center reads those results; a lost
  HTTP response is not treated as permission to retry a consumed confirmation.
- Success requires helper exit zero **and** a healthy new process: newer
  `startedAt`, different PID, exact approved build version and SHA, clean build,
  same canonical service cwd, and unchanged environment/agent directory.

The running identity is compiled into the application, not inferred from the
checkout after an update. `/api/runtime/identity` supplies the running build;
Update Center separately labels the disk source. No credentials or helper argv
are stored in the durable operation results.

## Required operator configuration

| Variable | Contract |
| --- | --- |
| `PIWEB_UPDATE_COMMAND_JSON` | Absolute JSON argv for an operator-owned staged update helper. |
| `PIWEB_RESTART_COMMAND_JSON` | Absolute JSON argv for the exact service restart helper. |
| `PIWEB_ROLLBACK_COMMAND_JSON` | Absolute JSON argv for an operator-owned staged rollback helper. |
| `PIWEB_UPDATE_PROTOCOL` | Must be `staged-v1` for update and rollback. This is an operator declaration, not automatic adapter installation. |
| `PIWEB_UPDATE_HEALTH_URL` | Loopback HTTP(S) URL with exact path `/api/runtime/identity`; no credentials, query, fragment, or redirects. |
| `PIWEB_UPDATE_OPERATION_DIR` | Optional private durable directory **outside source**; defaults to `<agent-dir>/updates/operations`. Every instance managing the same service must share it. |

The helper receives `PIWEB_UPDATE_ACTION`, `PIWEB_UPDATE_TARGET_TAG`,
`PIWEB_UPDATE_BACKUP_ID`, `PIWEB_UPDATE_BACKUP_PATH`,
`PIWEB_UPDATE_OPERATION_ROOT`, and `PIWEB_UPDATE_OPERATION_ID`. Values are passed
as environment variables, never interpolated into a shell command. An Access
Gate cookie for the supervisor's local readback is ephemeral and is not written
to operation files. Do not log the inherited environment.

Managed actions fail closed when the **existing running build** lacks a clean,
exact source identity. Development builds, dirty builds, and current source
archives with no `.git` cannot satisfy this provenance contract. Archives remain
supported for manual stopped-server installation; they are not proof of a
verified managed deployment. Do not fabricate provenance with HTTP fields or
arbitrary environment variables.

Restart also requires an exact clean running target; rollback requires a clean
Git-backed backup with its recorded SHA. Dirty recovery patches/archive backups
remain available for manual operator review, not unverifiable automatic rollback.

## Staging and cutover adapter

`scripts/staged-deployment.mjs` is an orchestrator for explicit operator-owned
argv adapters. It does not create a checkout, choose a launchd label, rewrite
service files, restart an existing service on its own, or provide an implicit
shell. Invoke it from the configured helper with an operator-owned JSON plan.

Plan fields:

```json
{
  "stageDir": "/absolute/separate/candidate-checkout",
  "liveDir": "/absolute/fixed-service-checkout",
  "expected": {
    "version": "2026.09.07",
    "sourceSha": "EXACT_40_OR_64_CHARACTER_LOWERCASE_GIT_SHA"
  },
  "stageIdentityUrl": "http://127.0.0.1:30178/api/runtime/identity",
  "liveIdentityUrl": "http://127.0.0.1:30141/api/runtime/identity",
  "commands": {
    "build": ["/absolute/operator-adapter", "build-candidate"],
    "stageStart": ["/absolute/operator-adapter", "start-candidate"],
    "stageStop": ["/absolute/operator-adapter", "stop-candidate"],
    "stop": ["/absolute/operator-adapter", "stop-live"],
    "switch": ["/absolute/operator-adapter", "switch-to-candidate"],
    "start": ["/absolute/operator-adapter", "start-live"],
    "rollback": ["/absolute/operator-adapter", "restore-previous-release"]
  }
}
```

This example is intentionally non-executable until real paths and SHA are
provided. Stage and live directories must exist, be separate/non-nested after
symlink resolution, and use different loopback health-check ports.

Adapter responsibilities:

1. Prepare an isolated **clean Git candidate** at the approved release SHA
   before invoking the orchestrator. Preserve its `.git` provenance. Never copy
   private agent data, `.env` secrets, or another checkout's `.next` into it.
2. `build` installs/builds only that stopped candidate. `stageStart` starts it
   and returns; `stageStop` must stop only that candidate. Candidate commands
   receive `PIWEB_ENVIRONMENT=fixture` and a newly created empty agent directory;
   Only the fixture launcher's OS/path/locale environment allowlist is passed;
   provider keys, custom secrets, `NODE_OPTIONS`, and live update commands are
   not inherited. Access password, session secret, and live health cookie are
   cleared. `PIWEB_HOST` and `PORT` come from the loopback stage health URL.
   The adapters must propagate these overrides without reloading the live
   environment, and bind the candidate locally.
3. Only after exact candidate identity passes and the stage is confirmed stopped
   may the orchestrator capture the live rollback identity. If a managed
   operation exists, this must still be the process/build approved by that
   operation; a concurrent manual service change aborts cutover.
4. `stop` must stop the exact live service. The process guard checks it again
   before `switch`. `switch` installs the already-built candidate while retaining
   a recoverable previous release; it must never build/reset a running checkout.
   `start` starts the exact service with its original agent-data configuration.
5. A failed switch, start, or identity check triggers stop → rollback → start,
   then verifies the previous version/SHA on a new healthy process. The update is
   still recorded as failed, with `rollbackVerified: true` when recovery passes.
   A rollback verification failure requires operator recovery.

This first adapter contract is **fixed-canonical-cwd**, matching the current
fixed-working-directory launchd/systemd setup. A release-symlink swap that
changes the service's canonical cwd is deliberately rejected. Supporting that
requires a separate reviewed path/identity contract, not removing the cwd check.

The helper publishes its exact approved candidate identity via the private
operation store after staging passes. The supervisor independently verifies the
live HTTP identity after the helper exits; it does not trust helper exit alone.
Health readback is bounded (default 60 attempts); it never calls a model.

## Failure and recovery

- `verification_failed`: helper exited zero, but the intended healthy new
  process/build was not observed. Inspect the live identity and service logs.
- `failed`: helper or supervisor failed. A verified rollback remains a failed
  update, not successful deployment.
- `interrupted`: the supervisor disappeared without a verified result. The lock
  remains held (`requiresRecovery: true`): it could have died between helper
  spawn and PID persistence. A dead recorded PID alone is not safe unlock proof.
  The service-manager adapter must preserve the detached supervisor/helper
  while restarting the service; a manager that kills the entire service family
  needs an external supervisor integration before managed deployment is enabled.
- Missing/corrupt lock records fail closed. There is no automatic destructive
  recovery or browser “force unlock” button. An operator must verify all helper
  and service processes, determine the actual live build and rollback state,
  preserve the result record, and recover only the matching operation lock.
  Reservation/release/recovery use a separate cross-process `.store-mutex`
  directory so a stale release cannot delete a newer lock. A crashed mutex owner
  also requires operator recovery; never remove it based only on elapsed time.
- If stage stop/stop verification fails, live cutover does not run and the
  candidate's isolated agent directory is retained at the reported temporary
  path. Stop that candidate and inspect its state before removing this directory.

The API returns the active operation and newest 20 records; UI shows the newest
five. Records are not automatically deleted. Retention is an operator-owned
maintenance decision after no active/recovery lock references them.

## Acceptance evidence and limits

Fixture tests cover concurrent reservations, durable reload, lost response,
old/wrong/dirty build rejection, orphan/interrupted locks, isolated stage-first
ordering, stage-stop failure, and verified rollback. Setup tests use fake
Git/npm commands and a disposable timer process to prove a running checkout is
rejected before mutation. No fixture starts or modifies the production service.

These tests certify the code contract, **not an installed deployment adapter**.
Production acceptance still requires an operator-reviewed real service adapter,
an approved clean candidate, a verified rollback rehearsal, and explicit
authorization for the actual update/restart.
