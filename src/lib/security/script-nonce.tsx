'use client';

import { createContext, useContext } from 'react';

/**
 * This page's script nonce (src/proxy.ts, read by the root layout), for the
 * few places that hand a document scripts of its own: an HTML file preview
 * renders in a srcdoc frame, which takes the page's policy, so its scripts
 * run only with this nonce (withScriptNonce). Undefined on a page without
 * the nonce policy (the client portal) or in demo previews.
 */
const ScriptNonceContext = createContext<string | undefined>(undefined);

export function ScriptNonceProvider({ nonce, children }: { nonce: string | undefined; children: React.ReactNode }) {
  return <ScriptNonceContext.Provider value={nonce}>{children}</ScriptNonceContext.Provider>;
}

export function useScriptNonce(): string | undefined {
  return useContext(ScriptNonceContext);
}
