# Releasing and verifying an update

## One publication path

Choose the scope first: documentation-only or CI-only changes normally take
effect on merge and do not require an application version bump or service
restart. Application/runtime changes follow the release/deployment path below.
Changes to setup, authentication, stored data or deployment logic retain their
relevant installation, recovery and behavior checks.

CI chooses coverage from changed files:

- Documentation-only: whitespace/diff checks, without dependency installation.
- Normal runtime changes: lint/typecheck, tests on Node 22.19 Linux and Node 26
  macOS, Linux installation, build, E2E and production dependency audit.
- Dependency, runtime-support, installation or CI changes: all supported Node
  boundaries on Linux/macOS and both installation checks. Manual CI uses this
  complete compatibility profile.

Merge after the selected checks pass. CI on the exact merged `main` verifies
whether the PR's latest successful attempt tested the identical Git tree. If so,
it reuses those checks. If evidence is missing or the merge changed source, it
runs the selected checks on main, including E2E. Publication independently checks
that evidence again; a newer failed/pending attempt cannot reuse an older green
result. Docs-only CI is not runtime release evidence; explicitly releasing such
a commit requires a manual full CI run. Jev is not a prerequisite.

Run from any checkout of this repository, including one with local changes:

```bash
bash scripts/release.sh                        # preflight, next UTC tag
bash scripts/release.sh --dispatch             # automatically chosen tag
bash scripts/release.sh vYYYY.MM.DD --dispatch  # optional explicit tag
```

The helper obtains remote main in a disposable clean checkout and automatically
chooses the next available UTC date/sequence from existing tags. It never resets,
cleans, builds, versions or pushes the caller's checkout. Private/untracked files
remain untouched. It shows the source SHA and verified CI before publication;
remote-main movement stops the request. Temporary preparation is removed on exit.
An explicit tag must be new; recover an existing publication with the workflow
recovery procedure below or its saved deployment receipt.

The helper requires Node.js, Git and authenticated GitHub CLI access. It derives
the GitHub repository from `origin`, not the current shell's default repository.
Git push credentials and `gh` API credentials are separate; a working push alone
does not prove workflow-dispatch access. Do not print tokens in diagnostic logs.

For operators with configured staging/service adapters, the same entrypoint
also supports `--deploy /absolute/plan.json --execute`: publish, wait, prepare
the exact tag, deploy and verify the public hostname with resumable receipts.
Without `--execute` this mode is read-only. See the
[one-entrypoint release/deployment guide](./RELEASE-PIPELINE.md). The
publication-only `--dispatch` behavior and canonical workflow stay unchanged.

The equivalent operator command is:

```bash
gh workflow run release.yml --ref main -f tag=vYYYY.MM.DD -f expected_sha=FULL_REVIEWED_SHA
```

`expected_sha` is the full 40-character SHA reviewed in preflight. Omitting it
uses the `main` checked out by the workflow, but still requires its verified CI.
If `main` moves after preflight, the SHA-bound request stops instead of silently
releasing a different commit. An atomic push also fails if `main` advances during
version preparation. Recheck the new source and CI; do not force-push to retry.

## What the workflow proves

Before any release commit, tag or publication, `release.yml` checks:

1. The calendar tag is valid. New tags use today's UTC date; same-day releases
   use positive numeric sequences. Future dates are rejected.
2. The source/tag is reachable from `origin/main`; all three package version
   fields agree, including `package-lock.json`'s root package.
3. The canonical `.github/workflows/ci.yml` has completed successfully for that
   exact source, in this repository on `main`, not a fork's PR or another workflow.
4. The latest matching attempt passed the four core jobs and E2E, or passed
   `Test` and `Reuse reviewed checks` backed by all those jobs in matching PR CI.
   Missing, failed, skipped or pending selected evidence blocks publication.
5. Borrowed PR evidence belongs to the unique PR merged as that source commit,
   targets this repository's main, and has exactly the same source tree. The
   release gate rechecks the latest attempt rather than trusting the reuse label.

