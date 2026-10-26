import type { SupabaseClient } from '@supabase/supabase-js';
import { keepLinkedTaskFiles } from '@/lib/task-files/retention';
import { INBOUND_EMAIL_BUCKET, recordInboxError } from './email/ingest';
import { comms } from '@/lib/communications/db';

/**
 * Retention and the orphan sweep for the inbound-email bucket, run by Vercel
 * crons (vercel.json) through /api/internal/inbound-email/*. Supabase lets
 * only the Storage API delete files, so both run here, on the server, with
 * the service client.
 *
 * Retention (daily): per inbox, messages older than its retention_days, and
 * messages stuck in receiving for over 24 hours. Task files linking an
 * attachment get their own copy first (keepLinkedTaskFiles), then the files
 * the messages own go (raw .eml, and attachments stored before copies were
 * shared), then the rows (email_retention_delete: attachments, task
 * links, triage, recipients, candidates, the message, then threads left
 * empty). A message whose files fail to delete keeps every row and is
 * retried by the next run. Batches are bounded by size and time, so a run
 * fits the function limit; whatever is left is picked up next time. Last,
 * stored copies (email_files) nothing points at any more are released: the
 * database marks them, their bytes go, then their rows. A copy that fails to
 * delete stays marked and is retried next run; it is never reused.
 *
 *
 * Orphan sweep (weekly): lists the bucket and deletes every object no row
 * owns. Rows always exist before their files, so an orphan only comes from a
 * crash between two steps. Paths outside {inbox}/{message}/{file} are left
 * alone and logged, so a surprise in the listing can never become a mass
 * delete.
 *
 * Each run logs one structured line and stores its counts in
 * communications.maintenance_runs (one row per job) for the settings status. A
 * message deleted while still receiving is client email that never arrived,
 * so each inbox that lost one also gets it as its last_error, which the
 * settings card shows.
 */

export type MaintenanceKind = 'retention' | 'orphan_sweep';
export type MaintenanceOutcome = 'complete' | 'partial' | 'failed';

export interface MaintenanceOptions {
  /** Stop starting new batches after this long (the routes allow 60 s). */
  budgetMs?: number;
  /** Messages (retention) or listed objects (sweep) per batch. */
  batchSize?: number;
  /** Retention only: messages handled per run at most. */
  maxMessages?: number;
  now?: () => number;
}

export interface MaintenanceSummary {
  kind: MaintenanceKind;
  started_at: string;
  finished_at: string;
  outcome: MaintenanceOutcome;
  more_pending: boolean;
  messages_deleted: number;
  stuck_deleted: number;
  threads_deleted: number;
  files_deleted: number;
  objects_scanned: number;
  failures: number;
  last_error: string | null;
}

export interface RetentionSummary extends MaintenanceSummary {
  kind: 'retention';
  /** Task files that linked a deleted attachment and now hold their own copy. */
  task_files_kept: number;
  /** Stored copies released once their last email went (their bytes are counted in files_deleted). */
  copies_released: number;
  by_inbox: Record<string, { messages_deleted: number; stuck_deleted: number; failures: number }>;
  failed_message_ids: string[];
}

export interface OrphanSweepSummary extends MaintenanceSummary {
  kind: 'orphan_sweep';
  unrecognized: number;
}

interface DueMessage {
  id: string;
  inbox_id: string;
  reason: 'retention' | 'stuck_receiving';
  paths: string[];
}

interface DeleteResult {
  deleted: { id: string; inbox_id: string; reason: 'retention' | 'stuck_receiving' }[];
  skipped: string[];
  attachments_deleted: number;
  threads_deleted: number;
}

const DEFAULT_BUDGET_MS = 45_000;
const RELEASE_BATCH = 200;
const REMOVE_CHUNK = 100;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/**
 * {inbox_id}/{message_id}/raw.eml, {inbox_id}/{message_id}/{attachment_id}
 * (files stored before copies were shared), or {inbox_id}/files/{file_id}.
 */
export const OBJECT_PATH = new RegExp(`^${UUID}/(${UUID}/(raw\\.eml|${UUID})|files/${UUID})$`);

function emptySummary<K extends MaintenanceKind>(kind: K, startedAt: number): MaintenanceSummary & { kind: K } {
  return {
    kind,
    started_at: new Date(startedAt).toISOString(),
    finished_at: new Date(startedAt).toISOString(),
    outcome: 'complete',
    more_pending: false,
    messages_deleted: 0,
    stuck_deleted: 0,
    threads_deleted: 0,
    files_deleted: 0,
    objects_scanned: 0,
    failures: 0,
    last_error: null,
  };
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 2000);

/** Removes paths in chunks; ok only when every chunk was accepted. Absent objects are not errors. */
async function removePaths(supabase: SupabaseClient, paths: string[]): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  let removed = 0;
  for (let i = 0; i < paths.length; i += REMOVE_CHUNK) {
    const { data, error } = await supabase.storage.from(INBOUND_EMAIL_BUCKET).remove(paths.slice(i, i + REMOVE_CHUNK));
    if (error) return { ok: false, error: error.message };
    removed += data?.length ?? 0;
  }
  return { ok: true, removed };
}

