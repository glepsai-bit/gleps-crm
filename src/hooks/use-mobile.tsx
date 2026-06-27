import * as React from "react";

const MOBILE_BREAKPOINT = 768;
const MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

/**
 * Calcula sincronamente se o viewport eh mobile.
 * Evita race condition em que o primeiro render assume "desktop"
 * (ou mobile) errado por usar estado inicial hardcoded.
 *
 * Cobre tambem SSR / ambientes sem `window`.
 */
function getInitialIsMobile(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.matchMedia(MEDIA_QUERY).matches;
  } catch {
    // matchMedia indisponivel (e.g. JSDOM antigo) — fallback para innerWidth
    return window.innerWidth < MOBILE_BREAKPOINT;
  }
}

export function useIsMobile() {
  // Estado inicial calculado sincronamente a partir de matchMedia,
  // garantindo que o primeiro paint ja saia com o valor correto e
  // eliminando flicker / "renderiza em mobile XS por engano".
  const [isMobile, setIsMobile] = React.useState<boolean>(getInitialIsMobile);

  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const mql = window.matchMedia(MEDIA_QUERY);
    const onChange = () => {
      setIsMobile(mql.matches);
    };
    // Sync inicial pos-mount caso o viewport tenha mudado entre o
    // calculo do useState e o efeito (ex.: resize antes da hidratacao).
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
