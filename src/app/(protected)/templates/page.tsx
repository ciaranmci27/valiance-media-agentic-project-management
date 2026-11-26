import { redirect } from 'next/navigation';

/**
 * Templates live with the work now: company-wide and project templates in
 * Settings > Templates, a project's own from its Tasks toolbar. Old links
 * and bookmarks land there.
 */
export default function TemplatesRedirect() {
  redirect('/settings/templates');
}
