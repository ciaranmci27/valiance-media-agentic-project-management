/**
 * The logo bank's rules (src/lib/logos.ts, DESIGN.md Rule 20): every bank id
 * has a mark and a label, the names the app stores resolve to the right
 * mark, an unknown provider gets readable initials, the badge reads in the
 * accessible name, a chat connection's health maps to its badge, and the
 * provider picker's value maps back to a choice or to Other with a name.
 *
 *   npm run -s test:provider-logos
 */
import { LOGO_MARKS } from '../src/components/ui/logos/marks';
import {
  AI_PROVIDER_CHOICES, LOGO_IDS, LOGOS, OTHER_PROVIDER, connectionHealthBadge, logoAccessibleName, logoInitials, logoLabel,
  providerPickerState, resolveLogo,
} from '../src/lib/logos';

let passed = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) passed++;
  else failures.push(detail === undefined ? label : `${label}: ${JSON.stringify(detail)}`);
}

for (const id of LOGO_IDS) {
  const mark = LOGO_MARKS[id];
  check(`${id} has a mark with at least one path`, !!mark && mark.paths.length > 0 && mark.paths.every((p) => p.d.length > 10), id);
  check(`${id} has a label`, !!LOGOS[id]?.label);
}

check('stored names resolve to their mark', resolveLogo('chatgpt')?.id === 'openai' && resolveLogo('ChatGPT')?.label === 'ChatGPT'
  && resolveLogo('claude_code')?.id === 'claude' && resolveLogo('Google Meet')?.id === 'google-meet',
  [resolveLogo('chatgpt'), resolveLogo('claude_code'), resolveLogo('Google Meet')]);
check('a provider the app does not support has no mark and gets its initials', resolveLogo('teams') === null && logoInitials('Microsoft Teams') === 'MT' && resolveLogo('outlook') === null);
check('an unknown provider has no mark and reads as words', resolveLogo('custom.mattermost') === null && logoLabel('custom.mattermost') === 'Mattermost');
check('initials: one letter per word, two at most', logoInitials('Zoho Mail') === 'ZM' && logoInitials('custom.mattermost') === 'M' && logoInitials('a b c') === 'AB',
  [logoInitials('Zoho Mail'), logoInitials('custom.mattermost'), logoInitials('a b c')]);
check('the badge is part of the accessible name', logoAccessibleName('Telegram', 'done') === 'Telegram, connected'
  && logoAccessibleName('Telegram', 'problem') === 'Telegram, needs attention' && logoAccessibleName('Telegram') === 'Telegram');
check('connection health maps to a badge', connectionHealthBadge('connected') === 'done' && connectionHealthBadge('waiting') === 'waiting'
  && connectionHealthBadge('not_receiving') === 'problem' && connectionHealthBadge('off') === null && connectionHealthBadge('quiet') === null);

const pick = (value: string, otherPicked = false) => providerPickerState(AI_PROVIDER_CHOICES, value, otherPicked);
check('the picker selects a listed provider by its value, ignoring case', pick('Anthropic').selected === 'anthropic' && pick('openai').otherName === '');
check('a typed name the list lacks is Other with that name', pick('mistral').selected === OTHER_PROVIDER && pick('mistral').otherName === 'mistral', pick('mistral'));
check('Other picked with no name yet stays on Other', pick('', true).selected === OTHER_PROVIDER && pick('', true).otherName === '');
check('nothing chosen is nothing selected', pick('').selected === null);

if (failures.length) {
  console.error(`provider logos: ${passed} checks passed, ${failures.length} failed:`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`provider logos: ${passed} checks passed.`);
