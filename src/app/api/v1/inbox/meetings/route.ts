import { withApi } from '@/lib/api/middleware';
import { created, success } from '@/lib/api/response';
import { ApiError, forbidden } from '@/lib/api/errors';
import { inboxScope } from '@/lib/communications/agent-access';
import { ingestMeetingPackage, meetingPackageSchema, MeetingTooLargeError, type MeetingPackage } from '@/lib/communications/meeting/ingest';

export const dynamic = 'force-dynamic';

/**
 * The meeting script posts one package per meeting: Gemini's notes or the
 * full transcript. The key's member is the teammate the meeting came from
 * (an active person, never an agent) and the inbox must be one they can read.
 * Posting the same package again returns the message already recorded.
 */
export const POST = withApi<MeetingPackage>(async ({ supabase, body, teamMemberId, access, apiKeyId }) => {
  const { data: member, error } = await supabase.from('team_members').select('id, role, status').eq('id', teamMemberId).maybeSingle();
  if (error) throw error;
  if (!member || member.status !== 'active' || member.role === 'agent') {
    throw forbidden('Only an active teammate\'s key may post meetings', { reason: 'meeting_poster' });
  }
  await inboxScope(supabase, teamMemberId, access, body.inbox_id);
  try {
    const outcome = await ingestMeetingPackage(supabase, body, teamMemberId, apiKeyId);
    return outcome.already_complete ? success(outcome) : created(outcome);
  } catch (caught) {
    if (caught instanceof MeetingTooLargeError) throw new ApiError(413, 'meeting_too_large', caught.message);
    throw caught;
  }
}, { schema: meetingPackageSchema, permission: 'meetings.write' });
