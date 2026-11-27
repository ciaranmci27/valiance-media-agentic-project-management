import { currentAuditVia } from './request-context';

/**
 * Which door a shared write came through, for its audit row: a v1 route,
 * with the key that called it, or (left out) the app. Lib functions that the
 * app and the API share take one, so an API call is never logged as the app.
 */
export interface AuditDoor {
  endpoint: string;
  apiKeyId: string;
}

/** The endpoint, key and via an audit row records: the app's endpoint when there is no door. */
export function auditDoorFields(door: AuditDoor | undefined, appEndpoint: string): { endpoint: string; via: string; api_key_id?: string } {
  if (!door) return { endpoint: appEndpoint, via: 'app' };
  return { endpoint: door.endpoint, api_key_id: door.apiKeyId, via: currentAuditVia() };
}
