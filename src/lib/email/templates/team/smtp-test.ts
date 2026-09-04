/**
 * The test email sent from SMTP settings to confirm an account can deliver.
 * Shared by the send route and the email preview so the two never drift.
 */

import { EMAIL, emailLayout, escapeHtml, footerLine, getSiteName, heading, kvRows, metaLine, paragraph } from '../shared';

interface SmtpTestEmailParams {
  label: string;
  host: string;
  port: number | string;
  fromName: string;
  fromEmail: string;
  sentAt?: Date;
}

export function buildSmtpTestEmail(params: SmtpTestEmailParams): { subject: string; html: string; text: string } {
  const { label, host, port, fromName, fromEmail } = params;
  const sentAt = (params.sentAt ?? new Date()).toISOString();
  const name = getSiteName();

  const body = `
    ${heading('SMTP is', 'working.')}
    ${metaLine([label, sentAt])}
    ${paragraph(`This test email confirms that the SMTP account <strong style="font-weight: 600; color: ${EMAIL.ink};">${escapeHtml(label)}</strong> is configured correctly. Anything sent through it will arrive from the address below.`)}
    ${kvRows([
      { label: 'Host', value: host },
      { label: 'Port', value: String(port) },
      { label: 'From name', value: fromName },
      { label: 'From email', value: fromEmail },
    ])}
  `;

  const html = emailLayout({
    preheader: `SMTP account ${label} is configured correctly.`,
    body,
    footerHtml: `
      ${footerLine('Sent from SMTP settings to verify this account. No action is needed.')}
      ${footerLine(`&copy; ${new Date().getFullYear()} ${escapeHtml(name)}`)}`,
  });

  const text = [
    'SMTP is working.',
    '',
    `This test email confirms that the SMTP account "${label}" is configured correctly.`,
    '',
    `Host: ${host}`,
    `Port: ${port}`,
    `From name: ${fromName}`,
    `From email: ${fromEmail}`,
    `Sent at: ${sentAt}`,
    '',
    '---',
    name,
  ].join('\n');

  return { subject: 'Test email: SMTP configuration', html, text };
}
