import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { accessAllows, requireSessionAccess } from '@/lib/api/access';
import { ApiError } from '@/lib/api/errors';
import { confirmItIsYou, signOutOtherSessions } from '@/lib/api/account-security';
import { changeSignInEmail, EmailChangeError } from '@/lib/team/email-change';

const updateEmailSchema = z.object({
  team_member_id: z.string().uuid(),
  new_email: z.string().trim().toLowerCase().email('Invalid email address'),
  /** Your current password, to change your own sign-in email (lib/api/account-security.ts). */
  current_password: z.string().max(200).optional(),
});

/** Team and Settings > Account: the rules and the write are lib/team/email-change.ts, shared with the API. */
export async function POST(req: NextRequest) {
  const auth = await requireSessionAccess();
  if (auth.error) return auth.error;

  let body: z.infer<typeof updateEmailSchema>;
  try {
    body = updateEmailSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.flatten().fieldErrors }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { access, memberId, service, client: sessionClient } = auth.data;
  try {
    const updated = await changeSignInEmail(service, {
      actor: { memberId, role: access.role, managesTeam: accessAllows(access, 'team.manage', 'app') },
      targetId: body.team_member_id,
      newEmail: body.new_email,
      // In the app: your current password, or a fresh sign-in (or the reset link you came in by).
      proveSelf: (login) => confirmItIsYou({ sessionClient, email: login.email, hasPassword: login.hasPassword, currentPassword: body.current_password }),
    });
    if (memberId === body.team_member_id) await signOutOtherSessions(sessionClient);
    return NextResponse.json(updated);
  } catch (error) {
    if (error instanceof EmailChangeError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof ApiError) {
      return NextResponse.json({ error: error.message, code: error.code, details: error.details ?? null }, { status: error.statusCode });
    }
    throw error;
  }
}
