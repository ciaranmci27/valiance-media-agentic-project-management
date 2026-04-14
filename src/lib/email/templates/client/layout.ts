/**
 * Client-facing email layout wrapper.
 * Uses the project's portal logo (if set) and a client-appropriate footer.
 */

import { emailLayout, getSiteUrl, getSiteName, brandPrimary, brandSubtle, escapeHtml, NEUTRAL } from '../shared';

interface ClientLayoutOptions {
  preheader?: string;
  body: string;
  portalUrl?: string;
  accentColor?: string;
}

/**
 * Small circular avatar for the client's portal logo.
 * Falls back to a brand-tinted circle with the project's first initial
 * when no logoUrl is provided.
 */
export function clientAvatar(projectName: string, logoUrl?: string, size = 40): string {
  const safeAlt = escapeHtml(projectName);
  if (logoUrl) {
    return `
      <img
        src="${logoUrl}"
        alt="${safeAlt}"
        width="${size}"
        height="${size}"
        style="
          display: block;
          width: ${size}px;
          height: ${size}px;
          border-radius: 50%;
          object-fit: cover;
          border: 1px solid ${NEUTRAL.border};
          background-color: ${NEUTRAL.white};
        "
      />
    `;
  }
  const initial = escapeHtml((projectName.trim()[0] || '?').toUpperCase());
  const primary = brandPrimary();
  const subtle = brandSubtle();
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse: separate;">
      <tr>
        <td width="${size}" height="${size}" align="center" valign="middle" style="
          width: ${size}px;
          height: ${size}px;
          background-color: ${subtle};
          border-radius: 50%;
          border: 1px solid ${NEUTRAL.border};
          color: ${primary};
          font-size: ${Math.round(size * 0.42)}px;
          font-weight: 700;
          line-height: ${size}px;
          text-align: center;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        ">${initial}</td>
      </tr>
    </table>
  `;
}

export function clientEmailLayout(options: ClientLayoutOptions): string {
  const { preheader, body, portalUrl } = options;
  const siteUrl = getSiteUrl();
  const name = getSiteName();
  const accent = brandPrimary();

  const footerHtml = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <p style="
            margin: 0 0 6px 0;
            font-size: 12px;
            color: ${NEUTRAL.textMuted};
            line-height: 1.6;
          ">
            You're receiving this as a client of <a href="${siteUrl}" style="color: ${accent}; text-decoration: none; font-weight: 500;">${name}</a>.
          </p>
          ${portalUrl ? `<p style="
            margin: 0;
            font-size: 12px;
            color: ${NEUTRAL.textMuted};
            line-height: 1.6;
          ">
            <a href="${portalUrl}" style="color: ${accent}; text-decoration: underline;">View your project portal</a>
            &middot;
            &copy; ${new Date().getFullYear()} ${name}
          </p>` : `<p style="
            margin: 0;
            font-size: 12px;
            color: ${NEUTRAL.textMuted};
            line-height: 1.6;
          ">
            &copy; ${new Date().getFullYear()} ${name}
          </p>`}
        </td>
      </tr>
    </table>
  `;

  return emailLayout({
    preheader,
    body,
    footerHtml,
    // Client emails link the logo to the project portal when one exists.
    // If no portal is configured, render the logo with no link at all so
    // clients aren't directed to an app they can't access.
    logoHref: portalUrl ?? null,
  });
}
