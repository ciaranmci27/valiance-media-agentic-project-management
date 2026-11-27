import type { Harness } from './harness';

/**
 * Billing and money: retainers, the billing plan, company invoice details
 * and hour approvals over REST and MCP. Money writes need invoices.manage or
 * settings.manage on the key and the member's api channel: an Owner's key
 * with the scope passes, an agent's key (no money permission on its role)
 * and a key without the scope are refused, and the database changes only
 * on the allowed calls.
 */
export async function moneyArea(h: Harness) {
  const { q, key, call, tool, toolNames, check, members } = h;
  const retainers = await import('../../src/app/api/v1/projects/[id]/retainers/route');
  const retainer = await import('../../src/app/api/v1/projects/[id]/retainers/[retainerId]/route');
  const amounts = await import('../../src/app/api/v1/projects/[id]/retainers/[retainerId]/amounts/route');
  const periods = await import('../../src/app/api/v1/projects/[id]/retainers/[retainerId]/periods/route');
  const duePeriods = await import('../../src/app/api/v1/projects/[id]/retainers/due-periods/route');
  const billingPlan = await import('../../src/app/api/v1/projects/[id]/billing-plan/route');
  const invoiceDetails = await import('../../src/app/api/v1/billing/invoice-details/route');
  const hourApprovals = await import('../../src/app/api/v1/time/hour-approvals/route');

  const P = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Money Retainer Co') RETURNING id"))[0].id;
  const P2 = (await q<{ id: string }>("INSERT INTO pm.projects (name) VALUES ('Money Other Ltd') RETURNING id"))[0].id;
  // The agent reaches the project, so its refusals are about money permissions, not reach.
  await q('INSERT INTO pm.project_members (project_id, member_id) VALUES ($1, $2), ($1, $3)', [P, members.agent, members.member]);

  const MONEY = ['projects.read', 'projects.read_all', 'invoices.read', 'invoices.manage'];
  const ownerKey = await key(members.owner, MONEY);
  const agentKey = await key(members.agent, MONEY);
  const readOnlyScopeKey = await key(members.owner, ['projects.read', 'projects.read_all', 'invoices.read']);
  const base = `/api/v1/projects/${P}/retainers`;

  // -- Retainers: create ------------------------------------------------------
  const createBody = { name: 'Money monthly care plan', amount: 1200, start_date: '2026-01-01', lead_days: 3 };
  const made = await call(retainers.POST, ownerKey, 'POST', base, { id: P }, createBody);
  const R = made.json.data?.id as string;
  check('money: an Owner key with invoices.manage creates a retainer (201)', made.status === 201 && made.json.data?.name === 'Money monthly care plan' && made.json.data?.lead_days === 3, made.json);
  const rows = await q<{ project_id: string; status: string; amount: string }>(
    `SELECT r.project_id, r.status, a.amount FROM pm.project_retainers r JOIN pm.project_retainer_amounts a ON a.retainer_id = r.id
     WHERE r.id = $1 AND a.deleted_at IS NULL`, [R ?? '00000000-0000-0000-0000-000000000000']);
  check('money: the retainer and its first amount are in the database', rows.length === 1 && rows[0].project_id === P && Number(rows[0].amount) === 1200 && rows[0].status === 'active', rows);

  const agentMade = await call(retainers.POST, agentKey, 'POST', base, { id: P }, { ...createBody, name: 'Money agent retainer' });
  check('money: an agent key with the scope is refused (its role holds no invoices.manage)', agentMade.status === 403 && agentMade.json.error?.details?.reason === 'missing_member_permission', agentMade.json);
  const noScope = await call(retainers.POST, readOnlyScopeKey, 'POST', base, { id: P }, { ...createBody, name: 'Money no scope retainer' });
  check('money: a key without invoices.manage is refused', noScope.status === 403 && noScope.json.error?.details?.reason === 'missing_key_scope', noScope.json);
  const refusedRows = await q("SELECT id FROM pm.project_retainers WHERE name IN ('Money agent retainer', 'Money no scope retainer')");
  check('money: refused creates wrote nothing', refusedRows.length === 0, refusedRows);
  const badCreate = await call(retainers.POST, ownerKey, 'POST', base, { id: P }, { name: 'Money bad', amount: -5, start_date: '2026-02-30' });
  check('money: a negative amount or a day that does not exist is 422', badCreate.status === 422, badCreate.json);

  // -- Retainers: schedule an amount -------------------------------------------
  const scheduled = await call(amounts.POST, ownerKey, 'POST', `${base}/${R}/amounts`, { id: P, retainerId: R }, { amount: 1500, effective_date: '2026-06-01' });
  check('money: the Owner key schedules a new amount (201)', scheduled.status === 201 && scheduled.json.data?.amount === 1500 && scheduled.json.data?.effective_date === '2026-06-01', scheduled.json);
  const agentScheduled = await call(amounts.POST, agentKey, 'POST', `${base}/${R}/amounts`, { id: P, retainerId: R }, { amount: 9, effective_date: '2026-07-01' });
  check('money: an agent key may not schedule an amount', agentScheduled.status === 403, agentScheduled.json);
  const amountRows = await q<{ amount: string; effective_date: string }>(
    "SELECT amount, effective_date::text FROM pm.project_retainer_amounts WHERE retainer_id = $1 AND deleted_at IS NULL ORDER BY effective_date", [R]);
  check('money: the database holds the first and the scheduled amount, not the refused one', amountRows.length === 2 && Number(amountRows[1].amount) === 1500 && amountRows[1].effective_date === '2026-06-01', amountRows);
  const elsewhere = await call(amounts.POST, ownerKey, 'POST', `/api/v1/projects/${P2}/retainers/${R}/amounts`, { id: P2, retainerId: R }, { amount: 1, effective_date: '2026-08-01' });
  check('money: a retainer is reached only through its own project (404 elsewhere)', elsewhere.status === 404, elsewhere.json);

  // -- Retainers: edit, list, due, draft -----------------------------------------
  const paused = await call(retainer.PATCH, ownerKey, 'PATCH', `${base}/${R}`, { id: P, retainerId: R }, { status: 'paused' });
  const pausedRow = (await q<{ status: string; name: string }>('SELECT status, name FROM pm.project_retainers WHERE id = $1', [R]))[0];
  check('money: PATCH pauses the retainer and keeps the rest', paused.status === 200 && pausedRow.status === 'paused' && pausedRow.name === 'Money monthly care plan', { body: paused.json, row: pausedRow });
  const emptyPatch = await call(retainer.PATCH, ownerKey, 'PATCH', `${base}/${R}`, { id: P, retainerId: R }, {});
  check('money: an empty PATCH is 422', emptyPatch.status === 422, emptyPatch.json);
  await call(retainer.PATCH, ownerKey, 'PATCH', `${base}/${R}`, { id: P, retainerId: R }, { status: 'active' });

  const listed = await call(retainers.GET, readOnlyScopeKey, 'GET', base, { id: P });
  check('money: invoices.read lists the retainer with its amounts', listed.status === 200
    && (listed.json.data?.retainers ?? []).some((row: { id: string }) => row.id === R)
    && (listed.json.data?.amounts ?? []).filter((row: { retainer_id: string }) => row.retainer_id === R).length === 2
    && !('shares' in (listed.json.data ?? {})), listed.json);
  const due = await call(duePeriods.GET, ownerKey, 'GET', `${base}/due-periods`, { id: P });
  check('money: due periods list the January period of the retainer', due.status === 200
    && (due.json.data ?? []).some((row: { retainer_id: string; period_start: string }) => row.retainer_id === R && row.period_start === '2026-01-01'), due.json);
  const dueRefused = await call(duePeriods.GET, readOnlyScopeKey, 'GET', `${base}/due-periods`, { id: P });
  check('money: due periods need invoices.manage', dueRefused.status === 403, dueRefused.json);

  const drafted = await call(periods.POST, ownerKey, 'POST', `${base}/${R}/periods`, { id: P, retainerId: R }, { period_start: '2026-01-01' });
  check('money: the Owner key drafts the January invoice (201, a draft)', drafted.status === 201 && drafted.json.data?.status === 'draft' && drafted.json.data?.project_id === P, drafted.json);
  const invoiceRow = await q<{ id: string; amount: string }>('SELECT id, amount FROM pm.project_invoices WHERE id = $1 AND deleted_at IS NULL', [drafted.json.data?.id ?? '00000000-0000-0000-0000-000000000000']);
  check('money: the draft invoice is in the database for the January amount', invoiceRow.length === 1 && Number(invoiceRow[0].amount) === 1200, invoiceRow);
  const draftedAgain = await call(periods.POST, ownerKey, 'POST', `${base}/${R}/periods`, { id: P, retainerId: R }, { period_start: '2026-01-01' });
  check('money: drafting a period already on an invoice is 409', draftedAgain.status === 409, draftedAgain.json);
  const notAPeriod = await call(periods.POST, ownerKey, 'POST', `${base}/${R}/periods`, { id: P, retainerId: R }, { period_start: '2026-01-17' });
  check('money: a date that is not a period start is 400', notAPeriod.status === 400, notAPeriod.json);

  // -- Billing plan --------------------------------------------------------------
  const plan = await call(billingPlan.PATCH, ownerKey, 'PATCH', `/api/v1/projects/${P}/billing-plan`, { id: P }, { payment_terms_days: 15, hours_trigger: 'days_of_month', days_of_month: [1, 15] });
  const planRow = (await q<{ payment_terms_days: number; hours_trigger: string; days_of_month: number[]; starts_on: string | null }>(
    'SELECT payment_terms_days, hours_trigger, days_of_month, starts_on::text FROM pm.project_billing_plans WHERE project_id = $1', [P]))[0];
  check('money: the Owner key saves the billing plan, and drafting starts today', plan.status === 200 && planRow?.payment_terms_days === 15
    && planRow.hours_trigger === 'days_of_month' && planRow.days_of_month.join(',') === '1,15' && !!planRow.starts_on, { body: plan.json, row: planRow });
  const planRefused = await call(billingPlan.PATCH, agentKey, 'PATCH', `/api/v1/projects/${P}/billing-plan`, { id: P }, { payment_terms_days: 90 });
  check('money: an agent key may not change the billing plan', planRefused.status === 403, planRefused.json);
  const planBad = await call(billingPlan.PATCH, ownerKey, 'PATCH', `/api/v1/projects/${P}/billing-plan`, { id: P }, { hours_trigger: 'every_weeks' });
  check('money: every_weeks without weeks_anchor is 400 in the database\'s words', planBad.status === 400, planBad.json);
  const planRead = await call(billingPlan.GET, readOnlyScopeKey, 'GET', `/api/v1/projects/${P}/billing-plan`, { id: P });
  check('money: invoices.read reads the saved plan', planRead.status === 200 && planRead.json.data?.payment_terms_days === 15, planRead.json);
  const defaultPlan = await call(billingPlan.GET, ownerKey, 'GET', `/api/v1/projects/${P2}/billing-plan`, { id: P2 });
  check('money: a project with no plan reads the defaults', defaultPlan.status === 200 && defaultPlan.json.data?.hours_trigger === 'manual', defaultPlan.json);

  // -- MCP -----------------------------------------------------------------------
  const ownerTools = await toolNames(ownerKey);
  const agentTools = await toolNames(agentKey);
  check('money mcp: the Owner key sees the retainer and plan tools', ['list_retainers', 'create_retainer', 'schedule_retainer_amount', 'draft_retainer_invoice', 'update_billing_plan'].every((name) => ownerTools.includes(name)));
  check('money mcp: the agent key sees no money write tool', !['create_retainer', 'update_retainer', 'schedule_retainer_amount', 'draft_retainer_invoice', 'update_billing_plan', 'update_invoice_details', 'set_hour_approvals'].some((name) => agentTools.includes(name)));
  const overMcp = await tool(ownerKey, 'schedule_retainer_amount', { project_id: P, retainer_id: R, amount: 1750, effective_date: '2026-09-01' });
  const septRow = await q<{ amount: string }>("SELECT amount FROM pm.project_retainer_amounts WHERE retainer_id = $1 AND effective_date = '2026-09-01' AND deleted_at IS NULL", [R]);
  check('money mcp: schedule_retainer_amount schedules it in the database', overMcp.result.ok === true && septRow.length === 1 && Number(septRow[0].amount) === 1750, { result: overMcp.result, rows: septRow });
  const agentOverMcp = await tool(agentKey, 'schedule_retainer_amount', { project_id: P, retainer_id: R, amount: 1, effective_date: '2026-10-01' });
  const octRow = await q("SELECT id FROM pm.project_retainer_amounts WHERE retainer_id = $1 AND effective_date = '2026-10-01'", [R]);
  check('money mcp: the agent key is refused and nothing is written', agentOverMcp.result.ok !== true && octRow.length === 0, agentOverMcp.result);
  const createdOverMcp = await tool(ownerKey, 'create_retainer', { project_id: P2, name: 'Money MCP retainer', amount: 300, start_date: '2026-03-01' });
  check('money mcp: create_retainer creates one', createdOverMcp.result.ok === true && createdOverMcp.result.data?.project_id === P2, createdOverMcp.result);
  const planOverMcp = await tool(ownerKey, 'update_billing_plan', { project_id: P2, payment_terms_days: 30 });
  const p2Plan = await q<{ payment_terms_days: number }>('SELECT payment_terms_days FROM pm.project_billing_plans WHERE project_id = $1', [P2]);
  check('money mcp: update_billing_plan saves the plan', planOverMcp.result.ok === true && p2Plan[0]?.payment_terms_days === 30, { result: planOverMcp.result, rows: p2Plan });

  // -- Company invoice details and hour approvals (put back at the end) ---------
  const SETTINGS = ['settings.manage'];
  const ownerSettingsKey = await key(members.owner, SETTINGS);
  const memberSettingsKey = await key(members.member, SETTINGS);
  const agentSettingsKey = await key(members.agent, SETTINGS);
  const original = (await q<{ business_name: string; payment_terms: string; payment_instructions: string; auto_approve_human_hours: boolean }>(
    'SELECT business_name, payment_terms, payment_instructions, auto_approve_human_hours FROM pm.business_settings LIMIT 1'))[0];
  try {
    const read = await call(invoiceDetails.GET, ownerSettingsKey, 'GET', '/api/v1/billing/invoice-details');
    check('money: an Owner key with settings.manage reads the invoice details', read.status === 200 && read.json.data?.business_name === original.business_name
      && 'payment_instructions' in (read.json.data ?? {}) && !('api_enabled' in (read.json.data ?? {})), read.json);
    const changed = await call(invoiceDetails.PATCH, ownerSettingsKey, 'PATCH', '/api/v1/billing/invoice-details', {}, { business_name: '  Money Test Studio  ', payment_terms: '' });
    const after = (await q<{ business_name: string; payment_terms: string }>('SELECT business_name, payment_terms FROM pm.business_settings LIMIT 1'))[0];
    check('money: PATCH changes the invoice details (trimmed, blank terms read Upon receipt)', changed.status === 200
      && after.business_name === 'Money Test Studio' && after.payment_terms === 'Upon receipt', { body: changed.json, row: after });
    const memberRefused = await call(invoiceDetails.PATCH, memberSettingsKey, 'PATCH', '/api/v1/billing/invoice-details', {}, { business_name: 'Money Member' });
    const agentRefused = await call(invoiceDetails.PATCH, agentSettingsKey, 'PATCH', '/api/v1/billing/invoice-details', {}, { business_name: 'Money Agent' });
    const unchanged = (await q<{ business_name: string }>('SELECT business_name FROM pm.business_settings LIMIT 1'))[0];
    check('money: a member key and an agent key are refused, the details stay', memberRefused.status === 403 && agentRefused.status === 403 && unchanged.business_name === 'Money Test Studio', { member: memberRefused.json, agent: agentRefused.json });
    const scopeRefused = await call(invoiceDetails.GET, ownerKey, 'GET', '/api/v1/billing/invoice-details');
    check('money: a key without settings.manage may not read them', scopeRefused.status === 403, scopeRefused.json);
    const overMcpDetails = await tool(ownerSettingsKey, 'update_invoice_details', { payment_instructions: 'Money: pay by bank transfer' });
    const instructions = (await q<{ payment_instructions: string }>('SELECT payment_instructions FROM pm.business_settings LIMIT 1'))[0];
    check('money mcp: update_invoice_details changes the database', overMcpDetails.result.ok === true && instructions.payment_instructions === 'Money: pay by bank transfer', overMcpDetails.result);

    const off = await call(hourApprovals.PATCH, ownerSettingsKey, 'PATCH', '/api/v1/time/hour-approvals', {}, { auto_approve_human_hours: false });
    const flag = (await q<{ auto_approve_human_hours: boolean }>('SELECT auto_approve_human_hours FROM pm.business_settings LIMIT 1'))[0];
    check('money: the Owner key turns auto-approval of hours off', off.status === 200 && off.json.data?.auto_approve_human_hours === false && flag.auto_approve_human_hours === false, off.json);
    const agentHours = await call(hourApprovals.PATCH, agentSettingsKey, 'PATCH', '/api/v1/time/hour-approvals', {}, { auto_approve_human_hours: true });
    check('money: an agent key may not change hour approvals', agentHours.status === 403, agentHours.json);
    const hoursOverMcp = await tool(ownerSettingsKey, 'get_hour_approvals', {});
    check('money mcp: get_hour_approvals reads it', hoursOverMcp.result.ok === true && hoursOverMcp.result.data?.auto_approve_human_hours === false, hoursOverMcp.result);
  } finally {
    await q('UPDATE pm.business_settings SET business_name = $1, payment_terms = $2, payment_instructions = $3, auto_approve_human_hours = $4',
      [original.business_name, original.payment_terms, original.payment_instructions, original.auto_approve_human_hours]);
  }
}
