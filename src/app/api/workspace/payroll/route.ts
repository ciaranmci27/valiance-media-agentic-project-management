import { NextResponse } from 'next/server';
import { accessAllows, accessAllowsProject, requireSessionAccess, sanitizeTimeEntryForAccess } from '@/lib/api/access';

export async function GET() {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service } = auth.data;
  const canManage = accessAllows(access, 'compensation.manage', 'app') || accessAllows(access, 'payouts.manage', 'app');
  const canReview = accessAllows(access, 'time.approve', 'app');
  const canReadOwn = accessAllows(access, 'earnings.own.read', 'app');
  if (!canManage && !canReview && !canReadOwn) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const entryTargetMember = canManage || canReview ? null : memberId;
  const financialTargetMember = canManage ? null : memberId;
  let entriesQuery = service.from('project_time_entries').select('id, project_id, member_id, start_time, end_time, segments, description, compensation_rate, work_type, approval_status, submitted_at, approved_at').not('end_time', 'is', null);
  let ratesQuery = service.from('team_member_hourly_rates').select('*');
  let adjustmentsQuery = service.from('team_member_earning_adjustments').select('*');
  let payoutsQuery = service.from('team_member_payouts').select('*');
  if (entryTargetMember) entriesQuery = entriesQuery.eq('member_id', entryTargetMember);
  if (!accessAllows(access, 'projects.read_all', 'app')) {
    entriesQuery = access.project_ids.length > 0
      ? entriesQuery.in('project_id', access.project_ids)
      : entriesQuery.eq('project_id', '00000000-0000-0000-0000-000000000000');
  }
  if (financialTargetMember) {
    ratesQuery = ratesQuery.eq('member_id', financialTargetMember);
    adjustmentsQuery = adjustmentsQuery.eq('member_id', financialTargetMember);
    payoutsQuery = payoutsQuery.eq('member_id', financialTargetMember);
  }
  if (!canManage && !canReadOwn) {
    ratesQuery = ratesQuery.eq('id', '00000000-0000-0000-0000-000000000000');
    adjustmentsQuery = adjustmentsQuery.eq('id', '00000000-0000-0000-0000-000000000000');
    payoutsQuery = payoutsQuery.eq('id', '00000000-0000-0000-0000-000000000000');
  }
  const [entries, rates, adjustments, payouts, allocations] = await Promise.all([
    entriesQuery.order('start_time', { ascending: false }),
    ratesQuery.order('effective_at', { ascending: false }),
    adjustmentsQuery.order('effective_date', { ascending: false }),
    payoutsQuery.order('payment_date', { ascending: false }),
    service.from('team_member_payout_allocations').select('*'),
  ]);
  const error = entries.error || rates.error || adjustments.error || payouts.error || allocations.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const payoutIds = new Set((payouts.data || []).map((row) => row.id));
  return NextResponse.json({
    data: {
      // Mask compensation_rate on entries the caller is not entitled to see
      // (e.g. a reviewer holding only time.approve), matching the entries route.
      entries: (entries.data || []).map((entry) => sanitizeTimeEntryForAccess(entry, access)),
      rates: rates.data || [],
      adjustments: adjustments.data || [],
      payouts: payouts.data || [],
      allocations: (allocations.data || []).filter((row) => payoutIds.has(row.payout_id)),
    },
  });
}

