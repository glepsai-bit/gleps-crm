/**
 * T-039 — a aritmética de horários, sem banco.
 *
 * Tudo em America/Sao_Paulo (UTC-3), que é onde o erro de fuso aparece: 09:00
 * civil é 12:00Z. Um teste que passasse em UTC e falhasse em São Paulo seria
 * exatamente o bug que a profissional descobre na segunda de manhã.
 */

import { describe, it, expect } from 'vitest';
import {
  calcularHorarios,
  horarioValido,
  minutosDoDia,
  periodoDoDia,
  rotuloDoHorario,
  validarHorarios,
  agoraPorExtenso,
} from './horarios';

const TZ = 'America/Sao_Paulo';
// Quarta-feira, 30/09/2026, 10:00 em São Paulo.
const AGORA = new Date('2026-09-30T13:00:00Z');
const sp = (iso: string) => new Date(iso + '-03:00');

const base = {
  agora: AGORA,
  timezone: TZ,
  horarios: { '4': [{ inicio: '09:00', fim: '12:00' }] }, // quinta
  duracaoMinutos: 30,
  intervaloMinutos: 0,
  passoMinutos: 30,
  antecedenciaMinimaMinutos: 120,
  janelaMaximaDias: 30,
  de: AGORA,
  ate: new Date('2026-10-03T03:00:00Z'),
  ocupados: [],
};

describe('calcularHorarios', () => {
  it('fatia o expediente no fuso da conta e cabe a duração na faixa', () => {
    const r = calcularHorarios(base);
    // Quinta 01/10: 09:00, 09:30, 10:00, 10:30, 11:00, 11:30 (12:00 não cabe 30 min).
    expect(r.map((h) => h.inicio.toISOString())).toEqual([
      sp('2026-10-01T09:00:00').toISOString(),
      sp('2026-10-01T09:30:00').toISOString(),
      sp('2026-10-01T10:00:00').toISOString(),
      sp('2026-10-01T10:30:00').toISOString(),
      sp('2026-10-01T11:00:00').toISOString(),
      sp('2026-10-01T11:30:00').toISOString(),
    ]);
    expect(r[0].fim.toISOString()).toBe(sp('2026-10-01T09:30:00').toISOString());
  });

  it('remove o que bate em ocupação e respeita a folga dos dois lados', () => {
    const r = calcularHorarios({
      ...base,
      intervaloMinutos: 15,
      ocupados: [{ inicio: sp('2026-10-01T10:00:00'), fim: sp('2026-10-01T10:30:00') }],
    });
    // Ocupado 10:00–10:30 com folga 15 → bloqueia 09:45–10:45. Caem 09:30 (9:30–10:00
    // encosta em 09:45), 10:00 e 10:30 (10:30–11:00 encosta em 10:45).
    expect(r.map((h) => h.inicio.toISOString())).toEqual([
      sp('2026-10-01T09:00:00').toISOString(),
      sp('2026-10-01T11:00:00').toISOString(),
      sp('2026-10-01T11:30:00').toISOString(),
    ]);
  });

  it('não oferece antes da antecedência mínima nem depois da janela máxima', () => {
    // Expediente HOJE (quarta) 09:00–18:00, agora 10:00, antecedência 2h → só a partir de 12:00.
    const r = calcularHorarios({
      ...base,
      horarios: { '3': [{ inicio: '09:00', fim: '18:00' }] },
      ate: new Date('2026-10-01T03:00:00Z'),
    });
    expect(r[0].inicio.toISOString()).toBe(sp('2026-09-30T12:00:00').toISOString());

    const curta = calcularHorarios({ ...base, janelaMaximaDias: 1 });
    // Janela de 1 dia acaba quinta 10:00 → só o que TERMINA até lá.
    expect(curta.map((h) => h.inicio.toISOString())).toEqual([
      sp('2026-10-01T09:00:00').toISOString(),
      sp('2026-10-01T09:30:00').toISOString(),
    ]);
  });

  it('um serviço mais longo que a faixa não gera horário', () => {
    expect(calcularHorarios({ ...base, duracaoMinutos: 200 })).toHaveLength(0);
  });

  it('evento de dia inteiro (00:00–24:00) apaga o dia', () => {
    const r = calcularHorarios({
      ...base,
      ocupados: [{ inicio: sp('2026-10-01T00:00:00'), fim: sp('2026-10-02T00:00:00') }],
    });
    expect(r).toHaveLength(0);
  });
});

describe('horarioValido', () => {
  it('aceita um horário da grade e recusa um fora dela', () => {
    expect(horarioValido(base, sp('2026-10-01T09:30:00'))).toBe(true);
    // 09:40 não está no passo de 30 min.
    expect(horarioValido(base, sp('2026-10-01T09:40:00'))).toBe(false);
    // Sexta não tem expediente.
    expect(horarioValido(base, sp('2026-10-02T09:00:00'))).toBe(false);
  });

  it('recusa horário ocupado', () => {
    const p = { ...base, ocupados: [{ inicio: sp('2026-10-01T09:00:00'), fim: sp('2026-10-01T10:00:00') }] };
    expect(horarioValido(p, sp('2026-10-01T09:30:00'))).toBe(false);
    expect(horarioValido(p, sp('2026-10-01T10:00:00'))).toBe(true);
  });
});

describe('rótulos e períodos', () => {
  it('fala o horário como o lead lê, no fuso da conta', () => {
    expect(rotuloDoHorario(sp('2026-10-01T14:00:00'), TZ)).toBe('quinta-feira, 01/10 às 14:00');
    expect(periodoDoDia(sp('2026-10-01T11:59:00'), TZ)).toBe('manha');
    expect(periodoDoDia(sp('2026-10-01T14:00:00'), TZ)).toBe('tarde');
    expect(periodoDoDia(sp('2026-10-01T18:00:00'), TZ)).toBe('noite');
    expect(agoraPorExtenso(AGORA, TZ)).toBe('quarta-feira, 30/09/2026, 10:00 (America/Sao_Paulo)');
  });

  it('minutosDoDia lê HH:MM e recusa lixo', () => {
    expect(minutosDoDia('09:30')).toBe(570);
    expect(minutosDoDia('9:05')).toBe(545);
    expect(minutosDoDia('25:00')).toBeNull();
    expect(minutosDoDia('abc')).toBeNull();
  });
});

describe('validarHorarios', () => {
  it('limpa, ordena e recusa faixa invertida ou sobreposta', () => {
    const ok = validarHorarios({ '1': [{ inicio: '13:00', fim: '18:00' }, { inicio: '09:00', fim: '12:00' }] });
    expect(ok.erros).toEqual([]);
    expect(ok.horarios['1'].map((f) => f.inicio)).toEqual(['09:00', '13:00']);

    expect(validarHorarios({ '1': [{ inicio: '12:00', fim: '09:00' }] }).erros[0]).toMatch(/depois do início/);
    expect(validarHorarios({ '1': [{ inicio: '09:00', fim: '12:00' }, { inicio: '11:00', fim: '13:00' }] }).erros[0]).toMatch(/sobrepõem/);
    expect(validarHorarios({ '9': [] }).erros[0]).toMatch(/inválido/);
    expect(validarHorarios([]).erros[0]).toMatch(/objeto/);
  });

  it('dia sem faixa some do resultado', () => {
    expect(validarHorarios({ '1': [], '2': [{ inicio: '09:00', fim: '10:00' }] }).horarios).toEqual({
      '2': [{ inicio: '09:00', fim: '10:00' }],
    });
  });
});
