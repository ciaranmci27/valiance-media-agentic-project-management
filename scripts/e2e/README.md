# End-to-end suite

The app proven end to end as people and agents use it: real HTTP against a running app on the local test stack, through the same doors the screens and agents use. It is not part of `npm run test:core`, because it needs Docker.

## Run it

From the `app` folder, with Docker running:

1. `npm run local:up`: starts the stack and applies any new migrations.
2. `npm run local:seed`: the seeded Owner the suite signs in as. Safe to run again.
3. `npm run test:e2e`: every scenario, about 1 minute after the first compile.

The suite starts its own server for the run (`scripts/local/dev.mjs` on the first free port from 3011) and stops it at the end. Its log is in your temp folder as `pm-e2e-server-<port>.log`.

| Command | What it does |
|---|---|
| `npm run test:e2e -- 2 3` | Only scenarios 2 and 3 (a number, or part of a name) |
| `E2E_BASE_URL=http://localhost:3011 npm run test:e2e` | Reuses a local server you already started with `PORT=3011 PM_E2E=1 npm run local:dev` |

Each step prints one line. A failure prints what was expected, what came back and the answer as evidence. Exit code 0 only when every scenario passed.

## How production stays out

The settings come only from `scripts/local/.env.test.local` (written by `local:up`), and every address is checked to be this machine's. The server is the local stack's own (`dev.mjs` with `guard-env.cjs`: no `.env` file is read, hosted Supabase is refused). With `PM_E2E=1` it also never reaches a chat provider: the suite's test chat connections hold made-up tokens, and a send fails and is recorded as failed.

## Scenarios

| # | File | What it proves |
|---|---|---|
| 1 | `01-hire-agent.ts` | The Owner hires an agent from the Hire screen's route with a project and a key, mints a second key, and the agent reads its own context over MCP (`pm_guide`) and REST |
| 2 | `02-chat-to-done.ts` | A Telegram DM to the company bot (the provider's request simulated with its secret header) reaches the orchestrator, which delegates to its specialist with a run; the specialist claims, runs, asks its orchestrator; the orchestrator asks the person for an approval; the person approves in the app; the event feed (`GET /api/v1/events`, cursor and wait) wakes each agent; both tasks end done. Needs you, the unread badge and the notices are checked at each step |
| 3 | `03-who-can-use.ts` | An agent limited to one member: someone outside it is refused in chat, on assign (task panel and API) and on delegate; ask first makes one approval, the manager approves in the app, the request goes through once, and the repeat needs a new approval |
| 4 | `04-templates-schedules.ts` | A template with key dates runs, a hand-moved task survives a date change, a daily schedule fires through the scheduler route |
| 5 | `05-files.ts` | Signed task-file upload and download; private project files open only through `/api/storage/file` for people on the project; a guest of another project gets 404; portal links list only that project's shared files and refresh with new signatures |
| 6 | `06-keys.ts` | Pause blocks at once, resume restores, replace keeps the old key through its overlap, revoke takes down the keys it replaced and the keys it made over the API |
| 7 | `07-guests.ts` | A guest sees their project, its tasks and its people (no one else's email) and nothing else; cannot make keys, tasks, notices or template runs |
| 8 | `08-browser.ts` | In a real browser, as the seeded Owner: sign in through the login page, answer an agent's question with one tap in the AI home's Needs you, hire a company agent step by step (blank template to "It works, try it"), turn on Ask first on an agent's Access tab, move a task to Trash from its panel and bring it back with Undo. Each flow is checked in the database too. Skipped (and passing) when no browser is found |

## The browser scenario

Scenario 8 drives the system Chrome through `playwright-core` (a dev dependency; no browser is downloaded), headless, at 1440 by 1000.

| Setting | What it does |
|---|---|
| `CHROME_PATH=/path/to/chrome` | Uses that browser. If the file is not there the scenario says so and skips, rather than picking another |
| (unset) | The first of the usual places: Chrome, then Chromium, then Edge (Linux `/usr/bin/google-chrome`, `/usr/bin/chromium` and the like; the macOS and Windows install paths) |
| `PM_E2E_BROWSER=off` | Skips the browser on purpose |

With no browser it prints `skipped: no browser (<why>)` and passes, so the API scenarios still prove everything else. Pages load with the same patience as the API calls (`retry.ts`): a page the dev server answers mid-compile is loaded again, then the scenario waits for the network to go quiet. Selectors are by role and label, as people read the screen. `npm run test:e2e-browser` (in `test:core`) checks the browser finder and the skip without a browser or the stack.

## Data

Each scenario makes its own projects, agents, keys, chat connection and tasks (named `E2E ... <run tag>`) and cleans up after itself, pass or fail. The app never hard-deletes, so cleanup leaves nothing live: projects in Trash, agents suspended with their keys revoked, open questions cancelled, test chat connections switched off and unlinked.

The suite's own people (`e2e-requester`, `e2e-manager`, `e2e-outsider`, `e2e-guest` at acme.test) are invited once through Team > Invite and reused, with a fresh password each run, so the seeded team's Needs you and badges are never touched. The seeded Owner does what only an Owner may.

## Rules for new scenarios

- One file per scenario, exporting `{ name, run(ctx) }`, added to `SCENARIOS` in `run.ts`.
- Go through the doors people and agents use: session routes signed in as a person, `/api/v1` and `/api/mcp` with an agent's key, the browser's own database reads (`person.rest`) where the screen reads that way. Write to the database directly only to set up what has no route (a test chat connection) or to check a result.
- No fixed sleeps: `waitFor` polls with a timeout, and the event feed's own `wait` long-polls.
- Register every thing you make with `ctx.cleanup.add`.
- One `step(...)` line per step, saying what is now true.
- In the browser: `gotoReady` to open a page, role and label selectors (`getByRole`, `getByLabel`), and a database check after each flow; never a fixed sleep or a class name.

## When it fails before a scenario starts

| Message | Do |
|---|---|
| No `scripts/local/.env.test.local` | `npm run local:up`, then `npm run local:seed` |
| The local database is missing migrations | `npm run local:up` |
| The seeded Owner is missing | `npm run local:seed` |
| `server_error: Module not found` | The shared `node_modules` is incomplete: reinstall in the main folder |
