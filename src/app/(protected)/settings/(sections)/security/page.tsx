'use client';

import { AgentsPauseSection } from '@/components/settings/security/AgentsPauseSection';
import { AuditLogSection } from '@/components/settings/security/AuditLogSection';
import { AuditSettingsSection } from '@/components/settings/security/AuditSettingsSection';
import { useSettingsAccess } from '@/components/settings/settings-groups';

/** Security (Owners only): pause every agent at once, read the audit log, and say how long it is kept. */
export default function SecuritySettingsPage() {
  const { show } = useSettingsAccess();
  return (
    <>
      {show.agentsPause && (
        <div id="agents-pause" className="scroll-mt-6">
          <AgentsPauseSection />
        </div>
      )}
      {show.auditLog && (
        <>
          <div id="audit-log" className="scroll-mt-6">
            <AuditLogSection />
          </div>
          <div id="audit-settings" className="scroll-mt-6">
            <AuditSettingsSection />
          </div>
        </>
      )}
    </>
  );
}