The workflow then changes only version fields, atomically pushes the version
commit plus annotated tag, and creates a GitHub Release with source/CI links.
The version-only commit uses `[skip ci]`; it does not need duplicate application
CI. For recovery or consecutive releases, inherited CI is accepted only after
comparing actual Git changes and parsed package documents: any source, dependency,
file-mode or other package metadata change must have its own CI. A commit message
containing `[skip ci]` is not proof.

This is a **GitHub source release**. There is no npm publication and no automatic
production deployment. Browser screenshots, a successful dispatch response, or
a running local server are not proof that a release/deployment completed.

## Recovery and readback

If a tag exists but Release creation failed, dispatch the same tag on `main`.
For a SHA-bound recovery, use the **tag commit**, not today's main HEAD. Existing
historical tags can be resumed only if their versions, ancestry and CI still
verify. The workflow never moves an existing tag. Recovering an older calendar
release must not replace a newer date or sequence as **Latest**.

If CI is still running, wait for that specific run. If API authorization, rate
limits, missing evidence or failures prevent checking, publication stops. Fix
the actual cause and retry; there is no bypass/force-success flag. A GitHub
Release that already exists is left unchanged, not edited on every retry.

If main did not complete its own runtime checks and matching PR evidence is
unavailable, run **CI → Run workflow → main** once (or
`gh workflow run ci.yml --ref main`). A manual run includes Linux/macOS
installation and E2E; after it passes on the exact source, publication needs no
PR evidence. This also supports historical tags with complete main CI. Full CI
is a recovery path, not an extra step in the normal PR → main → release flow.

After dispatch, verify the actual run and resulting release:

```bash
gh run list --workflow release.yml --branch main --limit 5
gh run view RUN_ID
gh release view vYYYY.MM.DD --json tagName,url,publishedAt,isDraft
```

Use the run corresponding to the requested tag; do not assume the most recent
unrelated run is yours. Confirm the tag commit and all version fields after
fetching it. Check that the release is published, not merely a draft or queued job.

## Installation, updates and rollback are separate

- Stop any Next.js process using the installation directory before dependency
  installation or building. Building over a running `.next/` breaks that server.
- `bash setup.sh` fetches `origin/main`. A clean end-user checkout synchronizes
  automatically. Local commits or non-ignored changes first get a private source
  recovery backup; unattended setup then stops unless `TGD_SETUP_FORCE_SYNC=1`
  explicitly authorizes replacement. Interactive setup asks before replacement.
- Inspect the printed backup location before approving. The backup contains
  source patches, untracked files and (where needed) local commits; it is **not**
  a complete backup of Pi sessions, model credentials, `.env`, or ignored files.
  Back up required runtime data separately with the service stopped, protect the
  backup permissions, and do not upload it to GitHub.
- `TGD_SETUP_OFFLINE=1` skips Git synchronization; it does **not** disable npm
  networking. Use a prepared internal registry/cache for an offline installation.
- `origin/main` may include code merged after the latest release. For an exact
  release, extract its source archive into a new directory; do not overlay an
  old installation. Preserve the current working installation for rollback.
- Managed Update Center actions require operator-configured helper commands.
  They are not supplied as a universal safe updater. See the
  [deployment guide](../deploy/README.md#managed-update-center-actions).
- Validate the candidate separately, switch the named service, then check the
  actual hostname, authentication, listening origin, runtime version and a real
  UI flow. A Cloudflare Access redirect alone proves only the access boundary.
  Rollback must restore the selected source/runtime combination, not clear user
  data or reset unrelated workspaces.

The gate's CI run/job checks use GitHub's [workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs)
and [workflow job attempts API](https://docs.github.com/en/rest/actions/workflow-jobs).
Dispatch uses the documented [GitHub CLI workflow command](https://cli.github.com/manual/gh_workflow_run).
