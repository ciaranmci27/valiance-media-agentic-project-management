/**
 * Generic notification email template for team members.
 * Used for all 32 notification categories (task, project, lead, contact, etc.)
 */

import { emailLayout, ctaButton, escapeHtml, getSiteUrl, getSiteName, brandPrimary, brandLight, brandSubtle, NEUTRAL } from '../shared';

interface NotificationEmailParams {
  title: string;
  message: string;
  link?: string | null;
  details?: Array<{ label: string; value: string }>;
}

function renderDetails(details: Array<{ label: string; value: string }>, accent: string): string {
  if (!details || details.length === 0) return '';

  const rows = details.map((d, i) => `
    <tr>
      <td style="padding: 12px 16px; ${i < details.length - 1 ? `border-bottom: 1px solid ${NEUTRAL.border};` : ''}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="color: ${NEUTRAL.textMuted}; font-size: 13px; font-weight: 500;">
              ${escapeHtml(d.label)}
            </td>
            <td align="right" style="color: ${NEUTRAL.black}; font-size: 13px; font-weight: 600;">
              ${escapeHtml(d.value)}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');

  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="
      margin: 20px 0 0 0;
      border-radius: 10px;
      overflow: hidden;
      border: 1px solid ${NEUTRAL.border};
    ">
      <tr><td style="background-color: ${accent}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
      <tr><td style="padding: 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${rows}
        </table>
      </td></tr>
    </table>
  `;
}

export function buildNotificationEmail(params: NotificationEmailParams): { html: string; text: string } {
  const { title, message, link, details } = params;
  const name = getSiteName();
  const primary = brandPrimary();
  const light = brandLight();

  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);

  const body = `
    <p style="margin: 0 0 16px 0; font-size: 22px; font-weight: 700; color: ${NEUTRAL.black}; line-height: 1.3;">
      ${safeTitle}
    </p>

    <p style="margin: 0 0 8px 0; color: ${NEUTRAL.textBody}; font-size: 15px; line-height: 1.7;">
      ${safeMessage}
    </p>
    ${details ? renderDetails(details, light) : ''}
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
