import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireAdmin } from '@/lib/api/require-admin';
import { encrypt, isSmtpEncryptionConfigured } from '@/lib/email/crypto';
import type { SmtpAccount, SmtpAccountSafe } from '@/lib/email/types';

export const dynamic = 'force-dynamic';

function toSafe(account: SmtpAccount): SmtpAccountSafe {
  const { encrypted_password, ...rest } = account;
  return { ...rest, has_password: !!encrypted_password };
}

// ─── GET — List accounts ──────────────────────────────────────────────────────

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { supabase } = auth;

  const { data: accounts, error } = await supabase
    .from('smtp_accounts')
    .select('*')
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({
    accounts: (accounts as SmtpAccount[]).map(toSafe),
    encryptionConfigured: isSmtpEncryptionConfigured(),
  });
}

// ─── POST — Create account ───────────────────────────────────────────────────

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { supabase, user } = auth;

  if (!isSmtpEncryptionConfigured()) {
    return NextResponse.json({ error: 'SMTP encryption is not configured' }, { status: 400 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { label, host, port, secure, username, password, from_name, from_email, reply_to, is_default } = body;

  if (!label || !host || !username || !password || !from_name || !from_email) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Verify SMTP connection before saving
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
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: `SMTP connection failed: ${reason}` }, { status: 400 });
  }

  const encrypted_password = encrypt(password);

  // Look up team member id from auth user
  const { data: member } = await supabase
    .from('team_members')
    .select('id')
    .eq('auth_user_id', user.id)
    .single();

  // If setting as default, clear existing defaults
  if (is_default) {
    await supabase
      .from('smtp_accounts')
      .update({ is_default: false })
      .eq('is_default', true);
  }

  const { data: account, error } = await supabase
    .from('smtp_accounts')
    .insert({
      label,
      host,
      port: port || 465,
      secure: secure ?? (port === 465),
      username,
      encrypted_password,
      from_name,
      from_email,
      reply_to: reply_to || '',
      is_default: is_default ?? false,
      created_by: member?.id || null,
    })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ account: toSafe(account as SmtpAccount) });
}
