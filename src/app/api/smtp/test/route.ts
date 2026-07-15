import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireAdmin } from '@/lib/api/require-admin';
import { decrypt } from '@/lib/email/crypto';

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

    await transport.sendMail({
      from: `"${account.from_name}" <${account.from_email}>`,
      replyTo: account.reply_to || undefined,
      to,
      subject: 'Test Email — SMTP Configuration',
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
          <h2 style="color: #18181b; margin: 0 0 8px;">SMTP Test Successful</h2>
          <p style="color: #71717a; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
            This test email confirms that your SMTP account <strong>"${account.label}"</strong> is configured correctly.
          </p>
          <div style="background: #f4f4f5; border-radius: 8px; padding: 16px; font-size: 13px; color: #52525b;">
            <p style="margin: 0 0 4px;"><strong>Host:</strong> ${account.host}:${account.port}</p>
            <p style="margin: 0 0 4px;"><strong>From:</strong> ${account.from_name} &lt;${account.from_email}&gt;</p>
            <p style="margin: 0;"><strong>Sent at:</strong> ${new Date().toISOString()}</p>
          </div>
        </div>
      `,
      text: `SMTP Test Successful\n\nThis test email confirms that your SMTP account "${account.label}" is configured correctly.\n\nHost: ${account.host}:${account.port}\nFrom: ${account.from_name} <${account.from_email}>\nSent at: ${new Date().toISOString()}`,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error sending email';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
