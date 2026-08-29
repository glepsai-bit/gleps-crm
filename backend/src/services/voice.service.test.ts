/**
 * T-029 — normalização de número do discador.
 *
 * É a função mais perigosa do módulo: ela decide QUAL número é discado. Errar
 * aqui não dá erro — disca o número errado, o operador fala com quem não devia
 * e a conta é cobrada.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/database', () => ({ prisma: {} }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { toE164 } from './voice.service';

describe('toE164 — Brasil', () => {
  it('celular com DDD (11 dígitos) vira +55', () => {
    expect(toE164('11987654321')).toBe('+5511987654321');
  });

  it('fixo com DDD (10 dígitos) vira +55', () => {
    expect(toE164('1133334444')).toBe('+551133334444');
  });

  it('aceita como o operador digita, com máscara', () => {
    expect(toE164('(11) 98765-4321')).toBe('+5511987654321');
    expect(toE164('11 98765 4321')).toBe('+5511987654321');
    expect(toE164('11.98765.4321')).toBe('+5511987654321');
  });

  it('número que já vem com 55 não ganha outro 55', () => {
    expect(toE164('5511987654321')).toBe('+5511987654321');
    expect(toE164('+5511987654321')).toBe('+5511987654321');
  });

  it('fixo já com código do país (12 dígitos)', () => {
    expect(toE164('551133334444')).toBe('+551133334444');
  });
});

describe('toE164 — exterior', () => {
  it('respeita o + e não assume Brasil', () => {
    expect(toE164('+14155552671')).toBe('+14155552671');
    expect(toE164('+351912345678')).toBe('+351912345678');
    expect(toE164('+442071838750')).toBe('+442071838750');
  });

  it('limpa a máscara mantendo o país', () => {
    expect(toE164('+1 (415) 555-2671')).toBe('+14155552671');
  });
});

describe('toE164 — recusa o que não dá pra discar', () => {
  it('vazio', () => {
    expect(() => toE164('')).toThrow(/vazio/i);
    expect(() => toE164('   ')).toThrow(/vazio/i);
  });

  it('curto demais para ser um número brasileiro', () => {
    // 9 dígitos: celular sem DDD. Discar isso daria número errado.
    expect(() => toE164('987654321')).toThrow(/inválido/i);
  });

  it('longo demais', () => {
    expect(() => toE164('1234567890123456')).toThrow(/inválido/i);
  });

  it('só símbolos', () => {
    expect(() => toE164('----')).toThrow(/inválido/i);
  });

  it('internacional curto demais atrás do +', () => {
    expect(() => toE164('+123')).toThrow(/internacional inválido/i);
  });
});
