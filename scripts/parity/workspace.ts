import type { Harness } from './harness';

/**
 * Pause every agent and workspace settings: an Owner's key with
 * settings.manage reads and changes each switch (modules, brand, region,
 * keeping data, the audit log's settings, key lifetimes, webhook retries,
 * the pause on every agent) by the same writers as Settings; anyone else
 * (a key without the scope, an admin who holds it but is not an Owner) is
 * refused; agents are stopped by the pause and cannot lift it; the audit log
 * reads over MCP. Every setting changed here is put back at the end, since
 * the other areas run after this one on the same database.
 */
export async function workspaceArea(h: Harness) {
  const { q, key, call, tool, toolNames, check, members } = h;
  const pause = await import('../../src/app/api/v1/agents/pause-all/route');
  const modules = await import('../../src/app/api/v1/workspace/modules/route');
  const brand = await import('../../src/app/api/v1/workspace/brand/route');
  const region = await import('../../src/app/api/v1/workspace/region/route');
  const retention = await import('../../src/app/api/v1/workspace/data-retention/route');
  const auditSettings = await import('../../src/app/api/v1/workspace/audit-settings/route');
  const preview = await import('../../src/app/api/v1/workspace/retention-preview/route');
  const keySettings = await import('../../src/app/api/v1/workspace/key-settings/route');
  const personalKeys = await import('../../src/app/api/v1/workspace/key-settings/personal/route');
  const retries = await import('../../src/app/api/v1/workspace/webhook-retries/route');
  const auditLog = await import('../../src/app/api/v1/audit-log/route');
  const { MODULE_IDS } = await import('../../src/lib/modules/registry');
  const { resetWebhookRetriesCheck } = await import('../../src/lib/webhooks/retries');

  const OWNER_SCOPES = ['settings.manage', 'tasks.read', 'audit.read'];
  const ownerKey = await key(members.owner, OWNER_SCOPES);
  const ownerPlain = await key(members.owner, ['tasks.read']);
  // An admin who holds settings.manage on the API by a per-member allow: past withApi, refused for not being an Owner.
  await q("INSERT INTO pm.team_member_permissions (member_id, permission_key, access_channel, effect) VALUES ($1, 'settings.manage', 'api', 'allow') ON CONFLICT DO NOTHING", [members.admin]);
  const adminKey = await key(members.admin, ['settings.manage', 'tasks.read']);
  const memberKey = await key(members.member, ['tasks.read']);
  const agentKey = await key(members.agent, ['tasks.read', 'tasks.manage_assigned']);

  const settingsRow = async () => (await q<Record<string, unknown>>('SELECT * FROM pm.business_settings LIMIT 1'))[0] ?? {};
  const before = await settingsRow();
  const brandRowBefore = (await q<Record<string, unknown>>('SELECT * FROM pm.workspace_brand LIMIT 1'))[0] ?? null;
  const regionRowBefore = (await q<Record<string, unknown>>('SELECT * FROM pm.workspace_region LIMIT 1'))[0] ?? null;
  const auditRow = async (endpoint: string) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const rows = await q<{ team_member_id: string; via: string }>('SELECT team_member_id, via FROM pm.api_audit_log WHERE endpoint = $1 ORDER BY timestamp DESC LIMIT 1', [endpoint]);
      if (rows[0]) return rows[0];
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  };

  try {
    // ── Pause every agent ──────────────────────────────────────────────
    const read = await call(pause.GET, memberKey, 'GET', '/api/v1/agents/pause-all');
    check('workspace pause: a member\'s key reads the switch (off)', read.status === 200 && read.json.data?.paused_at === null, read.json);
    const plainPut = await call(pause.PUT, ownerPlain, 'PUT', '/api/v1/agents/pause-all', {}, { paused: true });
    check('workspace pause: an Owner\'s key without settings.manage is refused (403)', plainPut.status === 403, plainPut.json);
    const adminPut = await call(pause.PUT, adminKey, 'PUT', '/api/v1/agents/pause-all', {}, { paused: true });
    check('workspace pause: an admin holding settings.manage is refused, owner_only', adminPut.status === 403 && adminPut.json.error?.details?.reason === 'owner_only', adminPut.json);

    const paused = await call(pause.PUT, ownerKey, 'PUT', '/api/v1/agents/pause-all', {}, { paused: true });
    const pausedRow = await settingsRow();
    check('workspace pause: the Owner pauses every agent, recorded as them', paused.status === 200 && !!paused.json.data?.paused_at
      && paused.json.data?.paused_by?.id === members.owner && !!pausedRow.agents_paused_at && pausedRow.agents_paused_by === members.owner, paused.json);
    const agentLift = await call(pause.PUT, agentKey, 'PUT', '/api/v1/agents/pause-all', {}, { paused: false });
    check('workspace pause: while paused an agent\'s write answers 423 agents_paused (it cannot lift it)', agentLift.status === 423 && agentLift.json.error?.details?.reason === 'agents_paused', agentLift.json);
    const agentRead = await call(pause.GET, agentKey, 'GET', '/api/v1/agents/pause-all');
    check('workspace pause: an agent still reads that it is paused', agentRead.status === 200 && !!agentRead.json.data?.paused_at, agentRead.json);
    const pauseAudit = await auditRow('/api/v1/agents/pause-all');
    check('workspace pause: the change is in the audit log as the Owner\'s key', pauseAudit?.team_member_id === members.owner && pauseAudit?.via === 'rest', pauseAudit);
    const resumed = await call(pause.PUT, ownerKey, 'PUT', '/api/v1/agents/pause-all', {}, { paused: false });
    check('workspace pause: the Owner resumes them', resumed.status === 200 && resumed.json.data?.paused_at === null && !(await settingsRow()).agents_paused_at, resumed.json);

    const ownerTools = await toolNames(ownerKey);
    const memberTools = await toolNames(memberKey);
    check('workspace pause mcp: the Owner\'s key lists set_agents_pause, a member\'s does not (but reads it)', ownerTools.includes('set_agents_pause')
      && !memberTools.includes('set_agents_pause') && memberTools.includes('get_agents_pause'), { memberTools: memberTools.filter((n) => /pause|workspace/.test(n)) });
    const pausedOver = await tool(ownerKey, 'set_agents_pause', { paused: true });
    const stateOver = await tool(memberKey, 'get_agents_pause', {});
    check('workspace pause mcp: set_agents_pause pauses, get_agents_pause shows it', pausedOver.result.ok === true && !!stateOver.result.data?.paused_at, { pausedOver: pausedOver.result, stateOver: stateOver.result });
    const resumedOver = await tool(ownerKey, 'set_agents_pause', { paused: false });
    check('workspace pause mcp: and resumes', resumedOver.result.ok === true && resumedOver.result.data?.paused_at === null, resumedOver.result);

    // ── Modules ────────────────────────────────────────────────────────
    const modulesBefore = await call(modules.GET, ownerKey, 'GET', '/api/v1/workspace/modules');
    check('workspace modules: the Owner reads the switches', modulesBefore.status === 200 && Array.isArray(modulesBefore.json.data?.modules), modulesBefore.json);
    const adminModules = await call(modules.GET, adminKey, 'GET', '/api/v1/workspace/modules');
    check('workspace modules: an admin is refused, owner_only', adminModules.status === 403 && adminModules.json.error?.details?.reason === 'owner_only', adminModules.json);
    const memberModules = await call(modules.PUT, memberKey, 'PUT', '/api/v1/workspace/modules', {}, { modules: [...MODULE_IDS] });
    check('workspace modules: a key without settings.manage is refused (403)', memberModules.status === 403, memberModules.json);
    const badModule = await call(modules.PUT, ownerKey, 'PUT', '/api/v1/workspace/modules', {}, { modules: ['time', 'spaceships'] });
    check('workspace modules: an unknown module is a 422', badModule.status === 422, badModule.json);
    // Contacts off with Sales on: Sales needs Contacts, so it stays off too.
    const fewer = await call(modules.PUT, ownerKey, 'PUT', '/api/v1/workspace/modules', {}, { modules: MODULE_IDS.filter((id) => id !== 'contacts' && id !== 'portal') });
    const offRows = (await q<{ module_id: string }>('SELECT module_id FROM pm.workspace_modules WHERE enabled = false')).map((r) => r.module_id).sort();
    check('workspace modules: switching off keeps dependencies whole (sales goes with contacts)', fewer.status === 200
      && !fewer.json.data?.modules.includes('sales') && JSON.stringify(offRows) === JSON.stringify(['contacts', 'portal', 'sales']), { answer: fewer.json, offRows });
    const modulesAudit = await auditRow('/api/v1/workspace/modules');
    check('workspace modules: the switch is audited as the Owner\'s key', modulesAudit?.team_member_id === members.owner, modulesAudit);
    const allOn = await tool(ownerKey, 'set_workspace_modules', { modules: [...MODULE_IDS] });
    const stillOff = await q('SELECT module_id FROM pm.workspace_modules WHERE enabled = false');
    check('workspace modules mcp: set_workspace_modules switches every module back on', allOn.result.ok === true && stillOff.length === 0, { allOn: allOn.result, stillOff });
    const modulesOver = await tool(ownerKey, 'get_workspace_modules', {});
    check('workspace modules mcp: get_workspace_modules reads them', modulesOver.result.ok === true && modulesOver.result.data?.modules?.length === MODULE_IDS.length, modulesOver.result);

    // ── Brand ──────────────────────────────────────────────────────────
    const brandBefore = await call(brand.GET, ownerKey, 'GET', '/api/v1/workspace/brand');
    check('workspace brand: the Owner reads the brand', brandBefore.status === 200 && !!brandBefore.json.data?.settings && !!brandBefore.json.data?.defaults, brandBefore.json);
    const storedBrand = brandBefore.json.data?.settings ?? {};
    const named = await call(brand.PATCH, ownerKey, 'PATCH', '/api/v1/workspace/brand', {}, { name: 'Parity Test Workshop', accentColor: '#c5a68f' });
    const brandRow = (await q<{ name: string | null; accent_color: string | null; brand_color: string | null }>('SELECT name, accent_color, brand_color FROM pm.workspace_brand LIMIT 1'))[0];
    check('workspace brand: PATCH changes only what it sends (name, accent), the rest stays', named.status === 200 && named.json.data?.settings?.name === 'Parity Test Workshop'
      && brandRow?.name === 'Parity Test Workshop' && brandRow?.accent_color === '#C5A68F' && (brandRow?.brand_color ?? null) === (storedBrand.brandColor ?? null), { answer: named.json, brandRow });
    const badColor = await call(brand.PATCH, ownerKey, 'PATCH', '/api/v1/workspace/brand', {}, { brandColor: 'teal-ish' });
    check('workspace brand: a color that is not hex is a 400 in Settings\' words', badColor.status === 400 && /hex color/.test(badColor.json.error?.message ?? ''), badColor.json);
    const adminBrand = await call(brand.PATCH, adminKey, 'PATCH', '/api/v1/workspace/brand', {}, { name: 'Ada was here' });
    check('workspace brand: an admin is refused, owner_only', adminBrand.status === 403 && adminBrand.json.error?.details?.reason === 'owner_only', adminBrand.json);
    const brandOver = await tool(ownerKey, 'update_workspace_brand', { tagline: 'Built by parity', sidebar_projects: 'menu' });
    const taglineRow = (await q<{ tagline: string | null; sidebar_projects: string | null; name: string | null }>('SELECT tagline, sidebar_projects, name FROM pm.workspace_brand LIMIT 1'))[0];
    check('workspace brand mcp: update_workspace_brand saves tagline and sidebar, keeps the name', brandOver.result.ok === true
      && taglineRow?.tagline === 'Built by parity' && taglineRow?.sidebar_projects === 'menu' && taglineRow?.name === 'Parity Test Workshop', { result: brandOver.result, taglineRow });
    const brandBack = await call(brand.PATCH, ownerKey, 'PATCH', '/api/v1/workspace/brand', {}, {
      name: storedBrand.name ?? null, tagline: storedBrand.tagline ?? null, description: storedBrand.description ?? null,
      brandColor: storedBrand.brandColor ?? null, accentColor: storedBrand.accentColor ?? null, brandShades: storedBrand.brandShades ?? null,
      invertLogoInSidebar: storedBrand.invertLogoInSidebar ?? false, showNameUnderLogo: storedBrand.showNameUnderLogo ?? false,
      ...(storedBrand.sidebarProjects ? { sidebarProjects: storedBrand.sidebarProjects } : {}),
      ...(typeof storedBrand.sidebarActiveProjects === 'boolean' ? { sidebarActiveProjects: storedBrand.sidebarActiveProjects } : {}),
    });
    check('workspace brand: put back as it was', brandBack.status === 200 && (brandBack.json.data?.settings?.name ?? null) === (storedBrand.name ?? null), brandBack.json);

    // ── Region ─────────────────────────────────────────────────────────
    const regionBefore = await call(region.GET, ownerKey, 'GET', '/api/v1/workspace/region');
    check('workspace region: the Owner reads the region', regionBefore.status === 200 && !!regionBefore.json.data?.region?.currency, regionBefore.json);
    const storedRegion = regionBefore.json.data?.region ?? { currency: 'USD', locale: 'en-US', weekStart: 1 };
    const euro = await call(region.PATCH, ownerKey, 'PATCH', '/api/v1/workspace/region', {}, { currency: 'EUR' });
    const regionRow = (await q<{ currency: string; locale: string }>('SELECT currency, locale FROM pm.workspace_region LIMIT 1'))[0];
    check('workspace region: PATCH currency keeps the locale, saved', euro.status === 200 && euro.json.data?.region?.currency === 'EUR'
      && regionRow?.currency === 'EUR' && regionRow?.locale === storedRegion.locale, { answer: euro.json, regionRow });
    const badCurrency = await call(region.PATCH, ownerKey, 'PATCH', '/api/v1/workspace/region', {}, { currency: 'EURO' });
    check('workspace region: a currency that is not ISO 4217 is a 400', badCurrency.status === 400, badCurrency.json);
    const memberRegion = await call(region.GET, memberKey, 'GET', '/api/v1/workspace/region');
    check('workspace region: a key without settings.manage is refused (403)', memberRegion.status === 403, memberRegion.json);
    const sunday = await tool(ownerKey, 'update_workspace_region', { week_start: 0 });
    check('workspace region mcp: update_workspace_region sets the week start', sunday.result.ok === true && sunday.result.data?.region?.weekStart === 0, sunday.result);
    const regionBack = await call(region.PATCH, ownerKey, 'PATCH', '/api/v1/workspace/region', {}, storedRegion);
    check('workspace region: put back as it was', regionBack.status === 200 && regionBack.json.data?.region?.currency === storedRegion.currency, regionBack.json);

    // ── Keeping data ───────────────────────────────────────────────────
    const retentionBefore = await call(retention.GET, ownerKey, 'GET', '/api/v1/workspace/data-retention');
    check('workspace retention: the Owner reads every setting', retentionBefore.status === 200 && 'chat_retention_days' in (retentionBefore.json.data ?? {}), retentionBefore.json);
    const chat = await call(retention.PUT, ownerKey, 'PUT', '/api/v1/workspace/data-retention', {}, { chat_retention_days: 45 });
    check('workspace retention: PUT saves one setting', chat.status === 200 && chat.json.data?.chat_retention_days === 45 && (await settingsRow()).chat_retention_days === 45, chat.json);
    const tooShort = await call(retention.PUT, ownerKey, 'PUT', '/api/v1/workspace/data-retention', {}, { agent_run_retention_days: 3 });
    check('workspace retention: below a setting\'s minimum is a 422', tooShort.status === 422, tooShort.json);
    const adminRetention = await call(retention.GET, adminKey, 'GET', '/api/v1/workspace/data-retention');
    check('workspace retention: an admin is refused, owner_only', adminRetention.status === 403 && adminRetention.json.error?.details?.reason === 'owner_only', adminRetention.json);
    const retentionOver = await tool(ownerKey, 'update_data_retention', { chat_retention_days: (retentionBefore.json.data?.chat_retention_days as number | null) ?? null });
    check('workspace retention mcp: update_data_retention puts chat text back', retentionOver.result.ok === true
      && ((await settingsRow()).chat_retention_days ?? null) === (before.chat_retention_days ?? null), retentionOver.result);

    // ── Audit ──────────────────────────────────────────────────────────
    const auditBefore = await call(auditSettings.GET, ownerKey, 'GET', '/api/v1/workspace/audit-settings');
    check('workspace audit settings: the Owner reads them', auditBefore.status === 200 && Array.isArray(auditBefore.json.data?.redact_keys), auditBefore.json);
    const kept = await call(auditSettings.PUT, ownerKey, 'PUT', '/api/v1/workspace/audit-settings', {}, { retention_days: 400, redact_keys: ['parity_secret_field'] });
    const keptRow = await settingsRow();
    check('workspace audit settings: PUT saves retention and redacted names', kept.status === 200 && kept.json.data?.retention_days === 400
      && keptRow.audit_retention_days === 400 && JSON.stringify(keptRow.audit_redact_keys) === JSON.stringify(['parity_secret_field']), kept.json);
    const adminAudit = await call(auditSettings.PUT, adminKey, 'PUT', '/api/v1/workspace/audit-settings', {}, { retention_days: 30 });
    check('workspace audit settings: an admin is refused, owner_only', adminAudit.status === 403 && adminAudit.json.error?.details?.reason === 'owner_only', adminAudit.json);
    const auditBack = await tool(ownerKey, 'update_audit_settings', {
      retention_days: auditBefore.json.data?.retention_days ?? null, redact_keys: auditBefore.json.data?.redact_keys ?? [],
    });
    check('workspace audit settings mcp: update_audit_settings puts them back', auditBack.result.ok === true
      && ((await settingsRow()).audit_retention_days ?? null) === (before.audit_retention_days ?? null), auditBack.result);

    const counted = await call(preview.POST, ownerKey, 'POST', '/api/v1/workspace/retention-preview', {}, { audit_retention_days: 30, chat_retention_days: null });
    check('workspace retention preview: counts per setting, null for forever', counted.status === 200 && typeof counted.json.data?.rows?.audit_retention_days === 'number'
      && counted.json.data?.rows?.chat_retention_days === null, counted.json);
    const adminPreview = await call(preview.POST, adminKey, 'POST', '/api/v1/workspace/retention-preview', {}, { audit_retention_days: 30 });
    check('workspace retention preview: an admin is refused, owner_only', adminPreview.status === 403, adminPreview.json);
    const previewOver = await tool(ownerKey, 'preview_retention', { audit_retention_days: 30 });
    check('workspace retention preview mcp: preview_retention answers counts', previewOver.result.ok === true && typeof previewOver.result.data?.rows?.audit_retention_days === 'number', previewOver.result);

    const ENTITY = '0b7a0b7a-0000-4000-8000-00000000a0d1';
    await q(`INSERT INTO pm.api_audit_log (method, endpoint, entity_type, entity_id, team_member_id, status_code, via)
      VALUES ('PATCH', '/api/v1/parity-widgets', 'parity_widget', $1, $2, 200, 'rest')`, [ENTITY, members.owner]);
    const logged = await tool(ownerKey, 'list_audit_log', { entity_type: 'parity_widget' });
    check('workspace audit mcp: list_audit_log filters by entity type', logged.result.ok === true && logged.result.data?.length === 1 && logged.result.data[0].entity_id === ENTITY, logged.result);
    const history = await tool(ownerKey, 'get_audit_history', { entity_type: 'parity_widget', entity_id: ENTITY });
    check('workspace audit mcp: get_audit_history reads one record\'s history', history.result.ok === true && history.result.data?.length === 1, history.result);
    const noAudit = await call(auditLog.GET, memberKey, 'GET', '/api/v1/audit-log');
    check('workspace audit: a key without audit.read is refused (403), and the tool is not listed for it', noAudit.status === 403 && !memberTools.includes('list_audit_log'), noAudit.json);

    // ── Key lifetimes ──────────────────────────────────────────────────
    const lifetimeBefore = await call(keySettings.GET, ownerKey, 'GET', '/api/v1/workspace/key-settings');
    check('workspace keys: the Owner reads the agent key lifetime', lifetimeBefore.status === 200 && 'agent_key_lifetime_days' in (lifetimeBefore.json.data ?? {}), lifetimeBefore.json);
    const ninety = await call(keySettings.PATCH, ownerKey, 'PATCH', '/api/v1/workspace/key-settings', {}, { agent_key_lifetime_days: 90 });
    check('workspace keys: PATCH saves it', ninety.status === 200 && ninety.json.data?.agent_key_lifetime_days === 90 && (await settingsRow()).agent_key_lifetime_days === 90, ninety.json);
    const adminLifetime = await call(keySettings.PATCH, adminKey, 'PATCH', '/api/v1/workspace/key-settings', {}, { agent_key_lifetime_days: 1 });
    check('workspace keys: an admin is refused, owner_only', adminLifetime.status === 403 && adminLifetime.json.error?.details?.reason === 'owner_only', adminLifetime.json);
    const lifetimeBack = await tool(ownerKey, 'update_key_settings', { agent_key_lifetime_days: lifetimeBefore.json.data?.agent_key_lifetime_days ?? null });
    check('workspace keys mcp: update_key_settings puts it back', lifetimeBack.result.ok === true
      && ((await settingsRow()).agent_key_lifetime_days ?? null) === (before.agent_key_lifetime_days ?? null), lifetimeBack.result);
    const personalRead = await call(personalKeys.GET, memberKey, 'GET', '/api/v1/workspace/key-settings/personal');
    check('workspace keys: any member reads the personal key lifetime', personalRead.status === 200 && 'personal_key_lifetime_days' in (personalRead.json.data ?? {}), personalRead.json);
    const personalAdmin = await call(personalKeys.PATCH, adminKey, 'PATCH', '/api/v1/workspace/key-settings/personal', {}, { personal_key_lifetime_days: 30 });
    check('workspace keys: an admin may not change it, owner_only', personalAdmin.status === 403 && personalAdmin.json.error?.details?.reason === 'owner_only', personalAdmin.json);
    const personalOver = await tool(ownerKey, 'update_personal_key_settings', { personal_key_lifetime_days: 180 });
    const personalOverRead = await tool(memberKey, 'get_personal_key_settings', {});
    check('workspace keys mcp: update_personal_key_settings saves, get_personal_key_settings reads it', personalOver.result.ok === true
      && personalOverRead.result.data?.personal_key_lifetime_days === 180, { personalOver: personalOver.result, personalOverRead: personalOverRead.result });
    await call(personalKeys.PATCH, ownerKey, 'PATCH', '/api/v1/workspace/key-settings/personal', {}, { personal_key_lifetime_days: (before.personal_key_lifetime_days as number | null) ?? null });

    // ── Webhook retries ────────────────────────────────────────────────
    const retriesState = await call(retries.GET, ownerKey, 'GET', '/api/v1/workspace/webhook-retries');
    check('workspace retries: the Owner reads the state', retriesState.status === 200 && typeof retriesState.json.data?.on === 'boolean', retriesState.json);
    const off = await call(retries.PUT, ownerKey, 'PUT', '/api/v1/workspace/webhook-retries', {}, { on: false });
    check('workspace retries: PUT on false turns them off and keeps them off', off.status === 200 && off.json.data?.turnedOff === true && (await settingsRow()).webhook_retries_off === true, off.json);
    const offAudit = await auditRow('/api/v1/workspace/webhook-retries');
    check('workspace retries: audited as the Owner\'s key', offAudit?.team_member_id === members.owner && offAudit?.via === 'rest', offAudit);
    const adminRetries = await call(retries.PUT, adminKey, 'PUT', '/api/v1/workspace/webhook-retries', {}, { on: true });
    check('workspace retries: an admin is refused, owner_only', adminRetries.status === 403 && adminRetries.json.error?.details?.reason === 'owner_only', adminRetries.json);
    const onOver = await tool(ownerKey, 'set_webhook_retries', { on: true });
    check('workspace retries mcp: set_webhook_retries on says what the host lacks (409, no app key here)', onOver.result.ok !== true && onOver.result.status === 409, onOver.result);
    const stateOverRetries = await tool(ownerKey, 'get_webhook_retries', {});
    check('workspace retries mcp: get_webhook_retries reads the state', stateOverRetries.result.ok === true && stateOverRetries.result.data?.turnedOff === true, stateOverRetries.result);
  } finally {
    // Put every shared setting back for the areas that run next.
    await q('UPDATE pm.workspace_modules SET enabled = true WHERE enabled = false');
    await q(`UPDATE pm.business_settings SET agents_paused_at = $1, agents_paused_by = $2, webhook_retries_off = $3,
      chat_retention_days = $4, audit_retention_days = $5, audit_redact_keys = $6, agent_key_lifetime_days = $7, personal_key_lifetime_days = $8`,
    [before.agents_paused_at ?? null, before.agents_paused_by ?? null, before.webhook_retries_off ?? false, before.chat_retention_days ?? null,
      before.audit_retention_days ?? null, before.audit_redact_keys ?? [], before.agent_key_lifetime_days ?? null, before.personal_key_lifetime_days ?? null]);
    if (!brandRowBefore) await q('DELETE FROM pm.workspace_brand');
    else {
      await q(`UPDATE pm.workspace_brand SET name = $1, tagline = $2, description = $3, brand_color = $4, brand_shades = $5, accent_color = $6,
        invert_logo_in_sidebar = $7, show_name_under_logo = $8, sidebar_projects = $9, sidebar_active_projects = $10`,
      [brandRowBefore.name, brandRowBefore.tagline, brandRowBefore.description, brandRowBefore.brand_color, brandRowBefore.brand_shades === null ? null : JSON.stringify(brandRowBefore.brand_shades),
        brandRowBefore.accent_color, brandRowBefore.invert_logo_in_sidebar, brandRowBefore.show_name_under_logo, brandRowBefore.sidebar_projects, brandRowBefore.sidebar_active_projects]);
    }
    if (!regionRowBefore) await q('DELETE FROM pm.workspace_region');
    else {
      await q('UPDATE pm.workspace_region SET currency = $1, locale = $2, week_start = $3, money_format = $4',
        [regionRowBefore.currency, regionRowBefore.locale, regionRowBefore.week_start, regionRowBefore.money_format]);
    }
    await q("DELETE FROM pm.team_member_permissions WHERE member_id = $1 AND permission_key = 'settings.manage' AND access_channel = 'api'", [members.admin]);
    resetWebhookRetriesCheck();
  }
}
