import { brandCssVars, type Brand } from '@/lib/brand';

export function ThemeProvider({ brand, children }: { brand: Brand; children: React.ReactNode }) {
  const vars = brandCssVars(brand);

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
