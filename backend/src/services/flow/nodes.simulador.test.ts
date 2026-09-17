/**
 * T-031 / C1 — os nós de espera dentro do simulador.
 *
 * O simulador só tem valor se mentir zero. `flow.wait` dá ritmo humano à
 * conversa, e esse ritmo faz parte do que o cliente sente — por isso agora ele
 * acontece DE VERDADE também no simulador. O que continua pulado é o que
 * ninguém esperaria olhando pra tela: `flow.aguardar` (horas ou dias), que
 * registra no passo quanto tempo teria passado.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/database', () => ({ prisma: {} }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { NODE_CATALOG, duracaoLegivel } from './nodes';
import type { FlowNode, NodeContext } from './types';

const espera = NODE_CATALOG['flow.wait'];
const aguardar = NODE_CATALOG['flow.aguardar'];

const no = (segundos: number): FlowNode => ({
  id: 'w',
  type: 'flow.wait',
  config: { segundos },
});

const ctx = (vars: Record<string, unknown>): NodeContext =>
  ({
    accountId: 'acc-1',
    runId: 'run-1',
    flowId: 'flow-1',
    conversationId: 'conv-1',
    shadow: true,
    vars,
  }) as NodeContext;

describe('flow.wait', () => {
  it('no simulador a espera curta ACONTECE — é o ritmo que o lead vai sentir', async () => {
    const inicio = Date.now();
    const r = await espera.execute(no(1), ctx({ __simulador: true }));
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(900);
    // Nada de "pulado": o passo registra a espera como no atendimento real.
    expect(r.output).toEqual({ segundos: 1 });
  });

  it('fora do simulador a espera acontece de verdade', async () => {
    const inicio = Date.now();
    const r = await espera.execute(no(1), ctx({}));
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(900);
    expect(r.output).toEqual({ segundos: 1 });
  });

  it('teto de 60s protege contra config absurda', async () => {
    // Com o teto de 60s, nunca chega aos 120s que separam "espera" de
    // "pulado" no simulador — a espera acontece, e o valor fica no passo.
    vi.useFakeTimers();
    try {
      const pendente = espera.execute(no(9999), ctx({ __simulador: true }));
      await vi.advanceTimersByTimeAsync(60_000);
      const r = await pendente;
      expect((r.output as { segundos: number }).segundos).toBe(60);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('flow.aguardar no simulador', () => {
  const noAguardar = (valor: number, unidade: string): FlowNode => ({
    id: 'a',
    type: 'flow.aguardar',
    config: { valor, unidade },
  });

  it('é pulado, e o passo diz quanto tempo teria passado — "2 dias"', async () => {
    const inicio = Date.now();
    const r = await aguardar.execute(noAguardar(2, 'dias'), ctx({ __simulador: true }));
    expect(Date.now() - inicio).toBeLessThan(500);
    expect(r.sleep).toBeUndefined();
    expect(r.output).toMatchObject({ pulado: 'simulador', duracao: '2 dias' });
  });

  it('singular quando é um só', async () => {
    const r = await aguardar.execute(noAguardar(1, 'hora'.concat('s')), ctx({ __simulador: true }));
    expect(r.output).toMatchObject({ duracao: '1 hora' });
  });
});

describe('duracaoLegivel', () => {
  it('escreve como uma pessoa escreveria', () => {
    expect(duracaoLegivel(1, 'dias')).toBe('1 dia');
    expect(duracaoLegivel(3, 'dias')).toBe('3 dias');
    expect(duracaoLegivel(1, 'minutos')).toBe('1 minuto');
    expect(duracaoLegivel(45, 'minutos')).toBe('45 minutos');
    expect(duracaoLegivel(200, 'segundos')).toBe('200 segundos');
    // Unidade desconhecida cai em dias, que é o padrão do nó.
    expect(duracaoLegivel(2, 'semanas')).toBe('2 dias');
  });
});
