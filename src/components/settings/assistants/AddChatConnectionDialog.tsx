'use client';

import { useState } from 'react';
import { Building2, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import Modal from '@/components/ui/Modal';
import { PasswordInput } from '@/components/ui/inputs/PasswordInput';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ChoiceCard, ChoiceGroup, StepFooter, StepPanel, Stepper, type FlowStep } from '@/components/ui/Stepper';
import { workspaceApi } from '@/lib/agent-workspace';
import { CHAT_APPS, CHAT_PROVIDERS, chatAppConnectable, chatProviderLabel, type ChatConnectionKind, type ChatConnectionView, type ChatProvider } from '@/lib/chat/types';
import { DISCORD_RELAY_WHY, DiscordRelaySecret } from './DiscordRelay';

const STEPS: readonly FlowStep[] = [
  { key: 'app', label: 'Chat app' },
  { key: 'kind', label: 'Who it serves' },
  { key: 'connect', label: 'Connect' },
];

/** Discord's one extra step: the relay that holds its Gateway, and the secret it signs with (shown once). */
const DISCORD_STEPS: readonly FlowStep[] = [...STEPS, { key: 'relay', label: 'Run the relay' }];

const KIND_CHOICES: Record<ChatConnectionKind, { title: string; line: string }> = {
  personal: { title: 'Personal assistants', line: 'Personal: each person DMs the bot and reaches their own assistant.' },
  company: { title: 'Company AI', line: 'Company: the bot answers in channels and DMs as your company AI agents.' },
};

/** The Slack bot events each kind subscribes to, said once here and on the Request URL step. */
export const SLACK_EVENTS: Record<ChatConnectionKind, string> = {
  personal: 'message.im',
  company: 'message.im, message.channels and message.groups',
};

/** The Slack bot scopes each kind needs. chat:write.customize lets replies carry the agent's name and avatar. */
const SLACK_SCOPES: Record<ChatConnectionKind, string> = {
  personal: 'chat:write, chat:write.customize and im:history',
  company: 'chat:write, chat:write.customize, im:history, im:write, channels:history, groups:history, channels:read and groups:read',
};

/**
 * Add a chat app, one step at a time: which app, who it serves (each
 * person's own assistant in DMs, or company AI in channels and DMs), then
 * the tokens, checked with the provider before anything is saved. Only free
 * slots are offered (`free`, from freeChatKinds): a fully connected app and
 * a kind already connected show as such and cannot be picked. Opened from an
 * app's card, it starts on who it serves with that app chosen. Answers the
 * new connection; Slack's Request URL is shown by the section after.
 * Discord ends on one more step: its relay secret, shown once, with the
 * relay's address and guide. While it is on screen only Done closes the
 * dialog (no backdrop, Escape or X), and Done answers the connection.
 */
export function AddChatConnectionDialog({ isOpen, initialProvider, free, onClose, onAdded }: {
  isOpen: boolean;
  /** Chosen already (the empty state's Connect): the flow starts on who it serves. */
  initialProvider?: ChatProvider | null;
  free: Record<ChatProvider, ChatConnectionKind[]>;
  onClose: () => void;
  onAdded: (connection: ChatConnectionView) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal isOpen={isOpen} onClose={() => { if (!busy) onClose(); }} title="Add chat app" size="lg">
      {isOpen && <AddFlow initialProvider={initialProvider ?? null} free={free} onBusy={setBusy} onAdded={onAdded} />}
    </Modal>
  );
}

/** The only kind still free, picked for you; null when both or none are. */
const onlyFree = (kinds: ChatConnectionKind[] | undefined) => (kinds?.length === 1 ? kinds[0] : null);

