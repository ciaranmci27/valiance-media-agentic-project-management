'use client';

import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { NumberInput } from '@/components/ui/inputs/NumberInput';
import { Select } from '@/components/ui/inputs/Select';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { controlFor, INSTRUCTIONS_MAX, optionsOf } from '@/lib/agents-ui';
import type { SettingsField, SettingsValue, SettingsValues } from '@/lib/agent-workspace';

/**
 * A form built from a template's declared settings: each field's type picks
 * its control (lib/agents-ui controlFor), in the order the template lists
 * them, with the field's own label, help and placeholder. A template that
 * declares none shows one quiet line instead. Errors are keyed by field.
 */
export function SettingsForm({ schema, values, onChange, errors = {}, disabled = false, idPrefix }: {
  schema: readonly SettingsField[];
  values: SettingsValues;
  onChange: (values: SettingsValues) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
  /** Keeps ids unique when several forms share a page (one per project). */
  idPrefix: string;
}) {
  if (schema.length === 0) {
    return <p className="text-sm text-zinc-500">This template has no settings to fill in.</p>;
  }
  const set = (key: string, value: SettingsValue) => onChange({ ...values, [key]: value });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {schema.map((field) => {
        const id = `${idPrefix}-${field.key}`;
        const value = values[field.key];
        const error = errors[field.key];
        const label = field.required ? `${field.label} *` : field.label;
        const control = controlFor(field);
        const wide = control === 'textarea' || control === 'toggle' || control === 'regex';
        const help = field.help ? <span className="mt-1 block text-xs leading-relaxed text-zinc-500">{field.help}</span> : null;
        return (
          <div key={field.key} className={wide ? 'sm:col-span-2' : ''}>
            {control === 'toggle' ? (
              <Toggle
                id={id}
                checked={value === true}
                onChange={(checked) => set(field.key, checked)}
                label={field.label}
                description={field.help}
                error={error}
                disabled={disabled}
              />
            ) : control === 'textarea' ? (
              <>
                <Textarea id={id} label={label} value={String(value ?? '')} onChange={(v) => set(field.key, v)} placeholder={field.placeholder} rows={3} error={error} disabled={disabled} maxLength={field.max} />
                {help}
              </>
            ) : control === 'number' ? (
              <>
                <NumberInput
                  id={id}
                  label={label}
                  value={typeof value === 'number' ? value : value === null || value === undefined ? '' : String(value)}
                  onChange={(v) => set(field.key, v === '' ? null : v)}
                  min={field.min}
                  max={field.max}
                  placeholder={field.placeholder}
                  error={error}
                  disabled={disabled}
                />
                {help}
              </>
            ) : control === 'select' || control === 'search-select' ? (
              <>
                <Select
                  id={id}
                  label={label}
                  value={value === null || value === undefined ? '' : String(value)}
                  onChange={(v) => set(field.key, v || null)}
                  options={[
                    ...(field.required ? [] : [{ value: '', label: 'None' }]),
                    ...optionsOf(field),
                  ]}
                  placeholder={field.placeholder ?? 'Choose'}
                  searchable={control === 'search-select'}
                  error={error}
                  disabled={disabled}
                />
                {help}
              </>
            ) : (
              <>
                <TextInput
                  id={id}
                  label={label}
                  type={control === 'url' ? 'url' : 'text'}
                  value={String(value ?? '')}
                  onChange={(v) => set(field.key, v)}
                  placeholder={field.placeholder ?? (control === 'url' ? 'https://' : control === 'regex' ? 'For example ^supabase/|\\.env' : undefined)}
                  inputClassName={control === 'regex' ? 'font-mono' : undefined}
                  spellCheck={control === 'regex' ? false : undefined}
                  error={error}
                  disabled={disabled}
                  maxLength={field.max}
                />
                {help}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** What an agent should know or do on one project only. */
export function InstructionsField({ id, value, onChange, error, disabled }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <Textarea
      id={id}
      label="Instructions for this project"
      value={value}
      onChange={onChange}
      placeholder="What this agent should know or do here only. Plain words."
      rows={4}
      maxLength={INSTRUCTIONS_MAX}
      showCharCount={value.length > INSTRUCTIONS_MAX * 0.8}
      error={error}
      disabled={disabled}
    />
  );
}
