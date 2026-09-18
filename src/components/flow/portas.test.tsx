/**
 * As regras de ligação do canvas.
 *
 * Duas queixas de uso originaram estes testes:
 *
 * 1. O bloco de base DESENHAVA uma entrada no topo que a validação sempre
 *    recusou — uma porta que nunca podia ser usada, e o usuário tentou usá-la.
 * 2. "respondeu" era lido como "aqui sai a resposta", quando a resposta já
 *    saiu. O rótulo mudou; o VALOR não pode mudar, porque é o que está gravado
 *    em `edge.branch` de todo fluxo salvo.
 */
import { describe, it, expect } from 'vitest';
import {
  ENTRADA_DE_CONHECIMENTO,
  ENTRADA_DE_FLUXO,
  basesDesenhadas,
  entradaDaAresta,
  ligacaoPermitida,
  rotuloDaPorta,
} from './portas';

describe('rótulo das saídas fixas', () => {
  it('diz o que a porta faz: é DEPOIS de responder, não "aqui sai a resposta"', () => {
    expect(rotuloDaPorta('respondeu')).toBe('Depois de responder');
    expect(rotuloDaPorta('humano')).toBe('Se pedir humano');
    expect(rotuloDaPorta('encerrou')).toBe('Se encerrar');
  });

  it('rota criada por quem monta mantém o nome dele', () => {
    expect(rotuloDaPorta('financeiro')).toBe('financeiro');
  });

  it('underscore continua virando espaço', () => {
    expect(rotuloDaPorta('sem_atendente')).toBe('sem atendente');
  });
});

describe('quem liga em quem, e por qual entrada', () => {
  it('fonte → entrada de conhecimento do agente: permitido', () => {
    expect(
      ligacaoPermitida('source.knowledge', 'ai.atender', ENTRADA_DE_CONHECIMENTO)
    ).toBe(true);
    expect(ligacaoPermitida('source.knowledge', 'ai.agent', ENTRADA_DE_CONHECIMENTO)).toBe(true);
  });

  it('fonte → entrada do fluxo: recusado — a conversa não passa pela base', () => {
    expect(ligacaoPermitida('source.knowledge', 'ai.atender', ENTRADA_DE_FLUXO)).toBe(false);
  });

  it('fonte → bloco que não roda agente: recusado', () => {
    expect(ligacaoPermitida('source.knowledge', 'chat.reply', ENTRADA_DE_CONHECIMENTO)).toBe(false);
  });

  it('passo comum → entrada de conhecimento: recusado', () => {
    expect(ligacaoPermitida('buffer.debounce', 'ai.atender', ENTRADA_DE_CONHECIMENTO)).toBe(false);
  });

  it('passo comum → entrada do fluxo: permitido', () => {
    expect(ligacaoPermitida('buffer.debounce', 'ai.atender', ENTRADA_DE_FLUXO)).toBe(true);
  });

  it('ninguém entra numa fonte nem num gatilho', () => {
    expect(ligacaoPermitida('ai.atender', 'source.knowledge', ENTRADA_DE_FLUXO)).toBe(false);
    expect(ligacaoPermitida('ai.atender', 'trigger.message_received', ENTRADA_DE_FLUXO)).toBe(false);
  });
});

describe('a entrada é derivada do tipo da origem', () => {
  it('aresta de fonte chega no conhecimento', () => {
    expect(entradaDaAresta('source.knowledge')).toBe(ENTRADA_DE_CONHECIMENTO);
  });

  it('aresta de passo comum chega no fluxo', () => {
    expect(entradaDaAresta('buffer.debounce')).toBe(ENTRADA_DE_FLUXO);
  });
});

describe('fluxo salvo ANTES da entrada de conhecimento existir', () => {
  // O grafo salvo nunca guardou handle: a aresta base→agente do fluxo que o
  // usuário já tem vem sem `targetHandle` nenhum. Ela não pode sumir do
  // desenho nem parar de virar `knowledgeBaseId`.
  const nos = [
    { id: 'base-1', type: 'source.knowledge', config: { baseId: 'kb-9' } },
    { id: 'atender-1', type: 'ai.atender', config: { agentId: 'ag-1' } },
  ];

  it('a aresta antiga é remapeada pra entrada de conhecimento ao carregar', () => {
    const arestaSalva = { id: 'e1', source: 'base-1', target: 'atender-1', targetHandle: null };
    const tipoPorId = new Map(nos.map((n) => [n.id, n.type]));
    expect(entradaDaAresta(tipoPorId.get(arestaSalva.source) ?? '')).toBe(ENTRADA_DE_CONHECIMENTO);
  });

  it('continua contando como ligação de base — o vínculo não olha o handle', () => {
    const arestas = [{ source: 'base-1', target: 'atender-1' }];
    expect([...basesDesenhadas(nos, arestas)]).toEqual([['ag-1', 'kb-9']]);
  });

  it('linha sem base escolhida ainda é ligação — só falta escolher', () => {
    const semBase = [
      { id: 'base-1', type: 'source.knowledge', config: {} },
      { id: 'atender-1', type: 'ai.atender', config: { agentId: 'ag-1' } },
    ];
    expect(basesDesenhadas(semBase, [{ source: 'base-1', target: 'atender-1' }]).get('ag-1')).toBe(
      null
    );
  });
});
