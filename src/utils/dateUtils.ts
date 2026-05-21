import { format, type Locale } from 'date-fns';
import { ptBR } from 'date-fns/locale';

/**
 * Formata uma data de forma segura, retornando fallback em caso de valor inválido.
 * Substitui format(new Date(x), ...) que crashava com null/undefined/invalid.
 */
export function safeFormatDate(
  date: string | number | Date | null | undefined,
  fmt: string,
  options?: { locale?: Locale },
  fallback: string = '-'
): string {
  if (date === null || date === undefined || date === '') return fallback;
  try {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return fallback;
    return format(d, fmt, options);
  } catch {
    return fallback;
  }
}

/** Atalho com locale ptBR já aplicado */
export function safeFormatDateBR(
  date: string | number | Date | null | undefined,
  fmt: string,
  fallback: string = '-'
): string {
  return safeFormatDate(date, fmt, { locale: ptBR }, fallback);
}
