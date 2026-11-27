/**
 * 6. Keys, as Settings > API keys and an agent's page manage them: pausing a
 * key blocks it at once and resuming restores it; replacing a key gives a new
 * secret while the old one keeps working through the overlap; revoking a key
 * also revokes the keys it replaced and every key it made over the API.
 */
import { KeyCaller, check, dataOf, equal, errorOf, personalKey, retireAgent, step, tag, uuid, type Ctx } from './harness';
import type { Scenario } from './run';

const scenario: Scenario = {
  name: 'Keys: pause blocks, resume restores, replace overlaps, revoke cascades',
  async run(ctx: Ctx) {
    const { owner } = ctx.people;
    const reads = (key: KeyCaller) => key.get('/api/v1/agents/me/context?format=json');

    // An Owner's own key that hires agents over the API: the keys it makes record it.
    const parent = await personalKey(ctx, owner, ['team.manage', 'team.read', 'api_keys.manage_all', 'tasks.read', 'projects.read', 'agent_activity.write'], 'hiring key');
    const hireOver = async (name: string) => {
      const result = dataOf(await parent.caller.post('/api/v1/agents/hire', {
        name: `E2E ${name} ${tag}`, create_key: true, request_id: uuid(), scopes: ['tasks.read', 'agent_activity.write'],
      }), 201, `hire ${name} over the API`);
      ctx.cleanup.add(`retire ${result.agent.id}`, () => retireAgent(ctx.db, result.agent.id));
      return { agentId: result.agent.id as string, keyId: result.key.id as string, key: new KeyCaller(ctx.baseUrl, result.key.secret, name) };
    };
    const first = await hireOver('Key agent one');
    const second = await hireOver('Key agent two');
    const madeBy = (await ctx.db.query(`SELECT created_by_key_id FROM pm.api_keys WHERE id = ANY($1)`, [[first.keyId, second.keyId]])).rows;
    check(madeBy.every((row) => row.created_by_key_id === parent.id), 'Keys made over the API record the key that made them', madeBy);
    equal((await reads(first.key)).status, 200, 'a new agent key works');
    step('Owner\'s key hired two agents over the API; each agent key records the key that made it');

    // ── Pause and resume ──
    const paused = dataOf(await owner.post(`/api/workspace/api-keys/${first.keyId}/pause`), 200, 'pause the key');
    equal(paused.state, 'paused', 'key state after pause');
    const blocked = await reads(first.key);
    equal(blocked.status, 401, 'a paused key is refused');
    check(JSON.stringify(blocked.body).includes('api_key_paused'), 'The refusal says the key is paused', blocked.body);
    const pausedList = dataOf(await owner.get('/api/workspace/api-keys?state=paused'), 200, 'paused keys');
    check(pausedList.keys.some((k: { id: string }) => k.id === first.keyId), 'Settings lists it under Paused', pausedList);
    const resumed = dataOf(await owner.post(`/api/workspace/api-keys/${first.keyId}/resume`), 200, 'resume the key');
    equal(resumed.state, 'active', 'key state after resume');
    equal((await reads(first.key)).status, 200, 'a resumed key works again');
    step('Pause: the key is refused at once (401 api_key_paused) and listed as Paused; resume: it works again');

    // ── Replace with overlap ──
    const rotated = dataOf(await owner.post(`/api/workspace/api-keys/${first.keyId}/rotate`, { overlap_hours: 1 }), 201, 'replace the key');
    check(typeof rotated.secret === 'string' && rotated.key?.id && rotated.previous?.id === first.keyId, 'The replacement answer has the new secret and names the old key', { ...rotated, secret: '<hidden>' });
    const successor = new KeyCaller(ctx.baseUrl, rotated.secret, 'successor');
    const overlapEnds = Date.parse(rotated.previous.expires_at);
    check(Math.abs(overlapEnds - (Date.now() + 3_600_000)) < 120_000, 'The old key ends one hour from now', rotated.previous);
    equal((await reads(first.key)).status, 200, 'the old key works during the overlap');
    equal((await reads(successor)).status, 200, 'the new key works');
    ctx.cleanup.add('revoke successor', () => ctx.db.query(`UPDATE pm.api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [rotated.key.id]));
    step('Replace: a new secret; the old key keeps working until its overlap ends in one hour');

    // ── Revoke cascades: through rotation ──
    const preview = dataOf(await owner.get(`/api/workspace/api-keys/${rotated.key.id}/revoke`), 200, 'what revoking the new key takes down');
    check(preview.also.some((k: { id: string }) => k.id === first.keyId), 'Revoking the new key also takes down the key it replaced', preview);
    const revokedNew = await owner.post(`/api/workspace/api-keys/${rotated.key.id}/revoke`);
    equal(revokedNew.status, 200, 'revoke the new key', revokedNew.body);
    const ids: string[] = revokedNew.body.revoked_ids ?? [];
    check(revokedNew.body.data?.revoked_at && ids[0] === rotated.key.id && ids.includes(first.keyId), 'revoked_ids lists the key and the one it replaced', revokedNew.body);
    equal((await reads(successor)).status, 401, 'the revoked key is refused');
    equal((await reads(first.key)).status, 401, 'the replaced key is refused even inside its overlap');
    step('Revoke the new key: the key it replaced goes too (both 401), as the preview said');

    // ── Revoke cascades: what a key made ──
    equal((await reads(second.key)).status, 200, 'the second agent key still works');
    const parentPreview = dataOf(await owner.get(`/api/workspace/api-keys/${parent.id}/revoke`), 200, 'what revoking the hiring key takes down');
    check(parentPreview.also.some((k: { id: string }) => k.id === second.keyId), 'The preview names the agent key it made', parentPreview);
    const revokedParent = await owner.post(`/api/workspace/api-keys/${parent.id}/revoke`);
    equal(revokedParent.status, 200, 'revoke the hiring key', revokedParent.body);
    check((revokedParent.body.revoked_ids ?? []).includes(second.keyId), 'Revoking the hiring key revokes the key it made', revokedParent.body);
    const parentRefused = await parent.caller.get('/api/v1/projects');
    equal(parentRefused.status, 401, 'the hiring key is refused');
    const childRefused = await reads(second.key);
    equal(childRefused.status, 401, 'the key it made is refused');
    const again = dataOf(await owner.post(`/api/workspace/api-keys/${parent.id}/revoke`), 200, 'revoke twice');
    check(again.revoked_at, 'Revoking again answers the key as it is', again);
    const resume = await owner.post(`/api/workspace/api-keys/${parent.id}/resume`);
    check(resume.status === 409, 'A revoked key cannot be resumed', { status: resume.status, error: errorOf(resume) });
    step('Revoke the hiring key: the agent key it made goes too (401); revoking twice is harmless; a revoked key cannot be resumed (409)');
  },
};

export default scenario;
