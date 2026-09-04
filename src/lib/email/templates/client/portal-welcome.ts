/**
 * Portal Welcome email template for clients.
 * Sent manually when the admin wants to notify a client about their portal.
 *
 * Editable copy lives in `PortalWelcomeSlots`. Layout and branding are
 * fixed; only the text fields listed here can be overridden per send.
 */

import { EMAIL, FONT_SANS, ctaButton, escapeHtml, getSiteName, label, linkLine, paragraph, pullQuote, tile } from '../shared';
import { clientEmailLayout, clientHeader, greeting } from './layout';

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
    intro_paragraph: 'We have set up a project portal for you. It is one place to follow progress, review deliverables, and see what is happening with your project without having to ask.',
    welcome_message: ctx.portalWelcomeMessage || '',
    features_heading: 'What you can do',
    closing_note: '',
  };
}

interface PortalWelcomeParams {
  projectName: string;
  clientName: string;
  portalUrl: string;
  logoUrl?: string;
  slots: PortalWelcomeSlots;
}

const FEATURES: Array<{ title: string; line: string }> = [
  { title: 'Track progress', line: 'Tasks and milestones, as they move.' },
  { title: 'Review files', line: 'Every shared deliverable in one place.' },
  { title: 'Stay updated', line: 'The latest on your project, without asking.' },
];

function featureTile(feature: { title: string; line: string }): string {
  return tile(
    `<p style="margin: 0 0 3px 0; font-family: ${FONT_SANS}; font-size: 15px; line-height: 1.4; font-weight: 500; color: ${EMAIL.ink};">${escapeHtml(feature.title)}</p>
     <p style="margin: 0; font-family: ${FONT_SANS}; font-size: 13px; line-height: 1.5; color: ${EMAIL.muted};">${escapeHtml(feature.line)}</p>`,
    { padding: '14px 18px', margin: '0 0 10px 0' },
  );
}

export function buildPortalWelcomeEmail(
  params: PortalWelcomeParams,
): { subject: string; html: string; text: string } {
  const { projectName, clientName, portalUrl, logoUrl, slots } = params;
  const name = getSiteName();

  const body = `
    ${clientHeader({
      projectName,
      logoUrl,
      title: 'Your portal is',
      tail: 'ready.',
      meta: [projectName, 'Client portal'],
    })}
    ${greeting(clientName)}
    ${paragraph(escapeHtml(slots.intro_paragraph))}
    ${slots.welcome_message ? pullQuote(escapeHtml(slots.welcome_message)) : ''}
    ${label(slots.features_heading, { margin: '8px 0 10px 0' })}
    ${FEATURES.map(featureTile).join('')}
    ${ctaButton('Open your portal', portalUrl, { margin: '18px 0 12px 0' })}
    ${linkLine(portalUrl, 'If the button does not work, open this link:')}
    ${slots.closing_note ? paragraph(escapeHtml(slots.closing_note), { muted: true, size: 13 }) : ''}
  `;

  const html = clientEmailLayout({
    preheader: `Your project portal for ${projectName} is ready`,
    body,
    portalUrl,
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
    ...FEATURES.map(f => `- ${f.title}: ${f.line}`),
    '',
    'Open your portal:',
    portalUrl,
    '',
  );
  if (slots.closing_note) {
    lines.push(slots.closing_note, '');
  }
  lines.push('---', name);

  return { subject: slots.subject, html, text: lines.join('\n') };
}
