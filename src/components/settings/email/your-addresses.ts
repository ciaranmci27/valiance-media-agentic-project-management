import type { YourAddress, YourAddressInbox } from '@/lib/communications/inbox-types';

/** Small helpers shared by Settings > Email > Your addresses and its parts. */

/** The Select value for "no project" and for the company. */
export const NONE = '';

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const DOMAIN_PATTERN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const domainOfAddress = (address: string) => address.slice(address.lastIndexOf('@') + 1).toLowerCase();

/**
 * Where the forwarder for this address points: its own relay address, or,
 * with none, the relay address of the inbox it delivers to.
 */
export function nextHop(row: YourAddress, inbox: YourAddressInbox | undefined): string | null {
  return row.routing_address ?? inbox?.routing_address ?? null;
}

/**
 * Focuses what `target` finds once the change that renders it has painted
 * (two frames, so an update made after an await has committed), else
 * `fallback`: for focus after a row, item or form goes away.
 */
export function focusAfterPaint(target: () => HTMLElement | null | undefined, fallback?: () => HTMLElement | null | undefined) {
  requestAnimationFrame(() => requestAnimationFrame(() => (target() ?? fallback?.())?.focus()));
}
