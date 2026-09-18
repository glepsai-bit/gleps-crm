/**
 * T-028 — cartão de passo do canvas.
 *
 * O defeito que originou este componente: no modo escuro os blocos ficavam
 * ilegíveis e não dava pra saber o que cada um fazia. Estes testes garantem
 * que o nome E o resumo da configuração aparecem — que é o que resolve o
 * problema de verdade, não só a cor.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FlowNodeCard, type FlowNodeData } from './FlowNodeCard';

// As alças do React Flow exigem o contexto do canvas. O dublê desenha um <i>
// com o tipo, o id e a posição da alça — é o suficiente pra afirmar QUAIS
// portas o bloco oferece, que é metade do que estes testes garantem.
vi.mock('@xyflow/react', () => ({
  Handle: ({ type, id, position }: { type: string; id?: string; position: string }) => (
    <i data-alca={type} data-alca-id={id ?? ''} data-alca-pos={position} />
  ),
  Position: { Top: 'top', Bottom: 'bottom', Right: 'right', Left: 'left' },
  // O card agora descobre quem é sozinho, pra gravar configuração sem receber
  // callback dentro de `data` — que é serializado pro backend.
  useNodeId: () => 'n1',
}));

/** As alças de entrada desenhadas, na ordem em que aparecem. */
function entradas(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[data-alca="target"]')].map(
    (e) => e.getAttribute('data-alca-id') ?? ''
  );
}

function renderNode(data: FlowNodeData, selected = false) {
  return render(
    <FlowNodeCard
      id="n1"
      data={data}
      selected={selected}
      type="passo"
      dragging={false}
      zIndex={0}
      isConnectable
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      draggable
      selectable
      deletable
    />
  );
}

describe('nome do passo aparece', () => {
  it('mostra o rótulo que o usuário deu', () => {
    renderNode({ label: 'Agente de atendimento', tipo: 'ai.agent', config: {} });
    expect(screen.getByText('Agente de atendimento')).toBeInTheDocument();
  });

  it('sem rótulo, cai no tipo — nunca fica vazio', () => {
    renderNode({ tipo: 'chat.reply', config: {} });
    expect(screen.getByText('chat.reply')).toBeInTheDocument();
  });
});

describe('resumo da configuração — evita ter que clicar em cada bloco', () => {
  it('agente: mostra qual agente está selecionado', () => {
    renderNode({
      label: 'Agente',
      tipo: 'ai.agent',
      config: { agentId: 'abc' },
      agenteNome: 'Marcus SDR',
    });
    expect(screen.getByText('Marcus SDR')).toBeInTheDocument();
  });

  it('agente sem seleção avisa — é o erro de montagem mais comum', () => {
    renderNode({ label: 'Agente', tipo: 'ai.agent', config: {} });
    expect(screen.getByText(/sem agente selecionado/i)).toBeInTheDocument();
  });

  it('agrupamento: mostra a janela em segundos', () => {
    renderNode({ label: 'Agrupar', tipo: 'buffer.debounce', config: { segundos: 15 } });
    expect(screen.getByText(/espera 15s/i)).toBeInTheDocument();
  });

  it('etapa: mostra o template configurado', () => {
    renderNode({
      label: 'Aplicar etapa',
      tipo: 'crm.apply_stage',
      config: { etapa: '{{agente.etapa}}' },
    });
    expect(screen.getByText('{{agente.etapa}}')).toBeInTheDocument();
  });

  it('condição: mostra a variável testada', () => {
    renderNode({
      label: 'Pediu humano?',
      tipo: 'logic.switch',
      config: { variavel: 'agente.transferir_para_humano' },
    });
    expect(screen.getByText('agente.transferir_para_humano')).toBeInTheDocument();
  });

  it('guardas: lista o que interrompe o fluxo', () => {
    renderNode({
      label: 'Só continuar se',
      tipo: 'guard.conditions',
      config: { humanoAssumiu: true, conversaResolvida: true },
    });
    expect(screen.getByText(/humano assumiu/i)).toBeInTheDocument();
  });

  it('HTTP: mostra método e URL', () => {
    renderNode({
      label: 'Chamar API',
      tipo: 'http.request',
      config: { metodo: 'POST', url: 'https://exemplo.com/hook' },
    });
    expect(screen.getByText(/POST https:\/\/exemplo\.com\/hook/)).toBeInTheDocument();
  });
});

