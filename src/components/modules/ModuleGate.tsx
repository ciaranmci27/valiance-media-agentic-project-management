'use client';

import type { ReactNode } from 'react';
import { Lock } from 'lucide-react';
import { useAuth } from '@/lib/auth-context';
import { hasPermission, isModuleEnabled, type PermissionKey } from '@/lib/access-control';
import { MODULES, type ModuleId } from '@/lib/modules/registry';
import { MODULE_ICONS } from '@/components/modules/module-icons';
import { Button } from '@/components/ui/Button';

/** Where an Owner switches modules. */
export const FEATURES_HREF = '/settings/workspace';

/** Children only while the module is on: for a piece of a shared screen. */
export function ModuleGate({ module, children }: { module: ModuleId; children: ReactNode }) {
  const { access } = useAuth();
  return isModuleEnabled(access, module) ? <>{children}</> : null;
}

/**
 * One gate for a whole page or route segment: the module must be on, and the
 * person must hold at least one of `anyOf`. Otherwise it says which of the two
 * it is, in plain words, instead of an empty page.
 */
export function ModulePage({ module, anyOf, children }: { module: ModuleId; anyOf?: PermissionKey[]; children: ReactNode }) {
  const { access, loading } = useAuth();
  if (loading || !access) return null;
  if (!isModuleEnabled(access, module)) return <ModuleOffState module={module} />;
  if (anyOf && !anyOf.some((permission) => hasPermission(access, permission))) return <NoAccessState module={module} />;
  return <>{children}</>;
}

/** The module is switched off for this workspace. */
export function ModuleOffState({ module }: { module: ModuleId }) {
  const { access } = useAuth();
  const definition = MODULES[module];
  const Icon = MODULE_ICONS[module];
  const isOwner = access?.role === 'owner';
  return (
    <FeatureState
      icon={<Icon size={22} aria-hidden="true" />}
      title={`${definition.label} is switched off`}
      body={isOwner
        ? `This workspace doesn't use ${definition.label}. Switch it on in Features and everything comes back as it was. Nothing was deleted.`
        : `This workspace doesn't use ${definition.label}. The workspace owner can switch it on in Settings.`}
      action={isOwner ? <Button href={FEATURES_HREF} variant="secondary" size="sm">Open Features</Button> : null}
    />
  );
}

/** The module is on, but this person may not open it. */
export function NoAccessState({ module }: { module: ModuleId }) {
  return (
    <FeatureState
      icon={<Lock size={20} aria-hidden="true" />}
      title={`You don't have access to ${MODULES[module].label}`}
      body="Ask an Owner or Admin to give you access."
      action={null}
    />
  );
}

function FeatureState({ icon, title, body, action }: { icon: ReactNode; title: string; body: string; action: ReactNode }) {
  return (
    <div className="animate-fadeIn flex min-h-[60vh] items-center justify-center px-4 py-16">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.05] text-zinc-400 ring-1 ring-inset ring-white/[0.06]">
          {icon}
        </div>
        <h1 className="text-base font-semibold tracking-tight text-zinc-100">{title}</h1>
        <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{body}</p>
        {action && <div className="mt-5">{action}</div>}
      </div>
    </div>
  );
}
