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

// As alças do React Flow exigem o contexto do canvas; para o que testamos aqui
// (texto e resumo) elas são irrelevantes.
vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom' },
}));

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
