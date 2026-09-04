import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireAdmin } from '@/lib/api/require-admin';
import { decrypt } from '@/lib/email/crypto';
import { buildSmtpTestEmail } from '@/lib/email/templates/team/smtp-test';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { supabase } = auth;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { id, to } = body;

  if (!id || !to) {
    return NextResponse.json({ error: 'Account ID and recipient are required' }, { status: 400 });
  }

  const { data: account } = await supabase
    .from('smtp_accounts')
    .select('*')
    .eq('id', id)
    .single();

  if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  let password: string;
  try {
    password = decrypt(account.encrypted_password);
  } catch {
    return NextResponse.json({ error: 'Failed to decrypt password' }, { status: 500 });
  }

  try {
    const transport = nodemailer.createTransport({
      host: account.host,
      port: account.port,
      secure: account.secure,
      auth: { user: account.username, pass: password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });

    const { subject, html, text } = buildSmtpTestEmail({
      label: account.label,
      host: account.host,
      port: account.port,
      fromName: account.from_name,
      fromEmail: account.from_email,
    });

    await transport.sendMail({
      from: `"${account.from_name}" <${account.from_email}>`,
      replyTo: account.reply_to || undefined,
      to,
      subject,
      html,
      text,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error sending email';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