function finish<T extends MaintenanceSummary>(summary: T, now: () => number): T {
  summary.finished_at = new Date(now()).toISOString();
  if (summary.outcome !== 'failed' && (summary.failures > 0 || summary.more_pending)) summary.outcome = 'partial';
  return summary;
}

/** One structured log line per run, then the run's row in communications.maintenance_runs. */
async function report(supabase: SupabaseClient, summary: RetentionSummary | OrphanSweepSummary): Promise<void> {
  const line = JSON.stringify({ event: `inbound_email.${summary.kind}`, ...summary });
  if (summary.outcome === 'failed') console.error(line);
  else if (summary.outcome === 'partial') console.warn(line);
  else console.log(line);
  const { error } = await comms(supabase).rpc('record_maintenance_run', {
    p_kind: summary.kind,
    p_run: {
      started_at: summary.started_at,
      finished_at: summary.finished_at,
      outcome: summary.outcome,
      more_pending: summary.more_pending,
      messages_deleted: summary.messages_deleted,
      stuck_deleted: summary.stuck_deleted,
      threads_deleted: summary.threads_deleted,
      files_deleted: summary.files_deleted,
      objects_scanned: summary.objects_scanned,
      failures: summary.failures,
      last_error: summary.last_error,
    },
  });
  if (error) console.error(`[inbound-email] could not record the ${summary.kind} run: ${error.message}`);
}

async function listDue(supabase: SupabaseClient, limit: number, exclude: string[]): Promise<DueMessage[]> {
  const { data, error } = await comms(supabase).rpc('retention_due', { p_limit: limit, p_exclude: exclude });
  if (error) throw new Error(`listing due messages failed: ${error.message}`);
  return (data ?? []) as DueMessage[];
}

/**
 * Stored copies nothing points at any more (their last email just went): the
 * database marks them deleting (email_files_release, which locks and
 * re-checks each one, so an email that has just claimed a copy keeps it),
 * their bytes go, then their rows (email_files_forget). Within the run's
 * time budget; a copy whose bytes fail to delete stays marked for next run.
 */
async function releaseUnusedCopies(supabase: SupabaseClient, summary: RetentionSummary, startedAt: number, budgetMs: number, now: () => number): Promise<void> {
  try {
    while (now() - startedAt < budgetMs) {
      const { data, error } = await comms(supabase).rpc('files_release', { p_limit: RELEASE_BATCH });
      if (error) throw new Error(`releasing copies failed: ${error.message}`);
      const copies = (data ?? []) as { id: string; path: string }[];
      if (copies.length === 0) return;
      const removed = await removePaths(supabase, copies.map((copy) => copy.path));
      if (!removed.ok) {
        summary.failures++;
        summary.last_error = `removing released copies failed: ${removed.error}`.slice(0, 2000);
        return;
      }
      summary.files_deleted += removed.removed;
      const { data: forgotten, error: forgetError } = await comms(supabase).rpc('files_forget', { p_ids: copies.map((copy) => copy.id) });
      if (forgetError) throw new Error(`forgetting released copies failed: ${forgetError.message}`);
      summary.copies_released += Number(forgotten ?? 0);
      if (copies.length < RELEASE_BATCH) return;
    }
    summary.more_pending = true;
  } catch (error) {
    summary.outcome = 'failed';
    summary.last_error = errorText(error);
  }
}

