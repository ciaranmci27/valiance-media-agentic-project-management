/**
 * Agents on projects (pm.project_agents) and the settings a template asks
 * for: the shapes and pure checks the server and the screens share. No
 * server code here, so a form can validate as the person types with the
 * same rules the server applies on save.
 *
 * - An assignment is one agent on one project: active or paused, the
 *   template it was set up from, its settings (values for the fields that
 *   template declares) and its instructions for this project only.
 * - A template declares its settings as an ordered list of fields. Settings
 *   are checked against that list: an unknown key, a wrong type, a missing
 *   required value or a value out of range is refused, each named.
 * - An agent's role label (team_members.agent_role) is for people: finding,
 *   grouping and routing at a glance. It drives no behaviour. It is free
 *   form, checked by shape only.
 */

export const PROJECT_AGENT_STATUSES = ['active', 'paused'] as const;
export type ProjectAgentStatus = (typeof PROJECT_AGENT_STATUSES)[number];

/** Characters of instructions one assignment holds. */
export const PROJECT_AGENT_INSTRUCTIONS_MAX = 8000;
/** Characters of settings, serialized: the database's backstop, far above any template's form. */
export const PROJECT_AGENT_SETTINGS_MAX_CHARS = 16_000;
/** Fields one template may declare. */
export const SETTINGS_FIELDS_MAX = 30;

// ── Role labels ─────────────────────────────────────────────────────────

/** Lowercase words joined by dashes, 1 to 40 characters: builder, code-reviewer. */
export const AGENT_ROLE_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
export const AGENT_ROLE_MAX = 40;

export function isAgentRole(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ROLE_PATTERN.test(value);
}

/** What a person typed, as a role label: trimmed, lowercased, spaces to dashes. Null when it cannot be one. */
export function normalizeAgentRole(value: string): string | null {
  const role = value.trim().toLowerCase().replace(/\s+/g, '-');
  return role === '' ? null : isAgentRole(role) ? role : null;
}

// ── Settings fields ─────────────────────────────────────────────────────

export const SETTINGS_FIELD_TYPES = ['text', 'textarea', 'number', 'boolean', 'select', 'url', 'regex'] as const;
export type SettingsFieldType = (typeof SETTINGS_FIELD_TYPES)[number];

export type SettingsValue = string | number | boolean | null;
export type SettingsValues = Record<string, SettingsValue>;

export interface SettingsOption {
  value: string;
  label: string;
}

/** One field a template declares; the form is built from these, in order. */
export interface SettingsField {
  /** Lowercase letters, numbers and underscores, unique in the template. */
  key: string;
  label: string;
  help?: string;
  type: SettingsFieldType;
  required?: boolean;
  default?: SettingsValue;
  /** select only: plain strings or value and label pairs. */
  options?: (string | SettingsOption)[];
  /** number: the smallest and largest value. Text types: the shortest and longest length. */
  min?: number;
  max?: number;
  placeholder?: string;
}

export const SETTINGS_KEY_PATTERN = /^[a-z][a-z0-9_]{0,59}$/;

/** The longest a text value may be when its field names no max. */
export const SETTINGS_TEXT_MAX: Record<'text' | 'textarea' | 'url' | 'regex', number> = {
  text: 500,
  textarea: 4000,
  url: 2000,
  regex: 500,
};

export function optionValues(field: SettingsField): string[] {
  return (field.options ?? []).map((option) => (typeof option === 'string' ? option : option.value));
}

export type SettingsErrorReason =
  | 'not_an_object'
  | 'unknown_setting'
  | 'wrong_type'
  | 'required'
  | 'out_of_range'
  | 'too_long'
  | 'too_short'
  | 'not_an_option'
  | 'invalid_url'
  | 'invalid_regex'
  | 'too_large';

export interface SettingsError {
  /** The field's key; empty for the settings as a whole. */
  key: string;
  reason: SettingsErrorReason;
  message: string;
}

export type SettingsCheck =
  | { ok: true; settings: SettingsValues }
  | { ok: false; errors: SettingsError[] };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** One value against its field: null when it passes, else the problem. */
export function checkSettingValue(field: SettingsField, value: unknown): SettingsError | null {
  const fail = (reason: SettingsErrorReason, message: string): SettingsError => ({ key: field.key, reason, message: `${field.label}: ${message}` });
  switch (field.type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : fail('wrong_type', 'must be true or false');
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('wrong_type', 'must be a number');
      if (field.min !== undefined && value < field.min) return fail('out_of_range', `must be at least ${field.min}`);
      if (field.max !== undefined && value > field.max) return fail('out_of_range', `must be at most ${field.max}`);
      return null;
    }
    case 'select': {
      if (typeof value !== 'string') return fail('wrong_type', 'must be one of the options');
      return optionValues(field).includes(value) ? null : fail('not_an_option', `must be one of: ${optionValues(field).join(', ')}`);
    }
    default: {
      if (typeof value !== 'string') return fail('wrong_type', 'must be text');
      const max = field.max ?? SETTINGS_TEXT_MAX[field.type];
      if (value.length > max) return fail('too_long', `must be ${max} characters or fewer`);
      if (field.min !== undefined && value.length < field.min) return fail('too_short', `must be at least ${field.min} characters`);
      if (field.type === 'url' && value !== '') {
        let ok = false;
        try {
          const url = new URL(value);
          ok = url.protocol === 'https:' || url.protocol === 'http:';
        } catch {
          ok = false;
        }
        if (!ok) return fail('invalid_url', 'must be a web address starting with https:// or http://');
      }
      if (field.type === 'regex' && value !== '') {
        try {
          new RegExp(value);
        } catch {
          return fail('invalid_regex', 'is not a valid regular expression');
        }
      }
      return null;
    }
  }
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === '';

