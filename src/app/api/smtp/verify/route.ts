import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireAdmin } from '@/lib/api/require-admin';
import { decrypt } from '@/lib/email/crypto';
import { smtpFailureMessage, smtpTargetProblem } from '@/lib/email/smtp-target';

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
  const { id, host, port, secure, username, password } = body;

  // If an account ID is provided, verify using stored credentials
  if (id) {
    const { data: account } = await supabase
      .from('smtp_accounts')
      .select('*')
      .eq('id', id)
      .single();

    if (!account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

    let decryptedPassword: string;
    try {
      decryptedPassword = decrypt(account.encrypted_password);
    } catch {
      return NextResponse.json({ online: false, reason: 'Failed to decrypt password' });
    }

    const storedProblem = await smtpTargetProblem(account.host, account.port);
    if (storedProblem) return NextResponse.json({ online: false, reason: storedProblem });
    try {
      const transport = nodemailer.createTransport({
        host: account.host,
        port: account.port,
        secure: account.secure,
        auth: { user: account.username, pass: decryptedPassword },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
      });
      await transport.verify();
      return NextResponse.json({ online: true });
    } catch (err) {
      return NextResponse.json({ online: false, reason: smtpFailureMessage(err) });
    }
  }

  // Otherwise verify with raw credentials
  if (!host || !username || !password) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }
  const targetProblem = await smtpTargetProblem(host, port || 465);
  if (targetProblem) return NextResponse.json({ online: false, reason: targetProblem });

  try {
    const transport = nodemailer.createTransport({
      host,
      port: port || 465,
      secure: secure ?? (port === 465),
      auth: { user: username, pass: password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });
    await transport.verify();
    return NextResponse.json({ online: true });
  } catch (err) {
    return NextResponse.json({ online: false, reason: smtpFailureMessage(err) });
  }
}
