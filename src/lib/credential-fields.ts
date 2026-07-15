import type { CredentialCategory } from './types';

/**
 * Single source of truth for what a credential of each type stores.
 * Drives the admin form, the portal submission form, the reveal display,
 * and server-side filtering of sensitive fields. Values live inside the
 * encrypted payload, so adding/removing fields here needs no migration.
 */
export interface CredentialFieldDef {
  key: string;
  label: string;
  placeholder: string;
  /** Masked in reveal views; rendered as a password input; stripped from portal edit prefill */
  sensitive?: boolean;
  /** Rendered as a textarea (e.g. SSH private keys) */
  multiline?: boolean;
  /** Rendered at half width alongside the next half-width field */
  half?: boolean;
  /** Rendered as a select with these options */
  options?: string[];
}

export const CREDENTIAL_FIELDS: Record<CredentialCategory, CredentialFieldDef[]> = {
  login: [
    { key: 'username', label: 'Username', placeholder: 'Username or email', half: true },
    { key: 'password', label: 'Password', placeholder: 'Password', sensitive: true, half: true },
    { key: 'url', label: 'URL', placeholder: 'https://... (optional)' },
  ],
  api_key: [
    { key: 'api_key', label: 'API Key', placeholder: 'Key / token', sensitive: true },
    { key: 'api_secret', label: 'API Secret', placeholder: 'Secret (optional)', sensitive: true },
    { key: 'url', label: 'Service URL', placeholder: 'https://... (optional)' },
  ],
  ssh_key: [
    { key: 'host', label: 'Host', placeholder: 'server.example.com', half: true },
    { key: 'username', label: 'Username', placeholder: 'root', half: true },
    { key: 'private_key', label: 'Private Key', placeholder: '-----BEGIN OPENSSH PRIVATE KEY-----', sensitive: true, multiline: true },
    { key: 'passphrase', label: 'Passphrase', placeholder: 'Passphrase (optional)', sensitive: true },
  ],
  database: [
    { key: 'host', label: 'Host', placeholder: 'db.example.com', half: true },
    { key: 'port', label: 'Port', placeholder: '5432', half: true },
    { key: 'database', label: 'Database', placeholder: 'Database name', half: true },
    { key: 'username', label: 'Username', placeholder: 'Username', half: true },
    { key: 'password', label: 'Password', placeholder: 'Password', sensitive: true },
  ],
  credit_card: [
    { key: 'cardholder', label: 'Name on Card', placeholder: 'Name as it appears on the card' },
    { key: 'card_number', label: 'Card Number', placeholder: 'Card number', sensitive: true },
    { key: 'expiry', label: 'Expiry', placeholder: 'MM/YY', half: true },
    { key: 'cvc', label: 'CVC', placeholder: 'CVC', sensitive: true, half: true },
    { key: 'billing_zip', label: 'Billing ZIP', placeholder: 'ZIP / postal code (optional)' },
  ],
  ach: [
    { key: 'account_holder', label: 'Account Holder', placeholder: 'Name on the account' },
    { key: 'bank_name', label: 'Bank Name', placeholder: 'Bank name (optional)' },
    { key: 'routing_number', label: 'Routing Number', placeholder: '9-digit routing number', half: true },
    { key: 'account_number', label: 'Account Number', placeholder: 'Account number', sensitive: true, half: true },
    { key: 'account_type', label: 'Account Type', placeholder: 'Account type', options: ['Checking', 'Savings'], half: true },
  ],
};

/** Every key any category marks sensitive (covers legacy payloads too, since
 *  legacy rows only ever stored username/password/url/notes). */
export const SENSITIVE_FIELD_KEYS: ReadonlySet<string> = new Set(
  Object.values(CREDENTIAL_FIELDS).flatMap(defs => defs.filter(d => d.sensitive).map(d => d.key)),
);

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_FIELD_KEYS.has(key);
}

/** Display label for a payload key, falling back to a humanized key for
 *  legacy fields that aren't part of the row's current category. */
export function credentialFieldLabel(category: CredentialCategory, key: string): string {
  const def = CREDENTIAL_FIELDS[category]?.find(d => d.key === key);
  if (def) return def.label;
  if (key === 'notes') return 'Notes';
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
