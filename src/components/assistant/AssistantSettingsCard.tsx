'use client';

import { useEffect, useState } from 'react';
import { Pause, Play, SlidersHorizontal } from 'lucide-react';
import { AgentAvatar } from '@/components/agent/AgentAvatar';
import { Button } from '@/components/ui/Button';
import { TextInput } from '@/components/ui/inputs/TextInput';
import { Textarea } from '@/components/ui/inputs/Textarea';
import { Toggle } from '@/components/ui/inputs/Toggle';
import { toast } from '@/components/ui/Toast';
import {
  ASSISTANT_SWITCHES, ASSISTANT_TONES, AVATAR_TONES, PERSONALITY_MAX, SWITCH_WORDS, TONE_WORDS,
  type AssistantSwitch, type AssistantTone, type MyAssistantView,
} from '@/lib/assistant';
import { saveMyAssistant } from './assistant-api';

type Assistant = NonNullable<MyAssistantView['assistant']>;

const TONE_BG = ['', 'bg-avatar-1', 'bg-avatar-2', 'bg-avatar-3', 'bg-avatar-4', 'bg-avatar-5', 'bg-avatar-6', 'bg-avatar-7', 'bg-avatar-8'];

/**
 * My Assistant's settings: name, avatar tone, tone of voice, a note on how
 * the person likes to work, five plain switches, and pause or resume. While
 * it is paused, what they send it in chat waits and reaches it when they
 * resume (the newest 20, oldest first). Each
 * switch and the tone apply at once (rolled back with a message if the save
 * fails); the name and note save on their own button or Enter.
 */
