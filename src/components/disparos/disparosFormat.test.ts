import { describe, it, expect } from 'vitest';
import { dataNoFuso, diasNecessarios, estimarTermino, renderizarTexto } from './disparosFormat';

describe('disparosFormat', () => {
  it('dataNoFuso lê o horário no fuso da conta, não no do navegador', () => {
    expect(dataNoFuso('2026-10-08T09:00', 'America/Sao_Paulo')).toBe('2026-10-08T12:00:00.000Z');
    expect(dataNoFuso('2026-10-08T09:00', 'America/Manaus')).toBe('2026-10-08T13:00:00.000Z');
    expect(dataNoFuso('lixo')).toBeNull();
  });

  it('estimarTermino anda só dentro de 08h–20h e divide pelos números', () => {
    // 90 mensagens × 40 s = 1 h por 1 número; 30 min por 2 números.
    const inicio = new Date('2026-10-08T12:00:00.000Z'); // 09:00 em São Paulo
    expect(estimarTermino(inicio, 90, 1).toISOString()).toBe('2026-10-08T13:00:00.000Z');
    expect(estimarTermino(inicio, 90, 2).toISOString()).toBe('2026-10-08T12:30:00.000Z');
    // começa 19:30 (22:30Z): sobra 30 min hoje e o resto às 08h do dia seguinte
    const tarde = new Date('2026-10-08T22:30:00.000Z');
    expect(estimarTermino(tarde, 90, 1).toISOString()).toBe('2026-10-09T11:30:00.000Z');
  });

  it('diasNecessarios usa o que resta hoje e depois o limite diário', () => {
    expect(diasNecessarios(100, 180, 200)).toBe(1);
    expect(diasNecessarios(108, 15, 15)).toBe(1 + Math.ceil(93 / 15));
  });

  it('renderizarTexto aplica as variáveis e o {nome} legado', () => {
    expect(renderizarTexto('Oi {{primeiro_nome}} ({{nome}}) {nome}', 'Maria Souza')).toBe('Oi Maria (Maria Souza) Maria Souza');
  });
});
