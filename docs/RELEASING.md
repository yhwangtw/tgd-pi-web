# Releasing and verifying an update

## One publication path

Merge a reviewed PR, then wait for **CI on the exact merged `main` commit**.
PR checks alone do not prove the resulting merge commit passed. CI must finish
Lint & Typecheck (including design, i18n and capability contracts), Test, Build,
E2E, and Security Audit. Skipped, cancelled, missing or failing jobs block release.

From a clean checkout at the fetched remote `main`:

```bash
bash scripts/release.sh                        # read-only preflight; UTC date
bash scripts/release.sh vYYYY.MM.DD-1           # another release that UTC day
bash scripts/release.sh vYYYY.MM.DD --dispatch  # explicitly request publication
```

Replace `YYYY.MM.DD` with the current UTC date. The helper does not fetch,
reset, build, change versions, create tags or push your local branch. It shows
the repository, full source SHA and CI run before requesting the one canonical
workflow. It refuses a dirty checkout, stale `origin/main`, or local changes
not yet merged to remote `main`. Keep private audit notes outside the release
checkout; never force-add them to make it clean.

The helper requires Node.js, Git and authenticated GitHub CLI access. It derives
the GitHub repository from `origin`, not the current shell's default repository.
Git push credentials and `gh` API credentials are separate; a working push alone
does not prove workflow-dispatch access. Do not print tokens in diagnostic logs.

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
4. The latest matching run and its specific attempt contain all five successful
   jobs. A previously green run cannot excuse a newer failed or pending run.
   If a partial re-run lacks the full job set, re-run **all** CI jobs.

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
