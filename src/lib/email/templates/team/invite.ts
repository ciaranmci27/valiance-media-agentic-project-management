/**
 * The invitation a new team member gets: who invited them, to which
 * workspace, and one button to choose their password and sign in.
 * Shared by the invite route and the resend action so the two never drift.
 */

import type { Brand } from '@/lib/brand';
import { EMAIL, ctaButton, emailLayout, escapeHtml, footerLine, getSiteName, heading, linkLine, paragraph, withEmailBrand } from '../shared';

interface InviteEmailParams {
  name: string;
  inviterName: string | null;
  roleLabel: string;
  link: string;
}

/** Renders with the workspace's brand (getBrand), so the name, logo and colors are this workspace's. */
export function buildInviteEmail(params: InviteEmailParams & { brand: Brand }): { subject: string; html: string; text: string } {
  return withEmailBrand(params.brand, () => renderInviteEmail(params));
}

function renderInviteEmail(params: InviteEmailParams): { subject: string; html: string; text: string } {
  const { name, inviterName, roleLabel, link } = params;
  const workspace = getSiteName();
  const firstName = name.trim().split(/\s+/)[0] || name;
  const who = inviterName ? `${inviterName} invited you` : 'You have been invited';
  const strong = (text: string) => `<strong style="font-weight: 600; color: ${EMAIL.ink};">${escapeHtml(text)}</strong>`;

  const body = `
    ${heading('You are invited to', `${workspace}.`)}
    ${paragraph(`Hi ${escapeHtml(firstName)},`)}
    ${paragraph(`${inviterName ? `${strong(inviterName)} invited you` : 'You have been invited'} to join ${strong(workspace)} as ${/^[aeiou]/i.test(roleLabel) ? 'an' : 'a'} ${strong(roleLabel)}. Choose a password to sign in. It takes a minute.`)}
    ${ctaButton('Choose your password', link, { margin: '20px 0 12px 0' })}
    ${linkLine(link, 'If the button does not work, open this link:')}
    ${paragraph('The link works once and lasts 7 days. If it has expired, ask for a new one.', { muted: true, size: 13 })}
  `;

  const html = emailLayout({
    preheader: `${who} to ${workspace}. Choose your password to sign in.`,
    body,
    footerHtml: `
      ${footerLine('You received this because someone added you to their team. If you did not expect it, ignore this email.')}
      ${footerLine(`&copy; ${new Date().getFullYear()} ${escapeHtml(workspace)}`)}`,
  });

  const text = [
    `Hi ${firstName},`,
    '',
    `${who} to join ${workspace} as ${/^[aeiou]/i.test(roleLabel) ? 'an' : 'a'} ${roleLabel}.`,
    '',
    'Choose your password to sign in:',
    link,
    '',
    'The link works once and lasts 7 days. If it has expired, ask for a new one.',
    '',
    '---',
    workspace,
  ].join('\n');

  return { subject: `${who} to ${workspace}`, html, text };
}
