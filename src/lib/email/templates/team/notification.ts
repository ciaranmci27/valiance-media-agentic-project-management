/**
 * Generic notification email template for team members.
 * Used for all 32 notification categories (task, project, lead, contact, etc.)
 */

import { ctaButton, emailLayout, escapeHtml, getSiteName, getSiteUrl, heading, kvRows, paragraph } from '../shared';

interface NotificationEmailParams {
  title: string;
  message: string;
  link?: string | null;
  details?: Array<{ label: string; value: string }>;
}

export function buildNotificationEmail(params: NotificationEmailParams): { html: string; text: string } {
  const { title, message, link, details } = params;
  const name = getSiteName();

  const body = `
    ${heading(title)}
    ${paragraph(escapeHtml(message))}
    ${details && details.length > 0 ? kvRows(details) : ''}
    ${link ? ctaButton('View details', link) : ''}
  `;

  const html = emailLayout({
    preheader: message,
    body,
  });

  const lines = [title, '', message];
  if (details?.length) {
    lines.push('');
    details.forEach(d => lines.push(`${d.label}: ${d.value}`));
  }
  if (link) {
    const fullLink = link.startsWith('http') ? link : `${getSiteUrl()}${link}`;
    lines.push('', fullLink);
  }
  lines.push('', '---', name, 'Manage notification preferences in Settings');
  const text = lines.join('\n');

  return { html, text };
}
