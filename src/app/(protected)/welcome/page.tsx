'use client';

import { WelcomeWizard } from '@/components/welcome/WelcomeWizard';

/** First-run setup for the workspace Owner. The shell shows it full screen and sends everyone else away. */
export default function WelcomePage() {
  return <WelcomeWizard />;
}