describe('saídas nomeadas — o que o motor ramifica precisa existir na tela', () => {
  it('cada rota do agente vira uma linha com nome', () => {
    renderNode({
      label: 'Atender com IA',
      tipo: 'ai.atender',
      config: {},
      portas: ['respondeu', 'humano', 'encerrou'],
    });
    // O VALOR continua `respondeu` (é o que o motor compara e o que vai em
    // `edge.branch`); só o texto na tela mudou.
    expect(screen.getByText('Depois de responder')).toBeInTheDocument();
    expect(screen.getByText('Se pedir humano')).toBeInTheDocument();
    expect(screen.getByText('Se encerrar')).toBeInTheDocument();
    expect(screen.queryByText('respondeu')).not.toBeInTheDocument();
  });

  it('o rótulo muda, mas a porta continua se chamando `respondeu`', () => {
    // A aresta grava o id do handle em `edge.branch`: se o id virasse o rótulo,
    // todo fluxo salvo perderia o ramo.
    const { container } = renderNode({
      label: 'Atender com IA',
      tipo: 'ai.atender',
      config: {},
      portas: ['respondeu', 'humano', 'encerrou'],
    });
    const saidas = [...container.querySelectorAll('[data-alca="source"]')].map((e) =>
      e.getAttribute('data-alca-id')
    );
    expect(saidas).toEqual(['respondeu', 'humano', 'encerrou']);
  });

  it('rota criada por quem monta mantém o nome que ele deu', () => {
    renderNode({
      label: 'Atender com IA',
      tipo: 'ai.atender',
      config: {},
      portas: ['respondeu', 'financeiro'],
    });
    expect(screen.getByText('financeiro')).toBeInTheDocument();
  });

  it('a saída padrão NÃO vira linha — ela é a bolinha de baixo', () => {
    // Senão um fluxo linear desenharia uma volta pela direita a cada passo.
    renderNode({
      label: 'Chamar API',
      tipo: 'http.request',
      config: {},
      portas: ['default', 'erro'],
    });
    expect(screen.getByText('erro')).toBeInTheDocument();
    expect(screen.queryByText('default')).not.toBeInTheDocument();
  });

  it('nome de rota com underscore fica legível', () => {
    renderNode({
      label: 'Transferir',
      tipo: 'chat.assign_human',
      config: {},
      portas: ['default', 'sem_atendente'],
    });
    expect(screen.getByText('sem atendente')).toBeInTheDocument();
  });
});

describe('resumo do bloco de atendimento', () => {
  it('"Atender com IA" mostra o agente — caía no default e não mostrava nada', () => {
    renderNode({
      label: 'Atender com IA',
      tipo: 'ai.atender',
      config: { agentId: 'abc' },
      agenteNome: 'Marcus SDR',
    });
    expect(screen.getByText('Marcus SDR')).toBeInTheDocument();
  });
});

describe('a base do agente aparece no bloco', () => {
  // O bug: a ferramenta de busca ligada num agente SEM base não acha nada, e
  // nada na tela dizia isso — o painel mostrava o estado salvo e a linha
  // desenhada não mudava nada até salvar.
  it('mostra a base ligada, como mostra o agente', () => {
    renderNode({
      label: 'Atender com IA',
      tipo: 'ai.atender',
      config: { agentId: 'abc' },
      agenteNome: 'Marcus SDR',
      base: { nome: 'Catálogo 2026' },
    });
    expect(screen.getByText('base: Catálogo 2026')).toBeInTheDocument();
  });

  it('sem base, diz "sem base" — em vez de não dizer nada', () => {
    renderNode({
      label: 'Atender com IA',
      tipo: 'ai.atender',
      config: { agentId: 'abc' },
      agenteNome: 'Marcus SDR',
      base: { nome: null },
    });
    expect(screen.getByText('sem base')).toBeInTheDocument();
  });

  it('linha desenhada e não salva avisa que precisa salvar', () => {
    renderNode({
      label: 'Atender com IA',
      tipo: 'ai.atender',
      config: { agentId: 'abc' },
      agenteNome: 'Marcus SDR',
      base: { nome: 'Catálogo 2026', aviso: '(salvar pra aplicar)' },
    });
    expect(screen.getByText(/base: Catálogo 2026/)).toBeInTheDocument();
    expect(screen.getByText('(salvar pra aplicar)')).toBeInTheDocument();
  });

  it('bloco que não roda agente não fala de base', () => {
    renderNode({ label: 'Responder', tipo: 'chat.reply', config: { texto: 'oi' } });
    expect(screen.queryByText(/base/)).not.toBeInTheDocument();
  });
});

