/**
 * T-031 — o nó de espera dentro do simulador.
 *
 * `flow.wait` existe pra dar ritmo humano à conversa real. No simulador ele
 * seria só uma tela travada: o usuário está olhando pro navegador esperando a
 * resposta, e a requisição é síncrona. Um minuto de sleep aqui é indistinguível
 * de um bug.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/database', () => ({ prisma: {} }));
vi.mock('../../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { NODE_CATALOG } from './nodes';
import type { FlowNode, NodeContext } from './types';

const espera = NODE_CATALOG['flow.wait'];

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
  it('no simulador devolve na hora e diz que pulou', async () => {
    const inicio = Date.now();
    const r = await espera.execute(no(30), ctx({ __simulador: true }));
    expect(Date.now() - inicio).toBeLessThan(500);
    // O passo aparece na timeline dizendo que pulou — o usuário precisa saber
    // que no atendimento real haveria 30s aqui.
    expect(r.output).toEqual({ segundos: 30, pulado: 'simulador' });
  });

  it('fora do simulador a espera acontece de verdade', async () => {
    const inicio = Date.now();
    const r = await espera.execute(no(1), ctx({}));
    expect(Date.now() - inicio).toBeGreaterThanOrEqual(900);
    expect(r.output).toEqual({ segundos: 1 });
  });

  it('teto de 60s protege contra config absurda', async () => {
    const r = await espera.execute(no(9999), ctx({ __simulador: true }));
    expect((r.output as { segundos: number }).segundos).toBe(60);
  });
});
