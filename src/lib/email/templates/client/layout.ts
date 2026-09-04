/**
 * Client-facing email layout and the small pieces every client template
 * shares: the project mark, the header stack, the greeting, the usage meter.
 *
 * Built on the shared email language in `../shared`. Client emails differ
 * from team emails only in their footer and in where the lockup links.
 */

import {
  EMAIL,
  FONT_MONO,
  FONT_SANS,
  accentPalette,
  emailLayout,
  escapeHtml,
  footerLine,
  footerLink,
  getSiteName,
  heading,
  metaLine,
  progressBar,
} from '../shared';

interface ClientLayoutOptions {
  preheader?: string;
  body: string;
  portalUrl?: string | null;
}

/**
 * The project's mark: a round portal logo on a dark tile, or a teal-tinted
 * disc carrying the project's first initial when no logo is set.
 */
export function clientAvatar(projectName: string, logoUrl?: string, size = 44): string {
  const safeAlt = escapeHtml(projectName);
  if (logoUrl) {
    return `<img src="${escapeHtml(logoUrl)}" alt="${safeAlt}" width="${size}" height="${size}" style="display: block; width: ${size}px; height: ${size}px; border-radius: 50%; object-fit: cover; border: 1px solid ${EMAIL.border}; background-color: ${EMAIL.tile};" />`;
  }
  const initial = escapeHtml((projectName.trim()[0] || '?').toUpperCase());
  const teal = accentPalette();
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: separate;"><tr><td width="${size}" height="${size}" align="center" valign="middle" style="width: ${size}px; height: ${size}px; border-radius: 50%; border: 1px solid ${teal.border}; background-color: ${teal.tile}; font-family: ${FONT_MONO}; font-size: ${Math.round(size * 0.4)}px; font-weight: 500; line-height: ${size}px; color: ${teal.bright}; text-align: center;">${initial}</td></tr></table>`;
}

/** Mark, title with its serif tail, and the mono line of facts beneath. */
export function clientHeader(options: {
  projectName: string;
  logoUrl?: string;
  title: string;
  tail?: string;
  meta: string[];
}): string {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 22px 0;">
      <tr><td>${clientAvatar(options.projectName, options.logoUrl, 44)}</td></tr>
    </table>
    ${heading(options.title, options.tail)}
    ${metaLine(options.meta)}`;
}

/** "Hi Sarah," on its own line, tight to the paragraph that follows. */
export function greeting(clientName: string): string {
  return `<p style="margin: 0 0 6px 0; font-family: ${FONT_SANS}; font-size: 15px; line-height: 1.65; color: ${EMAIL.body};">Hi ${escapeHtml(clientName)},</p>`;
}

/**
 * A progress bar with a mono caption on each end. Turns copper once usage
 * passes 90 percent so the attention state reads before the numbers do.
 */
export function usageMeter(options: { percent: number; left: string; right: string }): string {
  const tone = options.percent >= 90 ? 'copper' : 'teal';
  const leftColor = tone === 'copper' ? EMAIL.copper300 : accentPalette().bright;
  return `
    ${progressBar(options.percent, { tone, margin: '0 0 8px 0' })}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 0 0 20px 0;">
      <tr>
        <td style="font-family: ${FONT_MONO}; font-size: 12px; line-height: 1.5; letter-spacing: 0.04em; color: ${leftColor};">${escapeHtml(options.left)}</td>
        <td align="right" style="font-family: ${FONT_MONO}; font-size: 12px; line-height: 1.5; letter-spacing: 0.04em; color: ${EMAIL.muted}; text-align: right;">${escapeHtml(options.right)}</td>
      </tr>
    </table>`;
}

export function clientEmailLayout(options: ClientLayoutOptions): string {
  const { preheader, body, portalUrl } = options;
  const safeName = escapeHtml(getSiteName());
  const year = new Date().getFullYear();

  const footerHtml = `
    ${footerLine(`You are receiving this as a client of ${safeName}.`)}
    ${portalUrl
      ? footerLine(`${footerLink(portalUrl, 'View your project portal')} &nbsp;&middot;&nbsp; &copy; ${year} ${safeName}`)
      : footerLine(`&copy; ${year} ${safeName}`)}`;

  return emailLayout({
    preheader,
    body,
    footerHtml,
    // Client emails link the lockup to the project portal when one exists.
    // With no portal, the lockup gets no link at all so clients are never
    // sent to an app they cannot log into.
    logoHref: portalUrl ?? null,
  });
}