export async function runRetention(supabase: SupabaseClient, options: MaintenanceOptions = {}): Promise<RetentionSummary> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const batchSize = options.batchSize ?? 50;
  const maxMessages = options.maxMessages ?? 2000;
  const summary: RetentionSummary = { ...emptySummary('retention', startedAt), task_files_kept: 0, copies_released: 0, by_inbox: {}, failed_message_ids: [] };
  const inbox = (id: string) => (summary.by_inbox[id] ??= { messages_deleted: 0, stuck_deleted: 0, failures: 0 });
  // Messages this run must not pick again: their files failed to delete, or
  // their rows were no longer due. The next run tries them afresh.
  const exclude: string[] = [];
  let handled = 0;

  try {
    while (true) {
      if (now() - startedAt >= budgetMs || handled >= maxMessages) {
        summary.more_pending = (await listDue(supabase, 1, exclude)).length > 0;
        break;
      }
      const listed = await listDue(supabase, Math.min(batchSize, maxMessages - handled), exclude);
      if (listed.length === 0) break;
      handled += listed.length;

      // A task linking one of these attachments gets its own copy before
      // anything is deleted; a message whose copy failed waits for next run.
      const kept = await keepLinkedTaskFiles(supabase, listed.map((message) => message.id));
      summary.task_files_kept += kept.kept;
      const held = new Set(kept.failed);
      for (const message of listed.filter((row) => held.has(row.id))) {
        summary.failures++;
        inbox(message.inbox_id).failures++;
        summary.failed_message_ids.push(message.id);
        exclude.push(message.id);
      }
      if (kept.last_error) summary.last_error = kept.last_error;
      const due = listed.filter((message) => !held.has(message.id));
      if (due.length === 0) continue;

      // Files first. One request for the whole batch; if Storage refuses it,
      // message by message, so one bad file holds back only its own message.
      const cleared: DueMessage[] = [];
      const allPaths = due.flatMap((message) => message.paths);
      const bulk = allPaths.length ? await removePaths(supabase, allPaths) : { ok: true as const, removed: 0 };
      if (bulk.ok) {
        cleared.push(...due);
        summary.files_deleted += bulk.removed;
      } else {
        for (const message of due) {
          const single = message.paths.length ? await removePaths(supabase, message.paths) : { ok: true as const, removed: 0 };
          if (single.ok) {
            cleared.push(message);
            summary.files_deleted += single.removed;
          } else {
            summary.failures++;
            inbox(message.inbox_id).failures++;
            summary.failed_message_ids.push(message.id);
            summary.last_error = `files of message ${message.id}: ${single.error}`.slice(0, 2000);
            exclude.push(message.id);
          }
        }
      }
      if (cleared.length === 0) continue;

      // Then the rows, only of messages whose files are gone.
      const { data, error } = await comms(supabase).rpc('retention_delete', { p_message_ids: cleared.map((message) => message.id) });
      if (error) throw new Error(`deleting rows failed: ${error.message}`);
      const result = data as DeleteResult;
      for (const row of result.deleted) {
        if (row.reason === 'retention') {
          summary.messages_deleted++;
          inbox(row.inbox_id).messages_deleted++;
        } else {
          summary.stuck_deleted++;
          inbox(row.inbox_id).stuck_deleted++;
        }
      }
      summary.threads_deleted += result.threads_deleted;
      exclude.push(...result.skipped);
    }
  } catch (error) {
    summary.outcome = 'failed';
    summary.last_error = errorText(error);
  }

  if (summary.outcome !== 'failed') await releaseUnusedCopies(supabase, summary, startedAt, budgetMs, now);

  finish(summary, now);
  await report(supabase, summary);
  for (const [inboxId, counts] of Object.entries(summary.by_inbox)) {
    if (counts.stuck_deleted === 0) continue;
    const emails = counts.stuck_deleted === 1 ? '1 email' : `${counts.stuck_deleted} emails`;
    await recordInboxError(supabase, inboxId, `Retention deleted ${emails} that never finished arriving (stuck for over 24 hours). Check the Resend log for the sender.`);
  }
  return summary;
}

export async function runOrphanSweep(supabase: SupabaseClient, options: MaintenanceOptions = {}): Promise<OrphanSweepSummary> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const pageSize = Math.min(options.batchSize ?? 1000, 1000);
  const summary: OrphanSweepSummary = { ...emptySummary('orphan_sweep', startedAt), unrecognized: 0 };
  const bucket = supabase.storage.from(INBOUND_EMAIL_BUCKET);

  try {
    let cursor: string | undefined;
    do {
      if (now() - startedAt >= budgetMs) {
        summary.more_pending = true;
        break;
      }
      const { data, error } = await bucket.listV2({ limit: pageSize, cursor, with_delimiter: false });
      if (error) throw new Error(`listing the bucket failed: ${error.message}`);
      const objects = data.objects ?? [];
      summary.objects_scanned += objects.length;

      // Flat listing: key (and name, without a prefix) is the full path.
      const paths = objects.map((object) => (typeof object.key === 'string' && object.key ? object.key : object.name));
      const recognized = paths.filter((path) => OBJECT_PATH.test(path));
      if (recognized.length < paths.length) {
        summary.unrecognized += paths.length - recognized.length;
        console.warn(`[inbound-email] orphan sweep left ${paths.length - recognized.length} object(s) with unexpected paths alone`);
      }
      if (recognized.length) {
        const { data: known, error: knownError } = await comms(supabase).rpc('storage_known_paths', { p_paths: recognized });
        if (knownError) throw new Error(`checking paths failed: ${knownError.message}`);
        const owned = new Set((known ?? []) as string[]);
        const orphans = recognized.filter((path) => !owned.has(path));
        for (let i = 0; i < orphans.length; i += REMOVE_CHUNK) {
          const chunk = orphans.slice(i, i + REMOVE_CHUNK);
          const removed = await removePaths(supabase, chunk);
          if (removed.ok) summary.files_deleted += removed.removed;
          else {
            summary.failures += chunk.length;
            summary.last_error = `removing orphans failed: ${removed.error}`.slice(0, 2000);
          }
        }
      }

      if (data.hasNext && !data.nextCursor) throw new Error('the listing has more objects but no cursor');
      cursor = data.hasNext ? data.nextCursor : undefined;
    } while (cursor);
  } catch (error) {
    summary.outcome = 'failed';
    summary.last_error = errorText(error);
  }

  finish(summary, now);
  await report(supabase, summary);
  return summary;
}