export function AssistantSettingsCard({ assistant, isDemo }: { assistant: Assistant; isDemo: boolean }) {
  const [name, setName] = useState(assistant.name);
  const [note, setNote] = useState(assistant.preferences.personality ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setName(assistant.name), [assistant.name]);
  useEffect(() => setNote(assistant.preferences.personality ?? ''), [assistant.preferences.personality]);

  const pausedByYou = assistant.state === 'paused';
  const pausedByAdmin = assistant.state === 'on_hold' && assistant.reason === 'paused_by_admin';

  const save = async (key: string, patch: Parameters<typeof saveMyAssistant>[1], optimistic?: Parameters<typeof saveMyAssistant>[2], done?: string) => {
    setBusy(key);
    try {
      await saveMyAssistant(isDemo, patch, optimistic);
      if (done) toast('success', done);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : 'Could not save. Try again.');
    } finally {
      setBusy(null);
    }
  };

  const flip = (key: AssistantSwitch, value: boolean) => save(key, { switches: { [key]: value } }, (view) => (view.assistant
    ? { ...view, assistant: { ...view.assistant, preferences: { ...view.assistant.preferences, switches: { ...view.assistant.preferences.switches, [key]: value } } } }
    : view));

  const setTone = (tone: AssistantTone) => save('tone', { tone }, (view) => (view.assistant
    ? { ...view, assistant: { ...view.assistant, preferences: { ...view.assistant.preferences, tone } } }
    : view));

  const setAvatar = (avatar_tone: number) => save('avatar', { avatar_tone }, (view) => (view.assistant
    ? { ...view, assistant: { ...view.assistant, avatar_tone } }
    : view));

  const nameChanged = name.trim() !== assistant.name && name.trim().length > 0;
  const noteChanged = note.trim() !== (assistant.preferences.personality ?? '');

  return (
    <section className="glass-card rounded-xl overflow-hidden" aria-labelledby="assistant-settings-heading">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.08]">
        <SlidersHorizontal size={15} className="text-zinc-400" aria-hidden="true" />
        <h2 id="assistant-settings-heading" className="text-sm font-semibold text-white">Settings</h2>
      </div>

      <div className="space-y-5 p-4">
        <div className="flex items-start gap-3">
          <AgentAvatar id={assistant.id} name={name || assistant.name} tone={assistant.avatar_tone} size="lg" />
          <form
            className="min-w-0 flex-1"
            onSubmit={(event) => {
              event.preventDefault();
              if (nameChanged) void save('name', { name: name.trim() }, undefined, 'Name saved');
            }}
          >
            <TextInput label="Name" value={name} onChange={setName} maxLength={60} disabled={isDemo} />
            {nameChanged && (
              <div className="mt-2 flex gap-2">
                <Button type="submit" size="sm" disabled={busy === 'name'}>Save name</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setName(assistant.name)}>Cancel</Button>
              </div>
            )}
          </form>
        </div>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-zinc-400">Color</legend>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: AVATAR_TONES }, (_, index) => index + 1).map((tone) => {
              const selected = assistant.avatar_tone === tone;
              return (
                <button
                  key={tone}
                  type="button"
                  onClick={() => void setAvatar(tone)}
                  disabled={isDemo || busy === 'avatar'}
                  aria-pressed={selected}
                  aria-label={`Color ${tone}`}
                  className={`h-7 w-7 rounded-full ${TONE_BG[tone]} transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-surface)] disabled:cursor-not-allowed ${
                    selected ? 'ring-2 ring-white/80 ring-offset-2 ring-offset-[var(--color-surface-raised)]' : 'hover:scale-110'
                  }`}
                />
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-xs font-medium text-zinc-400">How it writes</legend>
          <div className="grid grid-cols-3 gap-1 rounded-lg bg-white/[0.04] p-1" role="radiogroup" aria-label="How it writes">
            {ASSISTANT_TONES.map((tone) => {
              const selected = assistant.preferences.tone === tone;
              return (
                <button
                  key={tone}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => !selected && void setTone(tone)}
                  disabled={isDemo || busy === 'tone'}
                  className={`rounded-md px-2 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    selected ? 'bg-white/[0.1] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {TONE_WORDS[tone].label}
                </button>
              );
            })}
          </div>
          <p className="mt-1.5 text-xs text-zinc-500">{TONE_WORDS[assistant.preferences.tone].says}</p>
        </fieldset>

        <div>
          <Textarea
            label="How you like to work"
            placeholder="Mornings are for deep work. Keep replies short. My manager is Sam."
            value={note}
            onChange={setNote}
            rows={3}
            maxLength={PERSONALITY_MAX}
            disabled={isDemo}
          />
          {noteChanged && (
            <div className="mt-2 flex gap-2">
              <Button size="sm" disabled={busy === 'note'} onClick={() => void save('note', { personality: note.trim() || null }, undefined, 'Saved')}>Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setNote(assistant.preferences.personality ?? '')}>Cancel</Button>
            </div>
          )}
        </div>

        <div className="space-y-3 border-t border-white/[0.06] pt-4">
          <h3 className="text-xs font-medium text-zinc-400">What it does for you</h3>
          {ASSISTANT_SWITCHES.map((key) => {
            const noInbox = key === 'sort_inbox' && !assistant.has_personal_inbox;
            return (
              <Toggle
                key={key}
                checked={assistant.preferences.switches[key] && !noInbox}
                onChange={(value) => void flip(key, value)}
                disabled={isDemo || busy === key || noInbox}
                label={SWITCH_WORDS[key].label}
                description={noInbox ? 'Connect your own inbox first, in Settings > Email.' : SWITCH_WORDS[key].help}
              />
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/[0.06] pt-4">
          <p className="text-xs text-zinc-500">
            {pausedByAdmin
              ? 'An admin paused it. They can resume it. Chat messages wait for it until then.'
              : pausedByYou
                ? 'Paused: it does nothing until you resume it. Chat messages you send meanwhile reach it when you do.'
                : 'Pause it any time. Chat messages you send while it is paused reach it when you resume (the newest 20).'}
          </p>
          {pausedByYou ? (
            <Button size="sm" icon={<Play size={13} aria-hidden="true" />} disabled={isDemo || busy === 'pause'}
              onClick={() => void save('pause', { paused: false }, undefined, `${assistant.name} resumed`)}>
              Resume
            </Button>
          ) : (
            <Button size="sm" variant="secondary" icon={<Pause size={13} aria-hidden="true" />} disabled={isDemo || pausedByAdmin || busy === 'pause'}
              onClick={() => void save('pause', { paused: true }, undefined, `${assistant.name} paused`)}>
              Pause
            </Button>
          )}
        </div>
      </div>
    </section>
  );
}
