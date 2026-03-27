/**
 * Generic notification email template for team members.
 * Used for all 32 notification categories (task, project, lead, contact, etc.)
 */

import { emailLayout, ctaButton, escapeHtml, getSiteUrl, getSiteName } from '../shared';

interface NotificationEmailParams {
  title: string;
  message: string;
  link?: string | null;
  details?: Array<{ label: string; value: string }>;
}

/**
 * Build a notification email with branded layout.
 * Returns both HTML and plain text versions.
 */
function renderDetails(details: Array<{ label: string; value: string }>): string {
  if (!details || details.length === 0) return '';

  const rows = details.map(d => `
    <tr>
      <td style="padding: 4px 12px 4px 0; color: #6b7280; font-size: 13px; font-weight: 500; white-space: nowrap; vertical-align: top;">
        ${escapeHtml(d.label)}
      </td>
      <td style="padding: 4px 0; color: #1a1a1a; font-size: 13px;">
        ${escapeHtml(d.value)}
      </td>
    </tr>
  `).join('');

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="
      margin: 16px 0 0 0;
      padding: 12px 16px;
      background-color: #f9fafb;
      border-radius: 8px;
      border-left: 3px solid #3A5959;
      width: 100%;
    ">
      ${rows}
    </table>
  `;
}

export function buildNotificationEmail(params: NotificationEmailParams): { html: string; text: string } {
  const { title, message, link, details } = params;
  const name = getSiteName();

  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);

  const body = `
    <p style="margin: 0 0 16px 0; font-size: 17px; font-weight: 600; color: #1a1a1a;">
      ${safeTitle}
    </p>
    <p style="margin: 0 0 8px 0; color: #374151;">
      ${safeMessage}
    </p>
    ${details ? renderDetails(details) : ''}
    ${link ? ctaButton('View Details', link) : ''}
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
