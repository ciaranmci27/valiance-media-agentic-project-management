import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireAdmin } from '@/lib/api/require-admin';
import { encrypt, decrypt, isSmtpEncryptionConfigured } from '@/lib/email/crypto';
import type { SmtpAccount, SmtpAccountSafe } from '@/lib/email/types';

export const dynamic = 'force-dynamic';

function toSafe(account: SmtpAccount): SmtpAccountSafe {
  const { encrypted_password, ...rest } = account;
  return { ...rest, has_password: !!encrypted_password };
}

// ─── PUT — Update account ────────────────────────────────────────────────────

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { supabase } = auth;

  if (!isSmtpEncryptionConfigured()) {
    return NextResponse.json({ error: 'SMTP encryption is not configured' }, { status: 400 });
  }

  // Fetch existing account
  const { data: existing, error: fetchError } = await supabase
    .from('smtp_accounts')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchError || !existing) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { label, host, port, secure, username, password, from_name, from_email, reply_to, is_default } = body;

  // Determine if connection fields changed — need re-verify
  const connectionChanged =
    (host !== undefined && host !== existing.host) ||
    (port !== undefined && port !== existing.port) ||
    (secure !== undefined && secure !== existing.secure) ||
    (username !== undefined && username !== existing.username) ||
    !!password;

  // Resolve password: use new one if provided, otherwise keep existing
  let resolvedPassword: string;
  if (password) {
    resolvedPassword = password;
  } else {
    try {
      resolvedPassword = decrypt(existing.encrypted_password);
    } catch {
      return NextResponse.json({ error: 'Failed to decrypt existing password' }, { status: 500 });
    }
  }

  // Re-verify SMTP if connection details changed
  if (connectionChanged) {
    try {
      const transport = nodemailer.createTransport({
        host: host ?? existing.host,
        port: port ?? existing.port,
        secure: secure ?? existing.secure,
        auth: { user: username ?? existing.username, pass: resolvedPassword },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
      });
      await transport.verify();
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      return NextResponse.json({ error: `SMTP connection failed: ${reason}` }, { status: 400 });
    }
  }

  // If setting as default, clear existing defaults
  if (is_default && !existing.is_default) {
    await supabase
      .from('smtp_accounts')
      .update({ is_default: false })
      .eq('is_default', true);
  }

  const updates: Record<string, unknown> = {};
  if (label !== undefined) updates.label = label;
  if (host !== undefined) updates.host = host;
  if (port !== undefined) updates.port = port;
  if (secure !== undefined) updates.secure = secure;
  if (username !== undefined) updates.username = username;
  if (password) updates.encrypted_password = encrypt(resolvedPassword);
  if (from_name !== undefined) updates.from_name = from_name;
  if (from_email !== undefined) updates.from_email = from_email;
  if (reply_to !== undefined) updates.reply_to = reply_to;
  if (is_default !== undefined) updates.is_default = is_default;

  const { data: updated, error } = await supabase
    .from('smtp_accounts')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ account: toSafe(updated as SmtpAccount) });
}

// ─── DELETE — Delete account ─────────────────────────────────────────────────

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { supabase } = auth;

  // Fetch account to check if it exists and is the default
  const { data: account } = await supabase
    .from('smtp_accounts')
    .select('is_default')
    .eq('id', id)
    .single();

  if (!account) {
    return NextResponse.json({ error: 'Account not found' }, { status: 404 });
  }

  const { error } = await supabase
    .from('smtp_accounts')
    .delete()
    .eq('id', id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // If the deleted account was the default, assign a new default
  if (account?.is_default) {
    const { data: remaining } = await supabase
      .from('smtp_accounts')
      .select('id')
      .order('created_at', { ascending: true })
      .limit(1)
      .single();

    if (remaining) {
      await supabase
        .from('smtp_accounts')
        .update({ is_default: true })
        .eq('id', remaining.id);
    }
  }

  return NextResponse.json({ success: true });
}
