/**
 * ETAPA D — normalizarTelefoneBR: uma regra só para todas as entradas de
 * telefone. Cada caso aqui é um formato que já apareceu em lista colada,
 * público do Google Maps ou cadastro de contato.
 */
import { describe, it, expect } from 'vitest';
import { normalizarTelefoneBR, primeiroNome } from './telefone';

describe('normalizarTelefoneBR', () => {
  const casos: Array<[string, string | null, string]> = [
    ['+55 (11) 98765-4321', '5511987654321', 'formatado com +55, parênteses e hífen'],
    ['11987654321', '5511987654321', '11 dígitos (DDD + celular com 9) ganha 55'],
    ['5511987654321', '5511987654321', '13 dígitos com 55 mantém'],
    ['011987654321', '5511987654321', 'zero de operadora na frente cai'],
    ['0055 11 98765-4321', '5511987654321', '00 + DDI (discagem internacional) cai o zero'],
    ['55 55 11 98765-4321', '5511987654321', 'DDI duplicado perde um 55'],
    ['+55 11 3333-4444', '551133334444', '12 dígitos com 55 (fixo com DDI) mantém'],
    ['1133334444', null, '10 dígitos sem DDI (fixo) é ambíguo → null'],
    ['1187654321', null, '10 dígitos sem o 9 → null (não inventa o 9)'],
    ['11 8765-4321', null, 'celular antigo sem o 9 → null'],
    ['5511887654321', null, '13 dígitos com 55 mas sem o 9 → null'],
    ['5501987654321', null, 'DDD com zero não existe → null'],
    ['987654321', null, 'sem DDD → null'],
    ['abc', null, 'sem dígito nenhum → null'],
    ['', null, 'vazio → null'],
    ['551198765432112345', null, 'comprido demais → null'],
    ['+1 415 555 2671', null, 'número estrangeiro → null (esta regra é BR)'],
  ];

  for (const [entrada, esperado, motivo] of casos) {
    it(`${motivo}: "${entrada}" → ${esperado === null ? 'null' : esperado}`, () => {
      expect(normalizarTelefoneBR(entrada)).toBe(esperado);
    });
  }

  it('entrada que não é string → null', () => {
    expect(normalizarTelefoneBR(null)).toBeNull();
    expect(normalizarTelefoneBR(undefined)).toBeNull();
    expect(normalizarTelefoneBR(5511987654321 as unknown as string)).toBeNull();
  });
});

describe('primeiroNome', () => {
  it('pega só a primeira palavra', () => {
    expect(primeiroNome('Maria da Silva')).toBe('Maria');
    expect(primeiroNome('  João  ')).toBe('João');
  });
  it('vazio continua vazio', () => {
    expect(primeiroNome('')).toBe('');
    expect(primeiroNome(null)).toBe('');
    expect(primeiroNome(undefined)).toBe('');
  });
});
