/**
 * AdminIaAgentesPage — a escolha de modelo e o raciocínio do agente.
 *
 * A lista de modelos escrita à mão saiu desta tela e foi para o catálogo único
 * (`@/config/modelosIa`), o mesmo do painel do canvas. A regra pura tem teste
 * próprio; aqui se trava o que chega à API quando o admin cria ou edita um
 * agente pelo diálogo.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminIaAgentesPage from './AdminIaAgentesPage';
import { aiService, type AiAgent, type AiAgentInput, type AiStatus } from '@/services/ai.backend.service';

vi.mock('@/services/ai.backend.service', () => ({
  aiService: {
    getStatus: vi.fn(),
    listAgents: vi.fn(),
    listBases: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    runAgent: vi.fn(),
  },
}));

const { avisar } = vi.hoisted(() => ({ avisar: vi.fn() }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: avisar }) }));

const servico = vi.mocked(aiService);

const STATUS: AiStatus = {
  providers: { openai: true, anthropic: true },
  knowledgeBaseReady: true,
  transcriptionReady: true,
  tools: [],
};

function agente(over: Partial<AiAgent> = {}): AiAgent {
  return {
    id: 'a1',
    name: 'Marcus SDR',
    description: null,
    role: 'responder',
    systemPrompt: 'Você se chama Marcus.',
    provider: 'openai',
    model: 'gpt-4o-mini',
    temperature: 0.7,
    maxTokens: 1024,
    historyLimit: 20,
    knowledgeBaseId: null,
    knowledgeBase: null,
    tools: [],
    outputSchema: null,
    subAgentIds: [],
    agenda: null,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

// O Select do Radix, aberto em jsdom, precisa de três coisas que o jsdom não
// tem (scrollIntoView, pointer capture e ResizeObserver) — mesmas do CamposDoNo.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
  class ResizeObserverFalso {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(window, 'ResizeObserver', { writable: true, value: ResizeObserverFalso });
});

beforeEach(() => {
  vi.clearAllMocks();
  servico.getStatus.mockResolvedValue(STATUS);
  servico.listAgents.mockResolvedValue([agente()]);
  servico.listBases.mockResolvedValue([]);
  servico.createAgent.mockImplementation((input) =>
    Promise.resolve(agente({ id: 'novo', ...(input as Partial<AiAgent>) }))
  );
  servico.updateAgent.mockImplementation((id, input) =>
    Promise.resolve(agente({ id, ...(input as Partial<AiAgent>) }))
  );
});

function renderPagina() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminIaAgentesPage />
    </QueryClientProvider>
  );
}

const gatilho = (nome: string) => screen.getByRole('combobox', { name: nome });

/** Abre o Select pelo nome acessível do gatilho e escolhe a opção. */
async function escolherNoSelect(nomeDoSelect: string, opcao: string | RegExp) {
  fireEvent.click(gatilho(nomeDoSelect));
  fireEvent.click(await screen.findByRole('option', { name: opcao }));
}

/** Abre o diálogo de um agente novo, já com nome e prompt (os dois obrigatórios). */
async function abrirNovoAgente() {
  renderPagina();
  fireEvent.click(await screen.findByRole('button', { name: /Novo agente/ }));
  fireEvent.change(await screen.findByLabelText('Nome'), { target: { value: 'Marcus' } });
  fireEvent.change(screen.getByLabelText('Prompt do agente'), { target: { value: 'Você é o Marcus.' } });
}

/** Abre o diálogo de edição do agente que a lista mostra (o botão do lápis). */
async function abrirEdicao() {
  renderPagina();
  await screen.findByText('Marcus SDR');
  fireEvent.click(document.querySelector('svg.lucide-pencil')!.closest('button')!);
  await screen.findByLabelText('Nome');
}

async function salvar(chamada: typeof servico.createAgent | typeof servico.updateAgent) {
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(chamada).toHaveBeenCalled());
}

function enviado(chamada: typeof servico.createAgent | typeof servico.updateAgent): AiAgentInput {
  const ultima = chamada.mock.calls.at(-1);
  return (chamada === servico.updateAgent ? ultima?.[1] : ultima?.[0]) as AiAgentInput;
}

describe('modelo e raciocínio no diálogo do agente', () => {
  it('escolher gpt-5-mini mostra o seletor de Raciocínio em Baixo e o POST leva raciocinio: "low"', async () => {
    await abrirNovoAgente();
    expect(screen.queryByRole('combobox', { name: 'Raciocínio' })).toBeNull();

    await escolherNoSelect('Modelo', 'gpt-5-mini — custo-benefício, raciocínio');

    expect(gatilho('Raciocínio')).toHaveTextContent('Baixo');
    expect(screen.getByText('US$ 0,25 entrada / 2,00 saída por 1M tokens')).toBeInTheDocument();
    await salvar(servico.createAgent);

    expect(enviado(servico.createAgent)).toMatchObject({ model: 'gpt-5-mini', raciocinio: 'low' });
  });

  it('modelo que não raciocina vai com raciocinio: null, mesmo depois de passar por um que raciocina', async () => {
    await abrirNovoAgente();

    await escolherNoSelect('Modelo', 'gpt-5 — máxima qualidade, raciocínio');
    await escolherNoSelect('Raciocínio', 'Alto');
    await escolherNoSelect('Modelo', 'gpt-4.1 — recomendado para venda');
    expect(screen.queryByRole('combobox', { name: 'Raciocínio' })).toBeNull();
    await salvar(servico.createAgent);

    expect(enviado(servico.createAgent)).toMatchObject({ model: 'gpt-4.1', raciocinio: null });
  });

  it('agente com modelo fora do catálogo abre em "Outro modelo…" com o id, e o PATCH o mantém', async () => {
    servico.listAgents.mockResolvedValue([agente({ model: 'gpt-5.1', raciocinio: 'medium' })]);
    await abrirEdicao();

    expect(gatilho('Modelo')).toHaveTextContent('Outro modelo…');
    expect(screen.getByRole('textbox', { name: 'Id do modelo' })).toHaveValue('gpt-5.1');
    expect(gatilho('Raciocínio')).toHaveTextContent('Médio');
    await salvar(servico.updateAgent);

    expect(servico.updateAgent.mock.calls.at(-1)?.[0]).toBe('a1');
    expect(enviado(servico.updateAgent)).toMatchObject({ model: 'gpt-5.1', raciocinio: 'medium' });
  });

  it('o padrão do provedor mostra o id real e salva model: null', async () => {
    await abrirNovoAgente();

    expect(gatilho('Modelo')).toHaveTextContent('Padrão do provedor (gpt-4o-mini)');
    await salvar(servico.createAgent);

    expect(enviado(servico.createAgent)).toMatchObject({ model: null, raciocinio: null });
  });

  it('o 400 do backend aparece no toast com a mensagem dele', async () => {
    const mensagem = 'O modelo "gpt-9" não existe ou a chave desta conta não tem acesso a ele.';
    servico.createAgent.mockRejectedValue({ message: mensagem, status: 400 });
    await abrirNovoAgente();

    await escolherNoSelect('Modelo', 'Outro modelo…');
    fireEvent.change(screen.getByRole('textbox', { name: 'Id do modelo' }), { target: { value: 'gpt-9' } });
    await salvar(servico.createAgent);

    await waitFor(() =>
      expect(avisar).toHaveBeenCalledWith({
        title: 'Não foi possível salvar',
        description: mensagem,
        variant: 'destructive',
      })
    );
  });
});
