import { NextResponse } from 'next/server';
import { isDemoWorkspace, requireOwner } from '@/lib/api/owner-route';
import { communicationsSchemaState, envChecks } from '@/lib/setup/checks';
import { emailConfigured } from '@/lib/team/invite';
import { isSmtpEncryptionConfigured } from '@/lib/email/crypto';
import vercelConfig from '../../../../../vercel.json';

/**
 * The setup wizard's checks, Owner only: each environment variable as set
 * or not (never its value), the communications schema's exposure, and
 * whether an SMTP account exists for invitation emails.
 */
export async function GET() {
  if (isDemoWorkspace()) return NextResponse.json({ error: 'The demo workspace has no database.' }, { status: 403 });
  const auth = await requireOwner();
  if (auth.error) return auth.error;
  const { service } = auth.data;

  const crons = Array.isArray((vercelConfig as { crons?: unknown[] }).crons) && (vercelConfig as { crons: unknown[] }).crons.length > 0;
  const [communications, email] = await Promise.all([communicationsSchemaState(service), emailConfigured(service)]);
  return NextResponse.json({
    data: {
      env: envChecks(process.env, { crons }),
      communications,
      emailConfigured: email && isSmtpEncryptionConfigured(),
    },
  });
}
