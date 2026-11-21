---
name: pm-upgrade
description: Update this install to a newer core release. Load when asked to update, upgrade or take a release (for example "update to 1.4.0"), when Settings > Updates reports a conflict or failed checks, or when npm run upgrade exits with a non-zero code.
---

# Upgrade to a new release

Releases are `vX.Y.Z` tags on `ciaranmci27/valiance-media-agentic-project-management`. The upgrade merges the tag into this repo. It never pushes.

## Steps

1. **Start clean.** `git status` shows nothing to commit. Commit or set aside any work first.
2. **Read every release you will take.** The upgrade jumps to the newest release, which can be several versions ahead. Find the target and read its changelog:
   ```bash
   git fetch upstream --tags              # first time: git remote add upstream https://github.com/ciaranmci27/valiance-media-agentic-project-management.git
   git tag --list 'v*' --sort=-v:refname | head -1
   git show v<target>:CHANGELOG.md
   ```
   Read every section above the installed version (`version` in `package.json`) up to the target. List all their `### Breaking` and `### Database` items.
3. **Merge:**
   ```bash
   npm run upgrade                        # the newest release above package.json's version
   npm run upgrade -- --to v1.4.0         # a specific release
   npm run upgrade -- --branch update/v1.4.0   # on a new branch, for a pull request
   ```
   It adds the `upstream` remote if missing, fetches tags, merges, merges `package.json` and `vercel.json` as JSON (your dependencies, scripts and crons stay), regenerates the lockfile, then runs `npm install`, `npx tsc --noEmit`, `npm run check:core` and `npm run test:core`.
4. **Act on the exit code:**

| Exit | Do |
|---|---|
| 0 | Go to step 5. |
| 1 | Fix what the message says (uncommitted changes, `upstream` pointing elsewhere, a merge already open) and run it again. |
| 2 | Conflict. Nothing changed. Go to **Resolve a conflict**. |
| 3 | No shared history. Follow the printed steps; tell the owner, because it means re-creating the repo from the public one. |
| 4 | Merged, a check failed. The merge commit stays. Read the failing check's output, fix it in client-owned paths, commit. |

5. **Do every `### Breaking` item** from step 2, oldest release first.
6. **Migrate the database** if the summary lists new migrations:
   ```bash
   npm run db:migrate -- --dry-run
   npm run db:migrate
   ```
   Skip this where production deploys apply database updates on their own (Settings > Updates says "automatic": the host has `SUPABASE_DB_URL` and an Owner has not turned it off); say so in the report, and check that page lists nothing pending after the deploy.
7. **Push** (or open the pull request for the branch) when the owner's ship rules allow.

## Resolve a conflict (exit 2)

A conflict means this install changed a core file that the release also changed. For each listed file:

1. See what the install changed: `git diff v<current version> HEAD -- <file>` (the current version is `version` in `package.json`).
2. Rebuild that change in a client-owned path (load `pm-add-custom-feature` or `pm-add-custom-table`).
3. Restore the core file: `git checkout v<current version> -- <file>`.
4. Commit, run `npm run check:core` (it must pass), then `npm run upgrade` again.

If a change cannot move because no plug-in point fits:

1. Write a proposal (load `pm-propose-core-change`).
2. Ask the owner before carrying the core edit. With a yes, merge by hand: `git merge --no-ff v<target>`, resolve each conflicted file (the guard allows core edits while the merge is open), keep both sides' entries in `package.json`, then `git commit`, `npm install`, and run the checks below.
3. `check:core` keeps listing that file until the release with the proposal ships; say so in the report.

## Check

```bash
npx tsc --noEmit
npx eslint src/custom
npm run check:core
npm run test:core
npm run db:migrate -- --status
```

Report: the version now installed, migrations applied, anything under Breaking you did, and any core file still carried.
