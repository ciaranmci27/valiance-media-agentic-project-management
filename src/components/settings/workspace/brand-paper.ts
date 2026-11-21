/**
 * Fixed surfaces the Brand page previews on, whatever the app's theme.
 * Theme tokens flip in the light theme, so these stay fixed on purpose.
 *
 * - Paper: the light-background logo's thumbnail (the light sign-in page
 *   and light invoice PDFs are white).
 * - Email: outgoing emails are dark in every theme (EMAIL in
 *   src/lib/email/templates/shared.ts), so the email preview uses their card,
 *   ink and hairline colors.
 */
export const PAPER = '#ffffff';
export const PAPER_INK = '#18181b';

export const EMAIL_CARD = '#0D0F14';
export const EMAIL_INK = '#F5F3EF';
export const EMAIL_RULE = '#1F2229';
