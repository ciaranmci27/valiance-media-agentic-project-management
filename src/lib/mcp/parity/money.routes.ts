import 'server-only';
import type { HttpMethod } from '../core';
import * as retainers from '@/app/api/v1/projects/[id]/retainers/route';
import * as retainer from '@/app/api/v1/projects/[id]/retainers/[retainerId]/route';
import * as retainerAmounts from '@/app/api/v1/projects/[id]/retainers/[retainerId]/amounts/route';
import * as retainerPeriods from '@/app/api/v1/projects/[id]/retainers/[retainerId]/periods/route';
import * as retainerDuePeriods from '@/app/api/v1/projects/[id]/retainers/due-periods/route';
import * as billingPlan from '@/app/api/v1/projects/[id]/billing-plan/route';
import * as invoiceDetails from '@/app/api/v1/billing/invoice-details/route';
import * as hourApprovals from '@/app/api/v1/time/hour-approvals/route';

/** Billing and money: the v1 route module behind each tool path (routes.ts merges these). */
export const MONEY_ROUTE_MODULES: Record<string, Partial<Record<HttpMethod, unknown>>> = {
  // Retainers
  '/api/v1/projects/{id}/retainers': retainers,
  '/api/v1/projects/{id}/retainers/{retainerId}': retainer,
  '/api/v1/projects/{id}/retainers/{retainerId}/amounts': retainerAmounts,
  '/api/v1/projects/{id}/retainers/{retainerId}/periods': retainerPeriods,
  '/api/v1/projects/{id}/retainers/due-periods': retainerDuePeriods,
  // Billing plan
  '/api/v1/projects/{id}/billing-plan': billingPlan,
  // Company invoice details
  '/api/v1/billing/invoice-details': invoiceDetails,
  // Hour approvals
  '/api/v1/time/hour-approvals': hourApprovals,
};
