/**
 * Shared email utilities: layout wrapper, CTA button, and HTML escaping.
 * All email templates import from this file.
 *
 * Brand colors and site name are derived from @/site-config so branding
 * stays in sync across the entire app. Only neutral colors (whites, blacks,
 * greys) are defined here since they work universally with any brand palette.
 */

import { siteConfig } from '@/site-config';

// ─── Neutral palette (brand-agnostic) ──────────────────────────────────────────

const NEUTRAL = {
  white: '#ffffff',
  black: '#1a1a1a',
  textBody: '#374151',
  textMuted: '#6b7280',
  border: '#e5e7eb',
  bgOuter: '#f4f4f5',
};

// ─── Brand-derived helpers ─────────────────────────────────────────────────────

/** Primary brand color (header, buttons, links). */
function brandPrimary(): string {
  return siteConfig.colors.accent;
}

/** Lighter brand shade for accents/borders. */
function brandLight(): string {
  return siteConfig.colors.brand[500] || siteConfig.colors.accent;
}

/** Lightest brand shade for subtle backgrounds. */
function brandSubtle(): string {
  return siteConfig.colors.brand[50] || '#f5f5f5';
}

/** Whether the logo needs an invert filter (matches sidebar logic). */
function shouldInvertLogo(): boolean {
  return siteConfig.invertLogoInSidebar === true;
}

/** Dark sidebar-matching header color. */
const HEADER_BG = '#0F0F12';

/** Darken a hex color by a factor (0-1). Used for button shadow borders. */
function darkenHex(hex: string, factor: number): string {
  const h = hex.replace('#', '');
  const r = Math.round(parseInt(h.substring(0, 2), 16) * (1 - factor));
  const g = Math.round(parseInt(h.substring(2, 4), 16) * (1 - factor));
  const b = Math.round(parseInt(h.substring(4, 6), 16) * (1 - factor));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

// ─── Public utilities ──────────────────────────────────────────────────────────

export function getSiteUrl(): string {
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export function getSiteName(): string {
  return siteConfig.name;
}

/**
 * Escape HTML special characters to prevent XSS in email templates.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Branded CTA button for email templates.
 * Uses border trick for email-safe shadow effect.
 * Color derived from siteConfig.colors.accent.
 */
export function ctaButton(text: string, href: string): string {
  const url = href.startsWith('http') ? href : `${getSiteUrl()}${href}`;
  const bg = brandPrimary();
  const shadow = darkenHex(bg, 0.2);

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
      <tr>
        <td style="
          background-color: ${bg};
          border-radius: 8px;
          border-bottom: 3px solid ${shadow};
          padding: 12px 32px;
        ">
          <a href="${url}" target="_blank" style="
            color: ${NEUTRAL.white};
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 15px;
            font-weight: 600;
            text-decoration: none;
            display: inline-block;
          ">${text}</a>
        </td>
      </tr>
    </table>
  `;
}

/**
 * Wrap email body HTML in the branded layout.
 * All branding (name, colors, logo) derived from siteConfig.
 */
export function emailLayout(options: {
  preheader?: string;
  body: string;
}): string {
  const { preheader, body } = options;
  const siteUrl = getSiteUrl();
  const name = getSiteName();
  const primary = brandPrimary();
  const accent = brandLight();
  const subtle = brandSubtle();

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
</head>
<body style="
  margin: 0;
  padding: 0;
  background-color: ${NEUTRAL.bgOuter};
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${NEUTRAL.bgOuter};">${preheader}</div>` : ''}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color: ${NEUTRAL.bgOuter};">
    <tr>
      <td align="center" style="padding: 40px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="
          max-width: 600px;
          width: 100%;
          border: 1px solid ${NEUTRAL.border};
          border-radius: 12px;
          overflow: hidden;
        ">

          <!-- Header -->
          <tr>
            <td style="
              background-color: ${HEADER_BG};
              padding: 16px 40px;
              border-bottom: 2px solid ${primary};
            ">
              <a href="${siteUrl}" target="_blank" style="text-decoration: none; color: ${NEUTRAL.white}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 20px; font-weight: 700;">
                <!--[if !mso]><!-->
                <img
                  src="${siteUrl}/logos/logo.png"
                  alt="${name}"
                  style="display: inline-block; border: 0; outline: none; height: auto; width: auto; max-height: 44px; color: ${NEUTRAL.white}; font-size: 20px; font-weight: 700;${shouldInvertLogo() ? ' filter: invert(1);' : ''}"
                />
                <!--<![endif]-->
                <!--[if mso]>
                <span style="color: ${NEUTRAL.white}; font-size: 20px; font-weight: 700;">${name}</span>
                <![endif]-->
              </a>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="
              background-color: ${NEUTRAL.white};
              padding: 32px 40px;
              color: ${NEUTRAL.black};
              font-size: 15px;
              line-height: 1.7;
            ">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="
              background-color: ${subtle};
              padding: 20px 40px;
              border-top: 1px solid ${NEUTRAL.border};
            ">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <p style="
                      margin: 0 0 6px 0;
                      font-size: 12px;
                      color: ${NEUTRAL.textMuted};
                      line-height: 1.6;
                    ">
                      You received this because email notifications are enabled in your account.
                    </p>
                    <p style="
                      margin: 0;
                      font-size: 12px;
                      color: ${NEUTRAL.textMuted};
                      line-height: 1.6;
                    ">
                      <a href="${siteUrl}/settings" style="color: ${primary}; text-decoration: underline;">Manage notification preferences</a>
                      &middot;
                      &copy; ${new Date().getFullYear()} <a href="${siteUrl}" style="color: ${primary}; text-decoration: none; font-weight: 500;">${name}</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}
