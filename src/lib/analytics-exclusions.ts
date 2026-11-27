/**
 * The portal analytics IP exclusion list (Settings > Client portal), shared
 * by the settings screen and /api/v1/workspace/analytics-exclusions.
 */

/** How many addresses the list holds at most. */
export const EXCLUDED_IPS_MAX = 100;
export const EXCLUDED_IP_LABEL_MAX = 100;

/**
 * A lenient check for an entered IP: IPv4 dotted-quad and most IPv6 shapes
 * (including '::1'). The portal analytics filter does a literal string
 * match, so anything stricter would just reject legitimate entries pasted in.
 */
export function isPlausibleIp(value: string): boolean {
  const v = value.trim();
  if (v.length === 0 || v.length > 45) return false;
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v)) {
    return v.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
  }
  if (/^[0-9a-fA-F:]+$/.test(v) && v.includes(':')) return true;
  return false;
}
