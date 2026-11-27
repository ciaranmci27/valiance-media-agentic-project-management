import 'server-only';
import type { HttpMethod } from '../core';
import * as notificationPreferences from '@/app/api/v1/me/notification-preferences/route';
import * as brandLogo from '@/app/api/v1/workspace/brand/logo/route';
import * as groupUsage from '@/app/api/v1/groups/[id]/usage/route';
import * as memberProfile from '@/app/api/v1/team-members/[id]/profile/route';
import * as providerPlans from '@/app/api/v1/workspace/provider-plans/route';
import * as providerPlan from '@/app/api/v1/workspace/provider-plans/[id]/route';
import * as analyticsExclusions from '@/app/api/v1/workspace/analytics-exclusions/route';
import * as invite from '@/app/api/v1/team-members/[id]/invite/route';
import * as memberEmail from '@/app/api/v1/team-members/[id]/email/route';

/** Your notification choices and the remaining settings and team reads: the v1 route module behind each tool path (routes.ts merges these). */
// /api/v1/api-keys/{id}/revoke (its GET is the revoke preview) is already in handlers.ts.
export const SETTINGS_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  '/api/v1/me/notification-preferences': notificationPreferences,
  '/api/v1/workspace/brand/logo': brandLogo,
  '/api/v1/groups/{id}/usage': groupUsage,
  '/api/v1/team-members/{id}/profile': memberProfile,
  '/api/v1/workspace/provider-plans': providerPlans,
  '/api/v1/workspace/provider-plans/{id}': providerPlan,
  '/api/v1/workspace/analytics-exclusions': analyticsExclusions,
  '/api/v1/team-members/{id}/invite': invite,
  '/api/v1/team-members/{id}/email': memberEmail,
};
