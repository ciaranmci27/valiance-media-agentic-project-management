/**
 * Portal Welcome email template for clients.
 * Sent manually when the admin wants to notify a client about their portal.
 *
 * Editable copy lives in `PortalWelcomeSlots`. Numbers, layout, and branding
 * are fixed; only the text fields listed here can be overridden per send.
 */

import { ctaButton, escapeHtml, getSiteName, brandPrimary, brandLight, brandSubtle, NEUTRAL } from '../shared';
import { clientEmailLayout, clientAvatar } from './layout';

export interface PortalWelcomeSlots {
  subject: string;
  intro_paragraph: string;
  welcome_message: string;
  features_heading: string;
  closing_note: string;
}

/**
 * Default slot values. `portalWelcomeMessage` comes from portal_settings
 * and seeds the welcome_message slot so the admin can edit it per send.
 */
export function portalWelcomeDefaults(ctx: {
  projectName: string;
  portalWelcomeMessage?: string;
}): PortalWelcomeSlots {
  return {
    subject: `Your project portal for ${ctx.projectName}`,
    intro_paragraph: "We've set up a dedicated project portal for you. It's a single place where you can track progress, review deliverables, and stay in the loop on everything happening with your project.",
    welcome_message: ctx.portalWelcomeMessage || '',
    features_heading: 'What you can do:',
    closing_note: '',
  };
}

interface PortalWelcomeParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
  accentColor?: string;
  logoUrl?: string;
  slots: PortalWelcomeSlots;
}

function featureCard(title: string, description: string, accent: string, padStyle: string): string {
  return `
    <td width="32%" style="${padStyle} vertical-align: top;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius: 10px; overflow: hidden; border: 1px solid ${NEUTRAL.border};">
        <tr><td style="background-color: ${accent}; height: 3px; font-size: 0; line-height: 0;">&nbsp;</td></tr>
        <tr>
          <td style="padding: 18px 12px; text-align: center; background-color: ${NEUTRAL.white};">
            <p style="margin: 0 0 6px 0; font-size: 14px; font-weight: 700; color: ${NEUTRAL.black};">${title}</p>
            <p style="margin: 0; font-size: 12px; color: ${NEUTRAL.textMuted}; line-height: 1.5;">${description}</p>
          </td>
        </tr>
      </table>
    </td>
  `;
}

export function buildPortalWelcomeEmail(
  params: PortalWelcomeParams,
): { subject: string; html: string; text: string } {
  const { projectName, clientName, portalUrl, accentColor, logoUrl, slots } = params;
  const name = getSiteName();
  const primary = brandPrimary();
  const light = brandLight();
  const subtle = brandSubtle();

  const safeClient = escapeHtml(clientName);
  const safeProject = escapeHtml(projectName);

  const welcomeBlock = slots.welcome_message
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 28px 0;">
        <tr>
          <td style="
            padding: 24px 28px;
            background-color: ${subtle};
            border-radius: 10px;
            text-align: center;
          ">
            <p style="margin: 0 0 8px 0; font-size: 28px; color: ${light}; line-height: 1;">&#8220;</p>
            <p style="
              margin: 0;
              color: ${NEUTRAL.textBody};
              font-size: 14px;
              line-height: 1.7;
              font-style: italic;
            ">${escapeHtml(slots.welcome_message)}</p>
          </td>
        </tr>
      </table>`
    : '';

  const closingBlock = slots.closing_note
    ? `<p style="margin: 16px 0 0 0; color: ${NEUTRAL.textMuted}; font-size: 13px; line-height: 1.7;">${escapeHtml(slots.closing_note)}</p>`
    : '';

  const body = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 24px 0;">
      <tr>
        <td style="padding: 0 14px 0 0; vertical-align: middle;">
          ${clientAvatar(projectName, logoUrl, 44)}
        </td>
        <td style="vertical-align: middle;">
          <p style="margin: 0 0 2px 0; font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px; color: ${light}; font-weight: 600;">Your Project Portal</p>
          <p style="margin: 0; font-size: 22px; font-weight: 700; color: ${NEUTRAL.black}; line-height: 1.3;">${safeProject}</p>
        </td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr><td style="padding: 0 0 16px 0;">
        <p style="margin: 0; color: ${NEUTRAL.textBody}; font-size: 15px;">
          Hi ${safeClient},
        </p>
      </td></tr>

      <tr><td style="padding: 0 0 24px 0;">
        <p style="margin: 0; color: ${NEUTRAL.textBody}; font-size: 15px; line-height: 1.7;">
          ${escapeHtml(slots.intro_paragraph)}
        </p>
      </td></tr>

      <tr><td style="padding: 0 0 0 0;">
        ${welcomeBlock}
      </td></tr>

      <!-- Feature grid -->
      <tr><td style="padding: 0 0 8px 0;">
        <p style="margin: 0; font-size: 14px; font-weight: 600; color: ${NEUTRAL.black};">${escapeHtml(slots.features_heading)}</p>
      </td></tr>
      <tr><td style="padding: 0 0 28px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            ${featureCard('Track Progress', 'Tasks and milestones', primary, 'padding: 0 6px 0 0;')}
            ${featureCard('Review Files', 'Shared deliverables', light, 'padding: 0 3px;')}
            ${featureCard('Stay Updated', 'Latest project news', primary, 'padding: 0 0 0 6px;')}
          </tr>
        </table>
      </td></tr>

      <tr><td>
        ${ctaButton('View Your Portal', portalUrl)}
        <p style="margin: 4px 0 0 0; color: ${NEUTRAL.textMuted}; font-size: 12px; line-height: 1.6;">
          If the button above doesn't work for any reason, copy and paste this portal link into your browser:
        </p>
        <p style="margin: 4px 0 0 0; font-size: 12px; line-height: 1.6; word-break: break-all; overflow-wrap: anywhere;">
          <a href="${portalUrl}" target="_blank" style="color: ${primary}; text-decoration: underline;">${escapeHtml(portalUrl)}</a>
        </p>
        ${closingBlock}
      </td></tr>
    </table>
  `;

  const html = clientEmailLayout({
    preheader: `Your project portal for ${projectName} is ready`,
    body,
    portalUrl,
    accentColor,
  });

  const lines = [
    `Hi ${clientName},`,
    '',
    slots.intro_paragraph,
    '',
  ];
  if (slots.welcome_message) {
    lines.push(`"${slots.welcome_message}"`, '');
  }
  lines.push(
    slots.features_heading,
    '- Track progress on tasks and milestones',
    '- Review files and deliverables',
    '- Stay updated with the latest project news',
    '',
    'View your portal:',
    portalUrl,
    '',
  );
  if (slots.closing_note) {
    lines.push(slots.closing_note, '');
  }
  lines.push('---', name);

  return { subject: slots.subject, html, text: lines.join('\n') };
}
