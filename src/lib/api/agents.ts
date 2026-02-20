import { forbidden } from './errors';

export function requireAgentsEnabled() {
  if (process.env.NEXT_PUBLIC_ENABLE_AGENTS !== 'true') {
    throw forbidden('Agentic workflows are not enabled');
  }
}
