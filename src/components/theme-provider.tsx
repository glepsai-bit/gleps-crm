import type { ComponentProps } from 'react';
import { ThemeProvider as NextThemesProvider } from 'next-themes';

/**
 * Provedor de tema (light/dark/system) baseado em next-themes.
 * Aplica a classe `dark` na <html> e persiste a escolha no localStorage.
 * Envolve a árvore em src/App.tsx.
 *
 * Tipamos via ComponentProps<typeof NextThemesProvider> porque o next-themes 0.3.0
 * não re-exporta `ThemeProviderProps` pela raiz do pacote (quebra o tsc).
 */
export function ThemeProvider({ children, ...props }: ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
