/** Formatadores compartilhados do módulo de Tracking de Anúncios. */

export const brl = (v: number | null | undefined): string =>
  v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const brlCompact = (v: number): string =>
  v.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    notation: 'compact',
    maximumFractionDigits: 1,
  });

export const int = (v: number | null | undefined): string =>
  v == null ? '—' : v.toLocaleString('pt-BR');

export const pct = (v: number | null | undefined): string =>
  v == null ? '—' : `${(v * 100).toFixed(1)}%`;

export const ratio = (v: number | null | undefined): string =>
  v == null ? '—' : `${v.toFixed(2)}x`;

/** '2026-08-10' -> '10/08' (rótulo curto de eixo). */
export const shortDay = (iso: string): string => {
  const [, m, d] = iso.split('-');
  return m && d ? `${d}/${m}` : iso;
};
