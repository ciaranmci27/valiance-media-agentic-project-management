import { redirect } from 'next/navigation';

/**
 * The old per-project agent page. A project's agents, their settings and
 * its brief now live on the project itself (its Agents and Brief tabs), so
 * old links land there. The fleet-only cards it used to show (autonomy,
 * repo and branch, audit queue, pipeline strip) are no longer part of core
 * screens.
 */
export default async function AgentProjectRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/projects/${encodeURIComponent(id)}?tab=agents`);
}
