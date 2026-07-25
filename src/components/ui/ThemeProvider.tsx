import { siteConfig } from '@/site-config';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { brand, accent } = siteConfig.colors;
  const vars = Object.entries(brand)
    .map(([shade, hex]) => `--color-brand-${shade}:${hex}`)
    .concat(`--color-accent:${accent}`)
    .join(';');

  // Inject the brand scale at :root AND under [data-theme="dark"]. The second copy
  // lets a nested dark subtree (the always-dark sidebar) re-assert the true brand
  // shades in light mode, where globals.css darkens brand TEXT shades for contrast.
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `:root{${vars}}[data-theme="dark"]{${vars}}` }} />
      {children}
    </>
  );
}
