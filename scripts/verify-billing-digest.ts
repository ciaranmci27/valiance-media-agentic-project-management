/**
 * The morning "invoice drafts" email (lib/billing/draft-digest.ts), run with
 * the real supabase-js client against the real migrations in PGlite behind
 * fake-postgrest. Mail is captured, never sent.
 *
 *   npm run -s test:billing-digest
 */
import { randomUUID } from 'node:crypto';
import { startFakePostgrest } from './fake-postgrest';
import { createDraftingDatabase } from './invoice-drafting-db';

const PLANS_MIGRATION = '../supabase/migrations/20261018173052_project_billing_plans.sql';
const RETAINER_ISOLATION_MIGRATION = '../supabase/migrations/20261018175826_retainer_drafts_isolated.sql';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail).slice(0, 1200)}`);
}

interface Sent { to: string; subject: string; text?: string }

async function main() {
  const db = await createDraftingDatabase([PLANS_MIGRATION, RETAINER_ISOLATION_MIGRATION]);
  const server = await startFakePostgrest(db);
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: server.url, SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key' });
  const q = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

  try {
    const { runDraftDigest } = await import('../src/lib/billing/draft-digest');
    const { getServiceClient } = await import('../src/lib/api/supabase-service');
    const service = getServiceClient();
    let sent: Sent[] = [];
    let failSend = false;
    const send = async (options: { to: string | string[]; subject: string; html: string; text?: string }) => {
      if (failSend) return { success: false, error: 'smtp down' };
      sent.push({ to: String(options.to), subject: options.subject, text: options.text });
      return { success: true };
    };

    const owner = randomUUID();
    const admin = randomUUID();
    const optedOut = randomUUID();
    const quiet = randomUUID();
    const member = randomUUID();
    await q(`INSERT INTO team_members(id, name, email, role, email_notifications_enabled, email_notification_prefs) VALUES
      ($1, 'Owner', 'owner@example.test', 'owner', true, '{}'),
      ($2, 'Admin', 'admin@example.test', 'admin', true, '{"invoice_drafts": true}'),
      ($3, 'Opted out', 'out@example.test', 'admin', true, '{"invoice_drafts": false}'),
      ($4, 'No email', 'quiet@example.test', 'owner', false, '{}'),
      ($5, 'Member', 'member@example.test', 'member', true, '{"invoice_drafts": true}')`, [owner, admin, optedOut, quiet, member]);

    check('nothing new: no email', (await runDraftDigest(service, send)).outcome === 'nothing_new' && sent.length === 0);

    const project = randomUUID();
    await q("INSERT INTO projects(id, name) VALUES ($1, 'Plan4TheFuture')", [project]);
    const draft = async (number: string, amount: number) => {
      const id = randomUUID();
      await q(`INSERT INTO project_invoices(id, project_id, invoice_number, amount, status, invoice_type, date, auto_generated, line_items)
               VALUES ($1, $2, $3, $4, 'draft', 'hourly', '2026-11-01', true, '[]')`, [id, project, number, amount]);
      await q('SELECT announce_billing_draft($1, $2, $3)', [id, 'Invoice drafted', `${number} for Plan4TheFuture covers 10 h ($${amount}). Ready to review and send.`]);
      return id;
    };
    const first = await draft('INV-021', 3700);
    const second = await draft('INV-022', 400);
    const result = await runDraftDigest(service, send);
    const recipients = sent.map((mail) => mail.to).sort();
    check('one email per owner or admin with email on and the category not turned off (on by default)',
      result.outcome === 'sent' && JSON.stringify(recipients) === JSON.stringify(['admin@example.test', 'owner@example.test']), { result, recipients });
    check('the email lists both drafts and the total, and says nothing was sent to a client',
      sent[0].subject === '2 invoice drafts are ready to send' && /INV-021/.test(sent[0].text ?? '') && /\$4,100\.00/.test(sent[0].text ?? '')
      && /Nothing has been sent to a client/.test(sent[0].text ?? ''), sent[0]);

    sent = [];
    check('a rerun emails nothing (each draft once)', (await runDraftDigest(service, send)).outcome === 'nothing_new' && sent.length === 0);

    await q("UPDATE project_invoices SET status = 'sent' WHERE id = $1", [first]);
    await q("SELECT announce_billing_draft($1, 'Hours added', 'INV-022 now includes more hours.')", [second]);
    await draft('INV-023', 250);
    const third = await runDraftDigest(service, send);
    check('a draft already sent is left out; a re-announced draft (hours added) is emailed again',
      third.drafts === 2 && /INV-022/.test(sent[0]?.text ?? '') && !/INV-021/.test(sent[0]?.text ?? ''), { third, text: sent[0]?.text });

    sent = [];
    failSend = true;
    await draft('INV-024', 125);
    check('mail down: reported as failed and not marked', (await runDraftDigest(service, send)).outcome === 'failed');
    failSend = false;
    const retry = await runDraftDigest(service, send);
    check('mail back: the same draft goes out next time', retry.outcome === 'sent' && retry.drafts === 1 && /INV-024/.test(sent[0]?.text ?? '') && sent[0]?.subject === 'An invoice draft is ready to send', { retry, sent });

    await q("UPDATE team_members SET email_notifications_enabled = false");
    await draft('INV-025', 90);
    sent = [];
    check('nobody wants email: marked, nothing sent', (await runDraftDigest(service, send)).outcome === 'no_recipients' && sent.length === 0);
    const unmarked = await q<{ n: number }>('SELECT count(*)::int n FROM billing_draft_notices WHERE emailed_at IS NULL');
    check('every handled notice is marked', unmarked[0].n === 0, unmarked);
  } finally {
    await server.close();
    await db.close();
  }

  if (failures.length) {
    console.error(`billing digest: ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  console.log(`billing digest: all ${passed} checks passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
