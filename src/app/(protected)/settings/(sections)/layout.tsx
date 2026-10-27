import { Header } from '@/components/layout/Header';
import { SettingsFrame } from '@/components/settings/SettingsFrame';

/**
 * Every Settings group page shares this frame: the page header and the menu.
 * A route group, so /settings/trash (its own full page with a back link) and
 * the /settings redirect sit outside it at the same URLs.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="animate-fadeIn min-h-screen">
      <Header title="Settings" />
      <SettingsFrame>{children}</SettingsFrame>
    </div>
  );
}
