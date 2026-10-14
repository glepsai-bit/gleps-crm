/**
 * ETAPA G — o calendário em memória da sombra: uma reserva por conversa,
 * que sobrevive ao turno e não vaza pra outra conversa.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { calendarioSombra } from './sombra';

const horario = (rotulo: string) => ({
  horarioId: `h-${rotulo}`,
  profissionalId: 'u-1',
  produtoId: 'p-1',
  inicio: new Date('2026-10-20T18:00:00Z'),
  fim: new Date('2026-10-20T18:30:00Z'),
  rotulo,
  profissional: 'Dr. Carlos',
  servico: 'Consulta',
});

beforeEach(() => calendarioSombra.__limparTudo());

describe('calendarioSombra', () => {
  it('a reserva fica guardada na chave e a nova substitui a anterior', () => {
    calendarioSombra.reservar('c1', { ...horario('A'), expiraEm: new Date(Date.now() + 60_000) });
    expect(calendarioSombra.pendente('c1')?.rotulo).toBe('A');
    calendarioSombra.reservar('c1', { ...horario('B'), expiraEm: new Date(Date.now() + 60_000) });
    expect(calendarioSombra.pendente('c1')?.rotulo).toBe('B');
    // Outra conversa não enxerga nada.
    expect(calendarioSombra.pendente('c2')).toBeNull();
  });

  it('confirmar limpa a pendente e deixa a marcada; cancelar tira a marcada; limpar apaga tudo', () => {
    calendarioSombra.reservar('c1', { ...horario('A'), expiraEm: new Date(Date.now() + 60_000) });
    calendarioSombra.confirmar('c1', horario('A'));
    expect(calendarioSombra.pendente('c1')).toBeNull();
    expect(calendarioSombra.marcada('c1')?.rotulo).toBe('A');
    calendarioSombra.cancelar('c1');
    expect(calendarioSombra.marcada('c1')).toBeNull();
    calendarioSombra.reservar('c1', { ...horario('C'), expiraEm: new Date(Date.now() + 60_000) });
    calendarioSombra.limpar('c1');
    expect(calendarioSombra.pendente('c1')).toBeNull();
  });
});
