'use client';

import Modal from '@/components/ui/Modal';
import { ClientEmailAddresses } from '@/components/projects/ClientEmailAddresses';
import { ClientEmailDomains } from '@/components/projects/ClientEmailDomains';
import { ProjectEmailAddresses } from '@/components/projects/ProjectEmailAddresses';

interface ProjectEmailRoutingModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
}

/**
 * Everything that decides which client email lands on this project: who
 * sends it (client addresses and domains), then the project's own addresses.
 */
export function ProjectEmailRoutingModal({ isOpen, onClose, projectId }: ProjectEmailRoutingModalProps) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Email routing" size="lg">
      <div className="space-y-5">
        <ClientEmailAddresses isOpen={isOpen} projectId={projectId} />
        <ClientEmailDomains isOpen={isOpen} projectId={projectId} />
        <ProjectEmailAddresses isOpen={isOpen} projectId={projectId} />
      </div>
    </Modal>
  );
}