function AddFlow({ initialProvider, free, onBusy, onAdded }: {
  initialProvider: ChatProvider | null;
  free: Record<ChatProvider, ChatConnectionKind[]>;
  onBusy: (busy: boolean) => void;
  onAdded: (connection: ChatConnectionView) => void;
}) {
  const startProvider = initialProvider && chatAppConnectable(initialProvider) && free[initialProvider]?.length ? initialProvider : null;
  const [step, setStep] = useState(startProvider ? 1 : 0);
  const [reached, setReached] = useState(startProvider ? 1 : 0);
  const [provider, setProvider] = useState<ChatProvider | null>(startProvider);
  const [kind, setKind] = useState<ChatConnectionKind | null>(() => (startProvider ? onlyFree(free[startProvider]) : null));
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** A Discord connection just made, with its relay secret: the last step shows it once. */
  const [relay, setRelay] = useState<{ connection: ChatConnectionView; secret: string } | null>(null);

  const steps = provider === 'discord' ? DISCORD_STEPS : STEPS;
  const connectStep = STEPS.length - 1;
  const freeKinds = provider ? free[provider] : [];
  const firstOpenApp = CHAT_PROVIDERS.find((p) => chatAppConnectable(p) && free[p].length > 0) ?? null;
  const firstOpenKind = freeKinds[0] ?? null;

  const go = (index: number) => { setError(null); setStep(index); setReached((prev) => Math.max(prev, index)); };
  const next = () => {
    if (step === 0 && !provider) return setError('Choose a chat app.');
    if (step === 1 && !kind) return setError('Choose who it serves.');
    go(step + 1);
  };
  const pickProvider = (value: ChatProvider) => {
    setError(null);
    if (value === provider) return;
    setProvider(value);
    setKind(onlyFree(free[value]));
    setReached(0);
  };
  const canConnect = provider === 'slack' ? botToken.trim().length > 0 && signingSecret.trim().length > 0 : botToken.trim().length > 0;

  const connect = async () => {
    if (!kind || !provider) return;
    if (!canConnect) return setError(provider === 'slack' ? 'Paste the bot token and the signing secret.' : 'Paste the bot token.');
    setSaving(true);
    onBusy(true);
    setError(null);
    let shown = false;
    try {
      const body = provider === 'slack'
        ? { provider, kind, bot_token: botToken.trim(), signing_secret: signingSecret.trim() }
        : { provider, kind, bot_token: botToken.trim() };
      const made = await workspaceApi<ChatConnectionView>('/api/workspace/chat-connections', { method: 'POST', body });
      if (made.relay_secret) {
        // Kept on screen until Done: the dialog stays locked meanwhile.
        shown = true;
        setRelay({ connection: made, secret: made.relay_secret });
        setStep(connectStep + 1);
        setReached(connectStep + 1);
      } else {
        onAdded(made);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Could not connect. Try again.');
    } finally {
      setSaving(false);
      if (!shown) onBusy(false);
    }
  };
  const finish = () => {
    if (!relay) return;
    onBusy(false);
    // The secret stays here: nothing after the dialog keeps it.
    onAdded({ ...relay.connection, relay_secret: undefined });
  };

  return (
    <div className="space-y-6">
      <Stepper steps={steps} current={step} reached={reached} onJump={(index) => { if (!relay) go(index); }} label="Add chat app progress" />

      {step === 0 && (
        <StepPanel stepKey="app" title="Which chat app" description="Bot tokens are stored encrypted.">
          <ChoiceGroup label="Chat app" className="grid gap-3 sm:grid-cols-3">
            {CHAT_APPS.map((app) => {
              const available = chatAppConnectable(app.provider);
              const full = available && free[app.provider as ChatProvider].length === 0;
              return (
                <ChoiceCard
                  key={app.provider}
                  id={`chat-app-${app.provider}`}
                  selected={provider === app.provider}
                  focusable={provider ? provider === app.provider : firstOpenApp === app.provider}
                  disabled={!available || full}
                  onSelect={() => { if (available && !full) pickProvider(app.provider as ChatProvider); }}
                  icon={<ProviderLogo provider={app.provider} size={20} />}
                  title={app.name}
                  description={app.line}
                  meta={!available ? 'Coming soon' : full ? 'Already connected' : null}
                />
              );
            })}
          </ChoiceGroup>
        </StepPanel>
      )}

      {step === 1 && provider && (
        <StepPanel stepKey="kind" title="Who it serves" description={`Each needs its own ${chatProviderLabel(provider)} bot.`}>
          <ChoiceGroup label="Who it serves" className="grid gap-3 sm:grid-cols-2">
            {(['personal', 'company'] as const).map((value) => {
              const taken = !freeKinds.includes(value);
              return (
                <ChoiceCard
                  key={value}
                  id={`chat-kind-${value}`}
                  selected={kind === value}
                  focusable={kind ? kind === value : firstOpenKind === value}
                  disabled={taken}
                  onSelect={() => { if (!taken) { setKind(value); setError(null); } }}
                  icon={value === 'personal' ? <UserRound size={18} /> : <Building2 size={18} />}
                  title={KIND_CHOICES[value].title}
                  description={KIND_CHOICES[value].line}
                  meta={taken ? 'Already connected' : null}
                />
              );
            })}
          </ChoiceGroup>
        </StepPanel>
      )}

      {step === 2 && kind && provider && (
        <StepPanel stepKey="connect" title={`Connect ${chatProviderLabel(provider)}`} description={KIND_CHOICES[kind].title}>
          <form onSubmit={(event) => { event.preventDefault(); void connect(); }}>
            {provider === 'slack' ? (
              <ol className="list-decimal space-y-1 pl-4 text-sm text-zinc-300 marker:text-zinc-500">
                <li>At api.slack.com/apps, create an app for your workspace{kind === 'company' ? ', separate from your personal assistants app' : ''}.</li>
                <li>Under OAuth &amp; Permissions, add the bot scopes {SLACK_SCOPES[kind]}, then install it.</li>
                <li>Under App Home, turn on the Messages Tab, so people can message it.</li>
                {kind === 'company' && <li>Invite the bot to each channel it should hear: /invite @your-bot.</li>}
                <li>Paste the Bot User OAuth Token and, from Basic Information, the Signing Secret below.</li>
                <li>After you connect, paste the Request URL we show you into Event Subscriptions.</li>
              </ol>
            ) : provider === 'discord' ? (
              <>
                <p className="mb-3 rounded-lg bg-white/[0.04] px-3 py-2.5 text-sm leading-relaxed text-zinc-300">{DISCORD_RELAY_WHY}</p>
                <ol className="list-decimal space-y-1 pl-4 text-sm text-zinc-300 marker:text-zinc-500">
                  <li>At discord.com/developers/applications, create an application{kind === 'company' ? ', separate from your personal assistants one' : ''}.</li>
                  <li>On its Bot page, turn on Message Content Intent, then press Reset Token and copy the token.</li>
                  <li>Paste the token below. Next you get the bot&apos;s invite link and the secret the relay signs with.</li>
                </ol>
              </>
            ) : (
              <ol className="list-decimal space-y-1 pl-4 text-sm text-zinc-300 marker:text-zinc-500">
                <li>In Telegram, message @BotFather and send /newbot.</li>
                <li>Pick a name; BotFather sends you a token.</li>
                {kind === 'company' && <li>Add the bot to your groups. To hear every message, send BotFather /setprivacy and choose Disable.</li>}
                <li>Paste the token below. We do the rest.</li>
              </ol>
            )}
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <PasswordInput label="Bot token" value={botToken} onChange={(value) => { setBotToken(value); setError(null); }} placeholder={provider === 'slack' ? 'xoxb-...' : provider === 'discord' ? 'MTIz...' : '123456:ABC...'} autoComplete="off" />
              {provider === 'slack' && <PasswordInput label="Signing secret" value={signingSecret} onChange={(value) => { setSigningSecret(value); setError(null); }} autoComplete="off" />}
            </div>
            <button type="submit" className="sr-only" tabIndex={-1}>Connect</button>
          </form>
        </StepPanel>
      )}

      {relay && step === connectStep + 1 && (
        <StepPanel stepKey="relay" title={`${relay.connection.display_name} is connected`} description="One more piece: the relay that passes Discord's messages here.">
          <DiscordRelaySecret connection={relay.connection} secret={relay.secret} />
          <div className="mt-6 flex justify-end">
            <Button onClick={finish}>Done</Button>
          </div>
        </StepPanel>
      )}

      {!relay && (
        <StepFooter
          onBack={step > 0 ? () => go(step - 1) : undefined}
          onNext={step === connectStep ? () => { void connect(); } : next}
          nextLabel={step === connectStep ? 'Connect' : 'Next'}
          nextDisabled={step === connectStep && !canConnect}
          busy={saving}
          busyLabel="Checking"
          error={error}
        />
      )}
    </div>
  );
}