/**
 * Checks settings against a template's fields and answers the values to
 * store, or every problem found. An unknown key is refused (a template with
 * no fields accepts only {}). A null or empty value for an optional field
 * clears it. withDefaults fills each field left out with its default, which
 * is how a new assignment starts; a required field with a default is then
 * satisfied.
 */
export function validateTemplateSettings(
  fields: readonly SettingsField[] | undefined,
  input: unknown,
  options: { withDefaults?: boolean } = {},
): SettingsCheck {
  const declared = fields ?? [];
  if (input === undefined || input === null) input = {};
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ key: '', reason: 'not_an_object', message: 'Settings must be an object of field values' }] };
  }
  const errors: SettingsError[] = [];
  const byKey = new Map(declared.map((field) => [field.key, field]));
  for (const key of Object.keys(input)) {
    if (!byKey.has(key)) {
      errors.push({
        key,
        reason: 'unknown_setting',
        message: declared.length
          ? `${key} is not a setting of this template. Its settings are: ${declared.map((field) => field.key).join(', ')}`
          : `${key} is not a setting: this template has no settings`,
      });
    }
  }
  const settings: SettingsValues = {};
  for (const field of declared) {
    let value = (input as Record<string, unknown>)[field.key];
    if (isEmpty(value) && options.withDefaults && field.default !== undefined && field.default !== null) value = field.default;
    if (isEmpty(value)) {
      if (field.required) errors.push({ key: field.key, reason: 'required', message: `${field.label} is required` });
      continue;
    }
    const problem = checkSettingValue(field, value);
    if (problem) errors.push(problem);
    else settings[field.key] = value as SettingsValue;
  }
  if (errors.length === 0 && JSON.stringify(settings).length > PROJECT_AGENT_SETTINGS_MAX_CHARS) {
    errors.push({ key: '', reason: 'too_large', message: `Settings must be ${PROJECT_AGENT_SETTINGS_MAX_CHARS} characters or fewer in all` });
  }
  return errors.length ? { ok: false, errors } : { ok: true, settings };
}

/** The settings a new assignment starts with: every field's default. */
export function defaultSettings(fields: readonly SettingsField[] | undefined): SettingsValues {
  const out: SettingsValues = {};
  for (const field of fields ?? []) {
    if (field.default !== undefined && field.default !== null) out[field.key] = field.default;
  }
  return out;
}

/** Errors as { key: message }, for a form to show beside each field. */
export function settingsErrorFields(errors: readonly SettingsError[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const error of errors) if (!(error.key in out)) out[error.key || '_'] = error.message;
  return out;
}

/**
 * A template's declared fields are themselves checked when the template is
 * defined (lib/extensions/agent-templates.ts): answers the first problem in
 * words, or null.
 */
export function settingsFieldsProblem(fields: readonly SettingsField[]): string | null {
  if (!Array.isArray(fields)) return 'settings must be a list of fields';
  if (fields.length > SETTINGS_FIELDS_MAX) return `settings declare more than ${SETTINGS_FIELDS_MAX} fields`;
  const seen = new Set<string>();
  for (const field of fields) {
    if (!field || typeof field !== 'object') return 'each setting must be a field object';
    if (!SETTINGS_KEY_PATTERN.test(field.key ?? '')) return `setting key "${field.key}" must be lowercase letters, numbers and underscores`;
    if (seen.has(field.key)) return `two settings use the key "${field.key}"`;
    seen.add(field.key);
    if (!field.label?.trim()) return `setting "${field.key}" needs a label`;
    if (!(SETTINGS_FIELD_TYPES as readonly string[]).includes(field.type)) return `setting "${field.key}" has an unknown type "${field.type}"`;
    if (field.type === 'select') {
      const values = optionValues(field);
      if (values.length === 0) return `setting "${field.key}" is a select with no options`;
      if (new Set(values).size !== values.length) return `setting "${field.key}" repeats an option`;
    } else if (field.options !== undefined) {
      return `setting "${field.key}" has options but is not a select`;
    }
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) return `setting "${field.key}" has min above max`;
    if (field.default !== undefined && field.default !== null) {
      const problem = checkSettingValue(field, field.default);
      if (problem) return `setting "${field.key}" default: ${problem.message}`;
    }
  }
  return null;
}

// ── Assignments as the API answers them ─────────────────────────────────

export interface AgentOwner {
  id: string;
  name: string;
  avatar_url: string | null;
}

/** One agent on one project, as GET /api/workspace/projects/{id}/agents and an agent's profile read it. */
export interface ProjectAgentAssignment {
  agent_id: string;
  agent_name: string;
  avatar_url: string | null;
  agent_role: string | null;
  status: ProjectAgentStatus;
  template_key: string | null;
  settings: SettingsValues;
  instructions: string;
  /** The template's fields, to draw the settings form; [] without a template. */
  settings_schema: SettingsField[];
  created_at: string;
  updated_at: string;
  project_id: string;
  project_name?: string;
}
