'use client';

import { useId } from 'react';
import Link from 'next/link';
import Modal from '@/components/ui/Modal';
import { ClientEmailAddresses } from '@/components/projects/ClientEmailAddresses';
import { ClientEmailDomains } from '@/components/projects/ClientEmailDomains';
import { ProjectEmailAddresses } from '@/components/projects/ProjectEmailAddresses';
import { EMAIL_PAGES } from '@/components/settings/settings-groups';
import { useAuth } from '@/lib/auth-context';
import { hasPermission } from '@/lib/access-control';

interface ProjectEmailRoutingModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
}

const GROUP_HEADING = 'text-xs font-medium uppercase tracking-wide text-zinc-400';

/**
 * How mail finds this project, in two groups: what it is sent to (this
 * project's addresses, the same records as Settings > Email > Your
 * addresses) and who it is sent from (the client's people and domains).
 */
export function ProjectEmailRoutingModal({ isOpen, onClose, projectId }: ProjectEmailRoutingModalProps) {
  const { access } = useAuth();
  const canManageInboxes = hasPermission(access, 'inbound_email.manage');
  const baseId = useId();

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="How mail finds this project" size="lg">
      <div className="space-y-6">
        <p className="text-sm text-zinc-300">
          Mail lands on this project when it is sent to one of its addresses, or sent from someone at the client.
        </p>

        <section aria-labelledby={`${baseId}-to`} className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <h3 id={`${baseId}-to`} className={GROUP_HEADING}>Sent to</h3>
            {canManageInboxes && (
              <Link
                href={EMAIL_PAGES.addresses}
                className="rounded text-xs text-brand-300 transition-colors hover:text-brand-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              >
                Manage all your addresses
              </Link>
            )}
          </div>
          <ProjectEmailAddresses isOpen={isOpen} projectId={projectId} />
        </section>

        <section aria-labelledby={`${baseId}-from`} className="space-y-4 border-t border-white/[0.06] pt-5">
          <h3 id={`${baseId}-from`} className={GROUP_HEADING}>Sent from</h3>
          <ClientEmailAddresses isOpen={isOpen} projectId={projectId} />
          <ClientEmailDomains isOpen={isOpen} projectId={projectId} />
        </section>
      </div>
    </Modal>
  );
}