describe('o simulador fiel — o que o bloco diz sobre a espera', () => {
  it('na janela de agrupamento o bloco diz "aguardando", sem tempo de execução', () => {
    renderNode({
      label: 'Agrupar',
      tipo: 'buffer.debounce',
      config: { segundos: 15 },
      execRodou: true,
      exec: { status: 'waiting', ms: 0, error: null },
    });
    expect(screen.getByText('aguardando')).toBeInTheDocument();
    expect(screen.queryByText(/passou/)).not.toBeInTheDocument();
    expect(screen.queryByText(/0ms/)).not.toBeInTheDocument();
  });

  it('espera longa pulada diz isso, com a duração — não um "passou" verde mudo', () => {
    renderNode({
      label: 'Esperar',
      tipo: 'flow.aguardar',
      config: { valor: 2, unidade: 'dias' },
      execRodou: true,
      exec: { status: 'ok', ms: 3, error: null, puladoNoSimulador: '2 dias' },
    });
    expect(screen.getByText('pulado no simulador (2 dias)')).toBeInTheDocument();
    expect(screen.queryByText('passou')).not.toBeInTheDocument();
  });

  it('passo comum continua "passou"', () => {
    renderNode({
      label: 'Responder',
      tipo: 'chat.reply',
      config: {},
      execRodou: true,
      exec: { status: 'ok', ms: 12, error: null, puladoNoSimulador: null },
    });
    expect(screen.getByText('passou')).toBeInTheDocument();
    expect(screen.getByText('12ms')).toBeInTheDocument();
  });

  it('espera longa mostra quanto tempo está configurado', () => {
    renderNode({ label: 'Esperar', tipo: 'flow.aguardar', config: { valor: 3, unidade: 'horas' } });
    expect(screen.getByText('3 horas')).toBeInTheDocument();
  });
});

describe('transferir para humano', () => {
  it('com time escolhido, o resumo deixa de dizer "sorteia"', () => {
    renderNode({
      label: 'Transferir',
      tipo: 'chat.assign_human',
      config: { teamId: 'time-1' },
    });
    expect(screen.getByText(/transfere para o time escolhido/)).toBeInTheDocument();
    expect(screen.queryByText(/sorteia/)).not.toBeInTheDocument();
  });
});

describe('tema', () => {
  it('usa os tokens do design system, não cor fixa', () => {
    const { container } = renderNode({ label: 'Responder', tipo: 'chat.reply', config: {} });
    const cartao = container.firstElementChild as HTMLElement;
    // bg-card/text-card-foreground viram a cor certa em claro E escuro; era a
    // cor fixa do nó padrão do React Flow que sumia no escuro.
    expect(cartao.className).toContain('bg-card');
    expect(cartao.className).toContain('text-card-foreground');
  });

  it('selecionado ganha destaque visível', () => {
    const { container } = renderNode({ label: 'X', tipo: 'chat.reply', config: {} }, true);
    expect((container.firstElementChild as HTMLElement).className).toContain('border-primary');
  });
});

describe('tipo desconhecido não quebra a tela', () => {
  it('renderiza com ícone genérico', () => {
    renderNode({ label: 'Passo novo', tipo: 'tipo.que.nao.existe', config: {} });
    expect(screen.getByText('Passo novo')).toBeInTheDocument();
  });
});

describe('as entradas do bloco — a queixa era ligar a base', () => {
  it('fonte NÃO desenha entrada: ela alimenta um bloco, não recebe o fluxo', () => {
    // Era o bug: a base desenhava uma bolinha de entrada no topo que a
    // validação SEMPRE recusou. O usuário mirou nela e nada acontecia.
    const { container } = renderNode({
      label: 'Base de conhecimento',
      tipo: 'source.knowledge',
      config: {},
    });
    expect(entradas(container)).toEqual([]);
  });

  it('gatilho continua sem entrada — é onde o fluxo começa', () => {
    const { container } = renderNode({
      label: 'Nova mensagem',
      tipo: 'trigger.message_received',
      config: {},
    });
    expect(entradas(container)).toEqual([]);
  });

  it('quem roda agente tem DUAS entradas, com ids distintos', () => {
    const { container } = renderNode({
      label: 'Atender com IA',
      tipo: 'ai.atender',
      config: {},
    });
    expect(entradas(container)).toEqual(['entrada', 'conhecimento']);
  });

  it('a entrada de conhecimento fica de lado, não no topo com a do fluxo', () => {
    const { container } = renderNode({ label: 'Agente', tipo: 'ai.agent', config: {} });
    const conhecimento = container.querySelector('[data-alca-id="conhecimento"]');
    expect(conhecimento?.getAttribute('data-alca-pos')).toBe('left');
    expect(container.querySelector('[data-alca-id="entrada"]')?.getAttribute('data-alca-pos')).toBe(
      'top'
    );
  });

  it('passo comum tem só a entrada do fluxo — base não se liga nele', () => {
    const { container } = renderNode({ label: 'Responder', tipo: 'chat.reply', config: {} });
    expect(entradas(container)).toEqual(['entrada']);
  });
});
