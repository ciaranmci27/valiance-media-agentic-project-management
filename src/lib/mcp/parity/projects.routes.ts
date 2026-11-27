import 'server-only';
import type { HttpMethod } from '../core';
import * as projectArchive from '@/app/api/v1/projects/[id]/archive/route';
import * as projectGoal from '@/app/api/v1/projects/[id]/goals/[goalId]/route';
import * as scopedContextEntry from '@/app/api/v1/context/[entryId]/route';
import * as projectContacts from '@/app/api/v1/projects/[id]/contacts/route';
import * as projectContact from '@/app/api/v1/projects/[id]/contacts/[contactId]/route';
import * as entityFiles from '@/app/api/v1/entity-files/route';
import * as entityFile from '@/app/api/v1/entity-files/[fileId]/route';
import * as portal from '@/app/api/v1/projects/[id]/portal/route';
import * as portalUpdates from '@/app/api/v1/projects/[id]/portal/updates/route';
import * as portalUpdate from '@/app/api/v1/projects/[id]/portal/updates/[updateId]/route';

/** Projects, goals and brief entries: the v1 route module behind each tool path (routes.ts merges these). */
export const PROJECTS_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  '/api/v1/projects/{id}/archive': projectArchive,
  '/api/v1/projects/{id}/goals/{goalId}': projectGoal,
  '/api/v1/context/{entryId}': scopedContextEntry,
  '/api/v1/projects/{id}/contacts': projectContacts,
  '/api/v1/projects/{id}/contacts/{contactId}': projectContact,
  '/api/v1/entity-files': entityFiles,
  '/api/v1/entity-files/{fileId}': entityFile,
  '/api/v1/projects/{id}/portal': portal,
  '/api/v1/projects/{id}/portal/updates': portalUpdates,
  '/api/v1/projects/{id}/portal/updates/{updateId}': portalUpdate,
};
