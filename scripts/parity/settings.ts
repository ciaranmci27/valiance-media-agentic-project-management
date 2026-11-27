import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { NextRequest } from 'next/server';
import type { Handler, Harness, Json } from './harness';
import { MEMBER_USER } from './harness';

/**
 * Your notification choices, the brand's logo and the pictures, and the
 * remaining settings and team routes over REST and MCP, each refused for a
 * caller without the permission and working with it: the revoke preview,
 * what a group controls, a member's profile on the API channel, AI provider
 * plans, the portal analytics exclusions, Resend invite (never answering
 * the link), sign-in email changes (an Owner for someone else, your own
 * password for yours, never an agent), and giving a company agent a power
 * beyond its role with its key (an Owner's key only, never a scope agents
 * never carry, never beyond what the calling key carries, logged).
 */
export async function settingsArea(h: Harness) {
  const { q, key, call, tool, toolNames, check, members, storage, setAuth } = h;
  const prefs = await import('../../src/app/api/v1/me/notification-preferences/route');
  const logo = await import('../../src/app/api/v1/workspace/brand/logo/route');
  const contactPhoto = await import('../../src/app/api/v1/contacts/[id]/photo/route');
  const agentPicture = await import('../../src/app/api/v1/agents/[id]/picture/route');
  const memberAvatar = await import('../../src/app/api/v1/team-members/[id]/avatar/route');
  const revoke = await import('../../src/app/api/v1/api-keys/[id]/revoke/route');
  const usage = await import('../../src/app/api/v1/groups/[id]/usage/route');
  const profile = await import('../../src/app/api/v1/team-members/[id]/profile/route');
  const plans = await import('../../src/app/api/v1/workspace/provider-plans/route');
  const exclusions = await import('../../src/app/api/v1/workspace/analytics-exclusions/route');
  const invite = await import('../../src/app/api/v1/team-members/[id]/invite/route');
  const memberEmail = await import('../../src/app/api/v1/team-members/[id]/email/route');
  const myEmail = await import('../../src/app/api/v1/me/email/route');
  const apiKeys = await import('../../src/app/api/v1/api-keys/route');
  const apiKey = await import('../../src/app/api/v1/api-keys/[id]/route');

  const one = async <T = { id: string }>(sql: string, params: unknown[] = []) => (await q<T>(sql, params))[0];
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  /** A multipart upload to a route that reads the request itself. */
  const upload = async (handler: Handler, secret: string, path: string, params: Record<string, string>, bytes: Uint8Array) => {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: 'image/png' }), 'picture.png');
    const response = await handler(new NextRequest(`http://localhost${path}`, { method: 'POST', headers: { 'x-api-key': secret }, body: form }), { params: Promise.resolve(params) as Promise<never> });
    const text = await response.text();
    return { status: response.status, json: (text ? JSON.parse(text) : {}) as Json };
  };
  const allow = (memberId: string, permissions: string[]) => q(`INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect)
    SELECT $1, k, 'api', 'allow' FROM unnest($2::text[]) AS k ON CONFLICT DO NOTHING`, [memberId, permissions]);
  const auditRow = async (endpoint: string) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await q<{ team_member_id: string; request_body: Record<string, unknown> | null }>('SELECT team_member_id, request_body FROM pm.api_audit_log WHERE endpoint = $1 ORDER BY timestamp DESC LIMIT 1', [endpoint]);
      if (rows[0]) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  };

  // A stand-in for Supabase Auth: reading and changing a login, and a password sign-in.
  const PASSWORD = 'correct horse battery';
  const users = new Map<string, { id: string; email: string; last_sign_in_at: string | null }>();
  for (const row of await q<{ id: string; email: string }>('SELECT id, email FROM auth.users')) users.set(row.id, { id: row.id, email: row.email, last_sign_in_at: '2026-11-01T00:00:00Z' });
  const updates: string[] = [];
  const readJson = async (request: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
  };
  const send = (response: ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
    return true;
  };
  const shape = (user: { id: string; email: string; last_sign_in_at: string | null }) => ({ id: user.id, aud: 'authenticated', email: user.email, last_sign_in_at: user.last_sign_in_at, app_metadata: {}, user_metadata: {}, identities: [], created_at: '2026-01-01T00:00:00Z' });
  setAuth(async (request, response, url) => {
    const single = /^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/.exec(url.pathname);
    if (single) {
      const user = users.get(single[1]);
      if (!user) return send(response, 404, { code: 'user_not_found', message: 'User not found' });
      if (request.method === 'PUT') {
        const body = await readJson(request);
        if (typeof body.email === 'string') { user.email = body.email; updates.push(user.id); }
      }
      return send(response, 200, shape(user));
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const body = await readJson(request);
      const user = [...users.values()].find((row) => row.email === body.email);
      if (!user || body.password !== PASSWORD) return send(response, 400, { code: 'invalid_credentials', error: 'invalid_grant', error_description: 'Invalid login credentials', message: 'Invalid login credentials' });
      return send(response, 200, { access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: shape(user) });
    }
    if (url.pathname === '/auth/v1/logout') { response.writeHead(204); response.end(); return true; }
    return send(response, 404, { message: `No fake for ${request.method} ${url.pathname}` });
  });
  const envBefore = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'fake-anon-key';

  const assistantsBefore = (await one<{ assistants_enabled: boolean }>('SELECT assistants_enabled FROM pm.business_settings LIMIT 1')).assistants_enabled;
  await q('UPDATE pm.business_settings SET assistants_enabled = true');
  const memberBefore = await one<{ email: string; notification_prefs: unknown; avatar: string | null }>('SELECT email, notification_prefs, avatar FROM pm.team_members WHERE id = $1', [members.member]);
  const brandBefore = (await one<Record<string, unknown>>('SELECT * FROM pm.workspace_brand LIMIT 1')) ?? null;
  const exclusionsBefore = (await one<{ excluded_ips: unknown }>('SELECT excluded_ips FROM pm.business_settings LIMIT 1')).excluded_ips;
  await allow(members.admin, ['settings.manage', 'team.manage', 'api_keys.manage_all', 'team.read']);

  const ownerKey = await key(members.owner, ['settings.manage', 'tasks.read', 'team.read', 'team.manage', 'contacts.manage', 'api_keys.manage_all', 'notifications.manage_own', 'files.upload', 'contacts.read', 'leads.read']);
  const ownerPlain = await key(members.owner, ['tasks.read']);
  const ownerTeamRead = await key(members.owner, ['team.read']);
  const adminKey = await key(members.admin, ['settings.manage', 'team.manage', 'api_keys.manage_all', 'tasks.read', 'files.upload', 'team.read']);
  const memberKey = await key(members.member, ['tasks.read', 'notifications.manage_own']);
  const agentKey = await key(members.agent, ['tasks.read', 'notifications.manage_own']);

  try {
    // ── Your notifications ─────────────────────────────────────────────
    const read = await call(prefs.GET, memberKey, 'GET', '/api/v1/me/notification-preferences');
    check('notification prefs: a member reads their own (all on by default in the app)', read.status === 200 && read.json.data?.in_app?.task_comments === true && read.json.data?.email_available === false, read.json);
    const changed = await call(prefs.PATCH, memberKey, 'PATCH', '/api/v1/me/notification-preferences', {}, { in_app: { task_comments: false } });
    const stored = await one<{ notification_prefs: Record<string, boolean> }>('SELECT notification_prefs FROM pm.team_members WHERE id = $1', [members.member]);
    check('notification prefs: turning one off stores it as the toggle does', changed.status === 200 && changed.json.data?.in_app?.task_comments === false && stored.notification_prefs?.task_comments === false, { changed: changed.json, stored });
    const noEmail = await call(prefs.PATCH, memberKey, 'PATCH', '/api/v1/me/notification-preferences', {}, { email_enabled: true });
    check('notification prefs: email cannot be turned on while the workspace sends none (409)', noEmail.status === 409 && noEmail.json.error?.details?.reason === 'email_not_set_up', noEmail.json);
    const unknown = await call(prefs.PATCH, memberKey, 'PATCH', '/api/v1/me/notification-preferences', {}, { in_app: { not_a_category: false } });
    check('notification prefs: an unknown category is a 422', unknown.status === 422, unknown.json);
    const noScope = await call(prefs.GET, ownerPlain, 'GET', '/api/v1/me/notification-preferences');
    check('notification prefs: a key without notifications.manage_own is refused (403)', noScope.status === 403, noScope.json);
    const onOver = await tool(memberKey, 'update_notification_preferences', { in_app: { task_comments: true } });
    const storedAgain = await one<{ notification_prefs: Record<string, boolean> }>('SELECT notification_prefs FROM pm.team_members WHERE id = $1', [members.member]);
    check('notification prefs mcp: turning it back on removes the entry (absent means on)', onOver.result.ok === true && !('task_comments' in (storedAgain.notification_prefs ?? {})), { onOver: onOver.result, storedAgain });

    // ── The brand's logo ───────────────────────────────────────────────
    const uploaded = await upload(logo.POST, ownerKey, '/api/v1/workspace/brand/logo?kind=light', {}, PNG);
    const brandRow = await one<{ logo_light_path: string | null }>('SELECT logo_light_path FROM pm.workspace_brand LIMIT 1');
    check('brand logo: an Owner uploads the logo, stored and pointed at', uploaded.status === 200 && !!brandRow?.logo_light_path
      && storage.objects.has(`pm-brand/${brandRow.logo_light_path}`), { uploaded: uploaded.json, brandRow });
    const adminUpload = await upload(logo.POST, adminKey, '/api/v1/workspace/brand/logo?kind=light', {}, PNG);
    check('brand logo: an admin holding settings.manage is refused, owner_only', adminUpload.status === 403 && adminUpload.json.error?.details?.reason === 'owner_only', adminUpload.json);
    const plainUpload = await upload(logo.POST, ownerPlain, '/api/v1/workspace/brand/logo?kind=light', {}, PNG);
    check('brand logo: an Owner\'s key without settings.manage is refused (403)', plainUpload.status === 403, plainUpload.json);
    const notImage = await upload(logo.POST, ownerKey, '/api/v1/workspace/brand/logo?kind=dark', {}, new Uint8Array([1, 2, 3, 4]));
    check('brand logo: a file that is not a PNG or JPG is a 415', notImage.status === 415, notImage.json);
    const removedOver = await tool(ownerKey, 'remove_brand_logo', { kind: 'light' });
    const brandAfter = await one<{ logo_light_path: string | null }>('SELECT logo_light_path FROM pm.workspace_brand LIMIT 1');
    check('brand logo mcp: remove_brand_logo removes it and its file', removedOver.result.ok === true && !brandAfter?.logo_light_path
      && !storage.objects.has(`pm-brand/${brandRow?.logo_light_path}`), { removed: removedOver.result, brandAfter });

    // ── Pictures ───────────────────────────────────────────────────────
    const contact = (await one("INSERT INTO pm.contacts (name, email) VALUES ('Parity Photo', 'photo@parity-client.example') RETURNING id")).id;
    const photo = await upload(contactPhoto.POST, ownerKey, `/api/v1/contacts/${contact}/photo`, { id: contact }, PNG);
    check('pictures: a contact\'s photo uploads where the app keeps it', photo.status === 200 && String(photo.json.data?.avatar_url ?? '').includes(`contacts/${contact}.jpg`)
      && storage.objects.has(`pm-avatars/contacts/${contact}.jpg`), photo.json);
    const photoRefused = await upload(contactPhoto.POST, memberKey, `/api/v1/contacts/${contact}/photo`, { id: contact }, PNG);
    check('pictures: a key without contacts.manage is refused (403)', photoRefused.status === 403, photoRefused.json);
    const picture = await upload(agentPicture.POST, ownerKey, `/api/v1/agents/${members.agent}/picture`, { id: members.agent }, PNG);
    const agentAvatar = await one<{ avatar: string }>('SELECT avatar FROM pm.team_members WHERE id = $1', [members.agent]);
    check('pictures: an Owner uploads an agent\'s picture', picture.status === 200 && agentAvatar.avatar.includes(`team/${members.agent}.jpg`), picture.json);
    const pictureRefused = await upload(agentPicture.POST, memberKey, `/api/v1/agents/${members.agent}/picture`, { id: members.agent }, PNG);
    check('pictures: a key without team.read is refused, nothing stored for it (403)', pictureRefused.status === 403, pictureRefused.json);
    const avatar = await upload(memberAvatar.POST, ownerKey, `/api/v1/team-members/${members.member}/avatar`, { id: members.member }, PNG);
    check('pictures: an Owner uploads a person\'s picture', avatar.status === 200 && String(avatar.json.data?.avatar ?? '').includes(`team/${members.member}.jpg`), avatar.json);
    const ownersPicture = await upload(memberAvatar.POST, adminKey, `/api/v1/team-members/${members.owner}/avatar`, { id: members.owner }, PNG);
    check('pictures: an Owner\'s picture only with that Owner\'s key (403 owner_protected)', ownersPicture.status === 403 && ownersPicture.json.error?.details?.reason === 'owner_protected'
      && !storage.objects.has(`pm-avatars/team/${members.owner}.jpg`), ownersPicture.json);

    // ── Keys, groups and people ────────────────────────────────────────
    const parent = (await one(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions)
      VALUES ('Parent key', 'pk_live', $1, $2, '{tasks.read}', 'scoped') RETURNING id`, [`h-${randomUUID()}`, members.owner])).id;
    const child = (await one(`INSERT INTO pm.api_keys (name, key_prefix, key_hash, team_member_id, scopes, permissions, created_by_key_id)
      VALUES ('Child key', 'pk_live', $1, $2, '{tasks.read}', 'scoped', $3) RETURNING id`, [`h-${randomUUID()}`, members.agent, parent])).id;
    const preview = await call(revoke.GET, ownerKey, 'GET', `/api/v1/api-keys/${parent}/revoke`, { id: parent });
    check('revoke preview: names the key it made, and revokes nothing', preview.status === 200 && (preview.json.data?.also ?? []).some((row: { id: string }) => row.id === child)
      && !(await one<{ revoked_at: string | null }>('SELECT revoked_at FROM pm.api_keys WHERE id = $1', [parent])).revoked_at, preview.json);
    const previewRefused = await call(revoke.GET, ownerPlain, 'GET', `/api/v1/api-keys/${parent}/revoke`, { id: parent });
    check('revoke preview: a key without api_keys.manage_all is refused (403)', previewRefused.status === 403, previewRefused.json);
    const previewOver = await tool(ownerKey, 'preview_api_key_revoke', { key_id: parent });
    check('revoke preview mcp: preview_api_key_revoke answers the same', previewOver.result.ok === true && (previewOver.result.data?.also ?? []).length === 1, previewOver.result);

    const group = (await one("INSERT INTO pm.groups (name, slug) VALUES ('Parity Support', 'parity-support') RETURNING id")).id;
    await q('UPDATE pm.team_members SET agent_escalate_to_group = $1 WHERE id = $2', [group, members.agent]);
    const used = await call(usage.GET, ownerKey, 'GET', `/api/v1/groups/${group}/usage`, { id: group });
    check('group usage: names the agent that escalates to it', used.status === 200 && JSON.stringify(used.json.data ?? {}).includes('Alexa'), used.json);
    const usedRefused = await call(usage.GET, memberKey, 'GET', `/api/v1/groups/${group}/usage`, { id: group });
    check('group usage: a key without team.read is refused (403)', usedRefused.status === 403, usedRefused.json);
    const usedOver = await tool(ownerKey, 'get_group_usage', { group_id: group });
    check('group usage mcp: get_group_usage answers it', usedOver.result.ok === true, usedOver.result);
    await q('UPDATE pm.team_members SET agent_escalate_to_group = NULL WHERE id = $1', [members.agent]);

    const full = await call(profile.GET, ownerKey, 'GET', `/api/v1/team-members/${members.member}/profile`, { id: members.member });
    const colleague = await call(profile.GET, ownerTeamRead, 'GET', `/api/v1/team-members/${members.member}/profile`, { id: members.member });
    check('member profile: team.manage on the key reads the full view, team.read alone a colleague\'s', full.status === 200 && full.json.data?.view === 'full' && !('activity' in (full.json.data ?? {}))
      && colleague.status === 200 && colleague.json.data?.view === 'colleague', { full: full.json.data?.view, colleague: colleague.json });
    const profileRefused = await call(profile.GET, memberKey, 'GET', `/api/v1/team-members/${members.owner}/profile`, { id: members.owner });
    check('member profile: a key without team.read is refused (403)', profileRefused.status === 403, profileRefused.json);
    const profileOver = await tool(ownerKey, 'get_member_profile', { team_member_id: members.member });
    check('member profile mcp: get_member_profile reads it', profileOver.result.ok === true && profileOver.result.data?.member?.id === members.member, profileOver.result);

    // ── AI provider plans and analytics exclusions ─────────────────────
    const planMade = await call(plans.PUT, ownerKey, 'PUT', '/api/v1/workspace/provider-plans', {}, { provider: 'OpenAI', monthly_cost_usd: 200, seats: 2 });
    const planAgain = await call(plans.PUT, ownerKey, 'PUT', '/api/v1/workspace/provider-plans', {}, { provider: 'openai', monthly_cost_usd: 250 });
    check('provider plans: an Owner adds a plan, and saving the provider again (any case) changes it', planMade.status === 200 && planMade.json.data?.created === true
      && planAgain.status === 200 && planAgain.json.data?.created === false && (await q('SELECT 1 FROM pm.provider_plans')).length === 1, { planMade: planMade.json, planAgain: planAgain.json });
    const planAdmin = await call(plans.PUT, adminKey, 'PUT', '/api/v1/workspace/provider-plans', {}, { provider: 'Anthropic', monthly_cost_usd: 100 });
    check('provider plans: an admin holding settings.manage is refused, owner_only', planAdmin.status === 403 && planAdmin.json.error?.details?.reason === 'owner_only', planAdmin.json);
    const planList = await call(plans.GET, memberKey, 'GET', '/api/v1/workspace/provider-plans');
    check('provider plans: a member reads them', planList.status === 200 && planList.json.data?.length === 1, planList.json);
    const planGone = await tool(ownerKey, 'remove_provider_plan', { plan_id: planMade.json.data?.id });
    check('provider plans mcp: remove_provider_plan removes it', planGone.result.ok === true && (await q('SELECT 1 FROM pm.provider_plans')).length === 0, planGone.result);

    const setIps = await call(exclusions.PUT, ownerKey, 'PUT', '/api/v1/workspace/analytics-exclusions', {}, { excluded_ips: [{ ip: '203.0.113.7', label: 'Office' }] });
    check('analytics exclusions: settings.manage replaces the list', setIps.status === 200
      && JSON.stringify((await one<{ excluded_ips: unknown }>('SELECT excluded_ips FROM pm.business_settings LIMIT 1')).excluded_ips).includes('203.0.113.7'), setIps.json);
    const badIp = await call(exclusions.PUT, ownerKey, 'PUT', '/api/v1/workspace/analytics-exclusions', {}, { excluded_ips: [{ ip: 'not-an-ip', label: 'x' }] });
    check('analytics exclusions: something that is not an IP is a 422', badIp.status === 422, badIp.json);
    const ipsRefused = await call(exclusions.GET, ownerPlain, 'GET', '/api/v1/workspace/analytics-exclusions');
    check('analytics exclusions: a key without settings.manage is refused (403)', ipsRefused.status === 403, ipsRefused.json);
    const ipsOver = await tool(ownerKey, 'get_analytics_exclusions', {});
    check('analytics exclusions mcp: get_analytics_exclusions reads it', ipsOver.result.ok === true && ipsOver.result.data?.excluded_ips?.[0]?.label === 'Office', ipsOver.result);

    // ── Resend invite ──────────────────────────────────────────────────
    const inviteeUser = randomUUID();
    await q("INSERT INTO auth.users (id, email) VALUES ($1, 'invitee@parity.example')", [inviteeUser]);
    users.set(inviteeUser, { id: inviteeUser, email: 'invitee@parity.example', last_sign_in_at: null });
    const invitee = (await one<{ id: string }>('SELECT id FROM pm.team_members WHERE auth_user_id = $1', [inviteeUser])).id;
    const noMail = await call(invite.POST, ownerKey, 'POST', `/api/v1/team-members/${invitee}/invite`, { id: invitee });
    check('resend invite: refused before a new link is made while no email can go out (409)', noMail.status === 409 && noMail.json.error?.details?.reason === 'email_not_set_up'
      && (await q('SELECT 1 FROM pm.team_invites WHERE member_id = $1', [invitee])).length === 0, noMail.json);
    // An account that cannot really send: the mail fails fast, the link stays out of the answer either way.
    await q("INSERT INTO pm.smtp_accounts (label, host, port, username, encrypted_password, from_name, from_email, is_default) VALUES ('Parity', '127.0.0.1', 1, 'u', 'not-encrypted', 'Parity', 'no-reply@parity.example', true)");
    const resent = await tool(ownerKey, 'resend_invite', { team_member_id: invitee });
    check('resend invite mcp: a fresh link is made and never answered', resent.result.ok === true && (await q('SELECT 1 FROM pm.team_invites WHERE member_id = $1', [invitee])).length === 1
      && !JSON.stringify(resent.result).includes('token=') && typeof resent.result.data?.email_status === 'string', resent.result);
    const agentInvite = await call(invite.POST, ownerKey, 'POST', `/api/v1/team-members/${members.agent}/invite`, { id: members.agent });
    check('resend invite: an agent\'s link is never sent over the API (422)', agentInvite.status === 422 && agentInvite.json.error?.details?.reason === 'agent_link_only', agentInvite.json);
    const inviteRefused = await call(invite.POST, memberKey, 'POST', `/api/v1/team-members/${invitee}/invite`, { id: invitee });
    check('resend invite: a key without team.manage is refused (403)', inviteRefused.status === 403, inviteRefused.json);

    // ── Sign-in emails ─────────────────────────────────────────────────
    const byAdmin = await call(memberEmail.POST, adminKey, 'POST', `/api/v1/team-members/${members.member}/email`, { id: members.member }, { new_email: 'taken-over@parity.example' });
    check('sign-in email: an admin holding team.manage cannot change someone\'s (403 owner_only)', byAdmin.status === 403 && byAdmin.json.error?.details?.reason === 'owner_only'
      && !updates.includes(MEMBER_USER), byAdmin.json);
    const byOwner = await tool(ownerKey, 'change_member_email', { team_member_id: members.member, new_email: 'max.new@parity.example' });
    check('sign-in email mcp: an Owner changes a member\'s, login and row both', byOwner.result.ok === true && updates.includes(MEMBER_USER)
      && (await one<{ email: string }>('SELECT email FROM pm.team_members WHERE id = $1', [members.member])).email === 'max.new@parity.example', byOwner.result);
    const ownSelf = await call(memberEmail.POST, ownerKey, 'POST', `/api/v1/team-members/${members.owner}/email`, { id: members.owner }, { new_email: 'olive.new@parity.example' });
    check('sign-in email: your own goes through /me/email (422 use_me_email)', ownSelf.status === 422 && ownSelf.json.error?.details?.reason === 'use_me_email', ownSelf.json);
    await q("UPDATE auth.users SET encrypted_password = 'hashed' WHERE id = $1", [MEMBER_USER]);
    const wrong = await call(myEmail.POST, memberKey, 'POST', '/api/v1/me/email', {}, { new_email: 'max.mine@parity.example', current_password: 'guess' });
    check('sign-in email: your own with a wrong password is refused (403 wrong_password)', wrong.status === 403 && wrong.json.error?.details?.reason === 'wrong_password', wrong.json);
    const right = await call(myEmail.POST, memberKey, 'POST', '/api/v1/me/email', {}, { new_email: 'max.mine@parity.example', current_password: PASSWORD });
    const myAudit = await auditRow('/api/v1/me/email');
    check('sign-in email: your own with your password changes it; the audit row never holds the password', right.status === 200 && right.json.data?.email === 'max.mine@parity.example'
      && !!myAudit && !JSON.stringify(myAudit.request_body ?? {}).includes(PASSWORD), { right: right.json, myAudit });
    const agentSelf = await call(myEmail.POST, agentKey, 'POST', '/api/v1/me/email', {}, { new_email: 'alexa.new@parity.example', current_password: PASSWORD });
    check('sign-in email: an agent never changes a sign-in email (403 people_only)', agentSelf.status === 403 && agentSelf.json.error?.details?.reason === 'people_only', agentSelf.json);
    const memberTools = await toolNames(memberKey);
    check('sign-in email mcp: your own email change has no tool (it takes your password)', !memberTools.some((n) => /email/.test(n) && /my|own|change/.test(n)), memberTools.filter((n) => /email/.test(n)));

    // ── Powers beyond an agent's role, with its key ────────────────────
    const plainAsk = await call(apiKeys.POST, ownerKey, 'POST', '/api/v1/api-keys', {}, { member_id: members.agent, name: 'Uploader', scopes: ['tasks.read', 'files.upload'] });
    check('beyond role: without give_beyond_role a scope the agent lacks is refused (422 scope_not_held)', plainAsk.status === 422 && plainAsk.json.error?.details?.reason === 'scope_not_held', plainAsk.json);
    const given = await call(apiKeys.POST, ownerKey, 'POST', '/api/v1/api-keys', {}, { member_id: members.agent, name: 'Uploader', scopes: ['tasks.read', 'files.upload'], give_beyond_role: true });
    const grant = await q("SELECT effect FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'files.upload' AND access_channel = 'api'", [members.agent]);
    const givenAudit = await auditRow('/api/v1/api-keys');
    check('beyond role: an Owner\'s key gives the agent the power with its key, answered and logged', given.status === 201 && JSON.stringify(given.json.data?.scopes_given) === '["files.upload"]'
      && grant.length === 1 && JSON.stringify(givenAudit?.request_body?.scopes_given) === '["files.upload"]', { given: given.json, grant, givenAudit });
    const never = await call(apiKeys.POST, ownerKey, 'POST', '/api/v1/api-keys', {}, { member_id: members.agent, name: 'Settings', scopes: ['settings.manage'], give_beyond_role: true });
    check('beyond role: never a scope agents never carry (422 scope_never_for_agents)', never.status === 422 && never.json.error?.details?.reason === 'scope_never_for_agents', never.json);
    const notCarried = await call(apiKeys.POST, ownerKey, 'POST', '/api/v1/api-keys', {}, { member_id: members.agent, name: 'Leads', scopes: ['leads.manage'], give_beyond_role: true });
    check('beyond role: never beyond what the calling key carries (403 scope_escalation)', notCarried.status === 403 && notCarried.json.error?.details?.reason === 'scope_escalation'
      && (await q("SELECT 1 FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'leads.manage'", [members.agent])).length === 0, notCarried.json);
    const byAdminKey = await call(apiKeys.POST, adminKey, 'POST', '/api/v1/api-keys', {}, { member_id: members.agent, name: 'Admin uploader', scopes: ['team.read'], give_beyond_role: true });
    check('beyond role: an admin\'s key is refused (403), nothing given', byAdminKey.status === 403
      && (await q("SELECT 1 FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'team.read' AND access_channel = 'api'", [members.agent])).length === 0, byAdminKey.json);
    const personal = await call(apiKeys.POST, ownerKey, 'POST', '/api/v1/api-keys', {}, { member_id: members.personal, name: 'PA', scopes: ['contacts.read'], give_beyond_role: true });
    check('beyond role: never a personal agent (422 beyond_role_agents_only)', personal.status === 422 && personal.json.error?.details?.reason === 'beyond_role_agents_only', personal.json);
    const keyId = given.json.data?.key?.id as string;
    const edited = await call(apiKey.PATCH, ownerKey, 'PATCH', `/api/v1/api-keys/${keyId}`, { id: keyId }, { scopes: ['tasks.read', 'files.upload', 'contacts.read'], give_beyond_role: true });
    check('beyond role: editing the key gives one more, answered as scopes_given', edited.status === 200 && JSON.stringify(edited.json.data?.scopes_given) === '["contacts.read"]'
      && (edited.json.data?.scopes ?? []).includes('contacts.read'), edited.json);
    const editPlain = await call(apiKey.PATCH, ownerKey, 'PATCH', `/api/v1/api-keys/${keyId}`, { id: keyId }, { scopes: ['tasks.read', 'files.upload', 'contacts.read', 'leads.read'] });
    check('beyond role: an edit without give_beyond_role still refuses a scope the agent lacks', editPlain.status === 422, editPlain.json);
    const editOver = await tool(ownerKey, 'update_api_key', { key_id: keyId, scopes: ['tasks.read', 'files.upload', 'contacts.read', 'leads.read'], give_beyond_role: true });
    check('beyond role mcp: update_api_key with give_beyond_role gives it', editOver.result.ok === true
      && (await q("SELECT 1 FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'leads.read' AND access_channel = 'api' AND effect = 'allow'", [members.agent])).length === 1, editOver.result);
    await q("UPDATE pm.api_keys SET revoked_at = now() WHERE id = $1", [keyId]);
    await q("DELETE FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key IN ('files.upload', 'contacts.read', 'leads.read') AND access_channel = 'api'", [members.agent]);
  } finally {
    setAuth(null);
    if (envBefore === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = envBefore;
    await q('DELETE FROM pm.smtp_accounts');
    await q('UPDATE pm.business_settings SET assistants_enabled = $1, excluded_ips = $2', [assistantsBefore, JSON.stringify(exclusionsBefore ?? [])]);
    await q('UPDATE pm.team_members SET email = $1, notification_prefs = $2, avatar = $3 WHERE id = $4', [memberBefore.email, JSON.stringify(memberBefore.notification_prefs ?? {}), memberBefore.avatar, members.member]);
    await q("UPDATE auth.users SET encrypted_password = NULL WHERE id = $1", [MEMBER_USER]);
    if (!brandBefore) await q('DELETE FROM pm.workspace_brand');
  }
}
