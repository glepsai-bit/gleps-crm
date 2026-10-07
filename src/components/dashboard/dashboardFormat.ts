/**
 * Helpers de formatação e variação do Dashboard de atendimento.
 * Sem dependência de React — testável isoladamente.
 */

export function formatMin(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  if (value < 1) return '<1 min';
  if (value < 60) return `${Math.round(value)} min`;
  const horas = Math.floor(value / 60);
  const mins = Math.round(value % 60);
  return mins > 0 ? `${horas}h ${String(mins).padStart(2, '0')}` : `${horas}h`;
}

export function pct(parte: number, total: number): number {
  if (!total) return 0;
  return (parte / total) * 100;
}

export function formatNumero(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return new Intl.NumberFormat('pt-BR').format(v);
}

export function formatMoeda(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }).format(v);
}

export function formatPct(v: number | null | undefined, casas = 0): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v.toFixed(casas).replace('.', ',')}%`;
}

/** "atualizado há 12 s" / "há 3 min". */
export function formatHa(segundos: number): string {
  const s = Math.max(0, Math.round(segundos));
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min`;
}

export type TomVariacao = 'melhora' | 'piora' | 'neutro';

export interface Variacao {
  /** Trecho em destaque (ex.: "+12%", "−38 s"). */
  destaque: string;
  /** Resto da frase (ex.: "vs. 30 dias antes", "mais rápido"). */
  resto: string;
  tom: TomVariacao;
}

export function rotuloPeriodoAnterior(dias: number): string {
  return dias <= 1 ? 'dia anterior' : `${dias} dias antes`;
}

/** Contagem: maior é melhor. Retorna null quando não dá para comparar. */
export function variacaoContagem(
  atual: number | null | undefined,
  anterior: number | null | undefined,
  dias: number,
  maiorEMelhor = true,
): Variacao | null {
  if (atual == null || anterior == null || !anterior) return null;
  const delta = Math.round(((atual - anterior) / anterior) * 100);
  const resto = `vs. ${rotuloPeriodoAnterior(dias)}`;
  if (delta === 0) return { destaque: '0%', resto, tom: 'neutro' };
  const sinal = delta > 0 ? '+' : '−';
  const subiu = delta > 0;
  return {
    destaque: `${sinal}${Math.abs(delta)}%`,
    resto,
    tom: subiu === maiorEMelhor ? 'melhora' : 'piora',
  };
}

/** Tempo em minutos: menor é melhor. */
export function variacaoTempo(
  atualMin: number | null | undefined,
  anteriorMin: number | null | undefined,
): Variacao | null {
  if (atualMin == null || anteriorMin == null) return null;
  const diffSeg = Math.round((atualMin - anteriorMin) * 60);
  if (Math.abs(diffSeg) < 5) return { destaque: 'Igual', resto: 'ao período anterior', tom: 'neutro' };
  const abs = Math.abs(diffSeg);
  const texto = abs < 60 ? `${abs} s` : formatMin(abs / 60);
  const melhorou = diffSeg < 0;
  return {
    destaque: `${melhorou ? '−' : '+'}${texto}`,
    resto: melhorou ? 'mais rápido' : 'mais lento',
    tom: melhorou ? 'melhora' : 'piora',
  };
}

export function iniciais(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return '?';
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}
