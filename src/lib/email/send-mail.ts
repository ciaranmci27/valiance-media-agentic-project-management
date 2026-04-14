import nodemailer from 'nodemailer';
import { decrypt } from './crypto';
import { getServiceClient } from '@/lib/api/supabase-service';
import type { SmtpAccount } from './types';

interface SendMailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

async function getAccountAndTransport(accountId?: string) {
  const supabase = getServiceClient();

  let account: SmtpAccount | null = null;

  if (accountId) {
    const { data } = await supabase
      .from('smtp_accounts')
      .select('*')
      .eq('id', accountId)
      .single();
    account = data;
  } else {
    // Try default first, then fall back to first account
    const { data: defaultAccount } = await supabase
      .from('smtp_accounts')
      .select('*')
      .eq('is_default', true)
      .single();

    if (defaultAccount) {
      account = defaultAccount;
    } else {
      const { data: firstAccount } = await supabase
        .from('smtp_accounts')
        .select('*')
        .order('created_at', { ascending: true })
        .limit(1)
        .single();
      account = firstAccount;
    }
  }

  if (!account) {
    return { error: 'No email accounts configured' } as const;
  }

  let password: string;
  try {
    password = decrypt(account.encrypted_password);
  } catch {
    return { error: 'Failed to decrypt email account password' } as const;
  }

  const transport = nodemailer.createTransport({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: {
      user: account.username,
      pass: password,
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
  });

  return { account, transport } as const;
}

// ─── Transactional ────────────────────────────────────────────────────────────

interface TransactionalOptions {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html: string;
  text?: string;
  accountId?: string;
}

function joinList(v: string | string[] | undefined): string | undefined {
  if (!v) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  const trimmed = arr.map(s => s.trim()).filter(Boolean);
  return trimmed.length ? trimmed.join(', ') : undefined;
}

export async function sendTransactional(options: TransactionalOptions): Promise<SendMailResult> {
  const result = await getAccountAndTransport(options.accountId);
  if ('error' in result) return { success: false, error: result.error };

  const { account, transport } = result;

  try {
    const info = await transport.sendMail({
      from: `"${account.from_name}" <${account.from_email}>`,
      replyTo: account.reply_to || undefined,
      to: joinList(options.to),
      cc: joinList(options.cc),
      bcc: joinList(options.bcc),
      subject: options.subject,
      html: options.html,
      text: options.text,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error sending email';
    return { success: false, error: message };
  }
}

// ─── Relay ────────────────────────────────────────────────────────────────────

interface RelayOptions {
  to?: string | string[];
  subject: string;
  html: string;
  text?: string;
  sender: { name: string; email: string };
  accountId?: string;
}

export async function sendRelay(options: RelayOptions): Promise<SendMailResult> {
  const result = await getAccountAndTransport(options.accountId);
  if ('error' in result) return { success: false, error: result.error };

  const { account, transport } = result;

  const safeName = options.sender.name.replace(/[\r\n"]/g, '').trim();
  const safeEmail = options.sender.email.replace(/[\r\n]/g, '').trim();

  const to = options.to
    ? (Array.isArray(options.to) ? options.to.join(', ') : options.to)
    : account.from_email;

  try {
    const info = await transport.sendMail({
      from: `"${safeName}" <${account.from_email}>`,
      replyTo: safeEmail,
      to,
      subject: options.subject,
      html: options.html,
      text: options.text,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error sending email';
    return { success: false, error: message };
  }
}
