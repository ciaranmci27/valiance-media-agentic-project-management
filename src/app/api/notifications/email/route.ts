import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { getServiceClient } from '@/lib/api/supabase-service';
import { sendTransactional } from '@/lib/email/send-mail';
import { buildNotificationEmail } from '@/lib/email/templates/team/notification';

const emailDetailSchema = z.object({
  label: z.string().max(50),
  value: z.string().max(200),
});

const emailNotificationSchema = z.object({
  recipient_ids: z.array(z.string().uuid()).min(1).max(50),
  title: z.string().min(1).max(200),
  message: z.string().max(1000).default(''),
  link: z.string().nullable().default(null),
  category: z.string().min(1),
  email: z.object({
    subject: z.string().max(120).optional(),
    details: z.array(emailDetailSchema).max(8).optional(),
  }).optional(),
});

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  // 1. Authenticate caller
  const supabase = await createClient();
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // 2. Validate body
  let body: z.infer<typeof emailNotificationSchema>;
  try {
    body = emailNotificationSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: 'Validation failed', details: err.flatten().fieldErrors }, { status: 422 });
    }
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // 3. Fetch recipients
  const service = getServiceClient();
  const { data: members, error: fetchError } = await service
    .from('team_members')
    .select('id, name, email, email_notifications_enabled, email_notification_prefs')
    .in('id', body.recipient_ids);

  if (fetchError || !members) {
    return NextResponse.json({ error: 'Failed to fetch recipients' }, { status: 500 });
  }

  // 4. Filter to eligible recipients
  const eligible = members.filter(m => {
    if (!m.email_notifications_enabled) return false;
    const prefs = (m.email_notification_prefs || {}) as Record<string, boolean>;
    return prefs[body.category] === true;
  });

  if (eligible.length === 0) {
    return NextResponse.json({ sent: 0, skipped: members.length });
  }

  // 5. Build email
  const emailSubject = body.email?.subject || body.title;
  const { html, text } = buildNotificationEmail({
    title: body.title,
    message: body.message,
    link: body.link,
    details: body.email?.details,
  });

  // 6. Send to all eligible recipients concurrently
  const results = await Promise.allSettled(
    eligible.map(member =>
      sendTransactional({
        to: member.email,
        subject: emailSubject,
        html,
        text,
      })
    )
  );

  const sent = results.filter(r => r.status === 'fulfilled' && r.value.success).length;
  const skipped = members.length - eligible.length;

  return NextResponse.json({ sent, skipped });
}
