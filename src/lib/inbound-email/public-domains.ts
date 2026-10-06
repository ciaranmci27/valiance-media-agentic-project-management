import { isHostname } from './addresses';

/**
 * Public webmail domains. A client domain mapping on one of these would map
 * every stranger on the service to a project, so they can only ever be
 * mapped as exact addresses (contacts). The database keeps the obvious ones
 * as a backstop (email_domain_is_public); this list is the one the app
 * enforces.
 */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'passport.com',
  'yahoo.com', 'ymail.com', 'rocketmail.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'aim.com',
  'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch', 'gmx.us',
  'mail.com', 'email.com', 'usa.com', 'post.com',
  'zoho.com', 'zohomail.com',
  'yandex.com', 'yandex.ru', 'ya.ru', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'rambler.ru',
  'qq.com', '163.com', '126.com', 'yeah.net', 'sina.com', 'sohu.com',
  'fastmail.com', 'fastmail.fm', 'hey.com', 'tutanota.com', 'tutanota.de', 'tuta.io', 'tuta.com',
  'hushmail.com', 'mailbox.org', 'posteo.de', 'runbox.com', 'disroot.org',
  'comcast.net', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'verizon.net', 'cox.net',
  'charter.net', 'earthlink.net', 'optonline.net', 'frontier.com', 'windstream.net', 'juno.com',
  'shaw.ca', 'rogers.com', 'sympatico.ca', 'telus.net', 'videotron.ca',
  'btinternet.com', 'sky.com', 'virginmedia.com', 'talktalk.net', 'blueyonder.co.uk', 'ntlworld.com',
  'web.de', 't-online.de', 'freenet.de', 'arcor.de',
  'orange.fr', 'wanadoo.fr', 'free.fr', 'sfr.fr', 'laposte.net',
  'libero.it', 'virgilio.it', 'tiscali.it', 'alice.it',
  'seznam.cz', 'wp.pl', 'o2.pl', 'onet.pl', 'interia.pl',
  'bigpond.com', 'optusnet.com.au', 'xtra.co.nz',
  'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com',
]);

// Country variants of the big providers: hotmail.co.uk, yahoo.fr, live.ca...
const PUBLIC_FAMILY = /^(gmx|hotmail|outlook|live|yahoo|ymail|aol|msn|windowslive)\.[a-z]{2,3}(\.[a-z]{2})?$/;

export function isPublicEmailDomain(domain: string): boolean {
  const value = domain.trim().toLowerCase();
  return PUBLIC_EMAIL_DOMAINS.has(value) || PUBLIC_FAMILY.test(value);
}

/** Validates a client domain mapping: a hostname, and never a public webmail domain. */
export function validateClientDomain(input: string):
  | { ok: true; domain: string }
  | { ok: false; error: string } {
  const domain = input.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  if (!isHostname(domain)) return { ok: false, error: 'Enter a domain such as acme.com.' };
  if (isPublicEmailDomain(domain)) {
    return { ok: false, error: `${domain} is a public email service. Add the person's exact address under Client email addresses instead.` };
  }
  return { ok: true, domain };
}
