---
name: pm-propose-core-change
description: Write a proposal asking Valiance Media to change the core app. Load when a feature cannot be built in src/custom or supabase/migrations/custom, when the guard hook blocks an edit to a core file, when a core bug needs fixing, or when an upgrade conflict cannot be moved into client-owned paths.
---

# Propose a core change

An install never patches core: the next release would overwrite the patch or stop on it. Instead, ask for the change upstream so it ships in a release for every install.

## First, check it really needs core

1. Re-read the plug-in points in `src/custom/README.md` and `src/lib/extensions/types.ts`.
2. Check whether a module switch (Settings > Workspace > Features) or an existing setting already does it.
3. Check whether a `custom` table keyed by a core row's id can hold the data.

If any of these works, build it there instead (`pm-add-custom-feature`, `pm-add-custom-table`).

## Prefer the general fix

Ask for the smallest change that lets every install do this without editing core, in this order:

1. **A setting**: an option an Owner turns on in Settings.
2. **A module**: a part of the app that switches on and off as a whole.
3. **A plug-in point**: a new place `src/custom` can add to (a new list in `defineExtensions`, a new hook into a core screen or API).
4. **A core change** only for a bug, or behaviour every install wants.

## Write it

Give the proposal to the owner, ready to send to Valiance Media as a GitHub issue on `ciaranmci27/valiance-media-agentic-project-management`. Do not post it yourself.

```markdown
## Proposal: <one line on the outcome>

**Kind:** setting | module | plug-in point | bug fix | core change
**Core version:** <version in package.json>

### What we need
<The business need in two or three plain sentences. What a person does, what they see.>

### Why src/custom can't do it
<The plug-in point or setting that is missing, and what was tried.>

### Proposed change
<What core would add: the setting, module or plug-in point, its name and shape. For a plug-in point, a short example of how src/custom would fill it.>

### Files involved
<Core files that would change, from reading the code: path and one line each.>

### Database
<Any core migration it needs, or "none". Core migrations must be additive.>

### Compatibility
<How existing installs keep working without doing anything.>
```

Attach a diff only as an illustration (`git diff` of a throwaway branch), never as a change to merge into this install.

## Meanwhile

1. Build whatever part fits in `src/custom`, behind a module or setting if possible.
2. Note the open proposal under `## Our customizations` in `src/custom/AGENTS.md`.
3. Tell the owner what works now and what waits for the release.
