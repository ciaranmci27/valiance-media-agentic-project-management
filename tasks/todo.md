# Load performance pass, measured on a local production build (2026-10-02)

Same method as admin (see admin/tasks/todo.md, 2026-10-01): `next start` on
:3008 against live data with the owner signed in, Resource Timing for the
network, DOM observers for first content.

The protected app is client-rendered: a 4 KB HTML shell, then AuthProvider
and the store load the whole workspace behind the boot screen. Every page
showed first content at 3.4-3.8 s.

Baseline chain on every hard load:
1. `/api/workspace/me` (~460 ms), then a network `getUser()` (~70 ms), then
   `/me` again (~420 ms). The restored session's SIGNED_IN event fetched /me,
   and its handler awaited it inside Supabase's auth lock, so `getUser()`
   queued behind it; the startup path then fetched /me a second time.
2. `requireSessionAccess`: network getUser, team_members by auth_user_id, the
   same member again by id inside resolveMemberAccess, then the permission
   reads, all sequential; /me then read the member a third time.
3. `fetchAllRows` always made one more request for an empty page. For tasks
   (165 rows, all children embedded) that empty page cost ~0.8 s.
4. Agent data (goals, suggestions, activity) loaded after the main batch.
5. Middleware getUser ~77 ms on every request.

## Done
- [x] `sessionUser` (getClaims, local ES256 verification) in middleware and `requireSessionAccess`; forged ES256/HS256, unknown kid, alg none, expired and missing tokens all rejected
- [x] `requireSessionAccess` reads the member once (`id, role, status` plus optional `memberColumns`) and hands it to `accessForMember`; the pre-migration schema still takes the original two-step legacy path
- [x] /me gets its row from that same lookup and returns exactly the same ten columns
- [x] AuthProvider: one shared in-flight /me, started alongside getUser; the SIGNED_IN handler no longer awaits inside the auth lock; only a refused /me sets accessError, as before
- [x] `fetchAllRows` asks for the exact total on the first page and stops when it has that many rows; without a count it still reads until an empty page, so a server cap never truncates (`scripts/verify-fetch-all.ts`)
- [x] Agent data requested alongside the main batch
- [x] Migration `20261002082430_workspace_today_without_tz_catalog.sql` (+ schema.sql): workspace_today() no longer joins pg_timezone_names (~60 ms per evaluation, evaluated per retainer row; retainer_accruing_lines took ~0.8 s returning nothing). NOT YET APPLIED.

## Results
- First content on every page: 3.4-3.8 s -> 1.6-1.9 s.
- Store load starts at ~240 ms after the shell (was ~1.07 s).
- Middleware check ~77 ms -> ~7 ms; /me ~450 ms (twice) -> ~155-225 ms (once).
- Tasks: one request (was two). Visual hand-off recorded in demo mode: one
  loader node, status moves forward, page paints whole.

## Next (not done)
1. Task RLS (biggest remaining, ~0.7 s): tasks read ~1.35 s in the browser vs
   ~0.4-0.6 s without RLS. Every task row runs can_read_task_row ->
   can_access_project -> has_permission, and every child row (comments,
   subtasks, criteria, reviews, assignees, dependencies) runs can_access_task,
   which re-reads the task and repeats the chain. A per-statement fast path
   `(SELECT public.can_read_all_tasks()) OR ...` is equivalent (every child
   task_id is a NOT NULL FK to tasks), but the FOR ALL manage policies sort
   before the select policies and also apply to SELECT, so they must be split
   per command for the fast path to help. Needs a local Postgres to test
   (Docker is installed but was not running).
2. Boot screen is not in the server HTML: ~100 ms of empty canvas before it
   appears (same colour, no flicker).
3. Demo mode calls the live retainer RPC (401s) - spun off as its own task.