export async function POST(request: Request) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;
  const { access, memberId, service, client } = auth.data;
  const body = await request.json() as Record<string, unknown>;
  const action = String(body.action || '');

  if (action === 'review') {
    if (!accessAllows(access, 'time.approve', 'app')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const entryIds = Array.isArray(body.entry_ids) ? body.entry_ids.map(String) : [];
    if (entryIds.length === 0) return NextResponse.json({ error: 'Select at least one time entry' }, { status: 422 });
    const { data: reviewEntries, error: reviewError } = await service.from('project_time_entries').select('id, project_id, member_id').in('id', entryIds);
    if (reviewError) return NextResponse.json({ error: reviewError.message }, { status: 500 });
    if ((reviewEntries || []).length !== entryIds.length) return NextResponse.json({ error: 'One or more time entries were not found' }, { status: 404 });
    if (reviewEntries?.some((entry) => entry.member_id === memberId)) return NextResponse.json({ error: 'You cannot approve your own time' }, { status: 409 });
    if (reviewEntries?.some((entry) => !accessAllowsProject(access, entry.project_id))) return NextResponse.json({ error: 'Project access denied' }, { status: 403 });
    const { data, error } = await client.rpc('review_time_entries', {
      p_entry_ids: entryIds,
      p_decision: body.decision,
      p_reason: body.reason || null,
    });
    if (error) {
      const status = error.message.includes('Compensation rate missing') ? 409 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    return NextResponse.json({ data });
  }

  if (action === 'schedule_rate') {
    if (!accessAllows(access, 'compensation.manage', 'app')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const target = String(body.member_id || '');
    const rate = Number(body.hourly_rate);
    const effectiveAt = String(body.effective_at || '');
    if (!target || !effectiveAt || !Number.isFinite(rate) || rate < 0) return NextResponse.json({ error: 'Valid member, rate, and effective date are required' }, { status: 422 });
    const { data: targetMember } = await service.from('team_members').select('role').eq('id', target).maybeSingle();
    if (!targetMember || ['owner', 'agent'].includes(targetMember.role)) return NextResponse.json({ error: 'Owners and AI agents cannot receive compensation rates' }, { status: 409 });
    const { data, error } = await service.rpc('schedule_team_member_hourly_rate', {
      p_member_id: target,
      p_hourly_rate: rate,
      p_effective_at: effectiveAt,
      p_created_by: memberId,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json({ data }, { status: 201 });
  }

  if (action === 'adjustment') {
    if (!accessAllows(access, 'compensation.manage', 'app')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const amount = Number(body.amount);
    const target = String(body.member_id || '');
    const effectiveDate = String(body.effective_date || '');
    if (!target || !effectiveDate || !['bonus', 'deduction'].includes(String(body.adjustment_type)) || !Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Valid member, type, amount, and effective date are required' }, { status: 422 });
    }
    const { data: targetMember } = await service.from('team_members').select('role').eq('id', target).maybeSingle();
    if (!targetMember || ['owner', 'agent'].includes(targetMember.role)) return NextResponse.json({ error: 'Owners and AI agents cannot receive earnings adjustments' }, { status: 409 });
    const { data, error } = await service.from('team_member_earning_adjustments').insert({
      member_id: target,
      adjustment_type: body.adjustment_type,
      amount,
      effective_date: effectiveDate,
      project_id: body.project_id || null,
      description: body.description || '',
      created_by: memberId,
    }).select().single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data }, { status: 201 });
  }

  if (action === 'payout') {
    if (!accessAllows(access, 'payouts.manage', 'app')) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    const payoutMemberId = String(body.member_id || '');
    const paymentDate = String(body.payment_date || '');
    const payoutAmount = Number(body.amount);
    if (!payoutMemberId || !paymentDate || !Number.isFinite(payoutAmount) || payoutAmount <= 0 || !Array.isArray(body.allocations) || body.allocations.length === 0) {
      return NextResponse.json({ error: 'Valid member, payment date, amount, and allocations are required' }, { status: 422 });
    }
    const { data: targetMember } = await service.from('team_members').select('role').eq('id', payoutMemberId).maybeSingle();
    if (!targetMember || ['owner', 'agent'].includes(targetMember.role)) return NextResponse.json({ error: 'Owners and AI agents cannot receive team payouts' }, { status: 409 });
    const { data, error } = await client.rpc('record_team_member_payout', {
      p_member_id: payoutMemberId,
      p_payment_date: paymentDate,
      p_amount: payoutAmount,
      p_payment_method: body.payment_method || '',
      p_reference: body.reference || '',
      p_notes: body.notes || '',
      p_allocations: body.allocations || [],
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ data }, { status: 201 });
  }

  return NextResponse.json({ error: 'Unsupported payroll action' }, { status: 400 });
}
