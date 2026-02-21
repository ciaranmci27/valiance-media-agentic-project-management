import { siteConfig } from '@/site-config';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const { brand, accent } = siteConfig.colors;
  const vars = Object.entries(brand)
    .map(([shade, hex]) => `--color-brand-${shade}:${hex}`)
    .concat(`--color-accent:${accent}`)
    .join(';');

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: `:root{${vars}}` }} />
      {children}
    </>
  );
}
