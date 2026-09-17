/**
 * T-038 — o agente editado por cima do canvas.
 *
 * Estes testes existem por causa de um bug que passou em produção: incluir uma
 * rota nova reescrevia o enum de `rota` SÓ com a rota nova. Como o backend
 * resolve a saída por `rota` antes de olhar qualquer outro campo, o modelo —
 * proibido de dizer respondeu/humano/encerrou — mandava TODA conversa pelo
 * desvio. As três saídas de sempre morriam sem erro nenhum na tela.
 *
 * `comRotas` não é exportada de propósito (o texto do formato é a única fonte
 * de verdade), então o que se trava aqui é o que de fato importa: o payload que
 * sai para a API depois do usuário mexer na interface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PainelAgente } from './PainelAgente';
import {
  aiService,
  type AiAgent,
  type AiAgentInput,
  type AiStatus,
} from '@/services/ai.backend.service';

vi.mock('@/services/ai.backend.service', () => ({
  aiService: {
    getStatus: vi.fn(),
    listAgents: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { toast } from 'sonner';

const servico = vi.mocked(aiService);
const avisos = vi.mocked(toast);

const STATUS: AiStatus = {
  providers: { openai: true, anthropic: true },
  knowledgeBaseReady: true,
  transcriptionReady: true,
  tools: [],
};

const ETAPAS = [
  'novo-lead',
  'em-atendimento',
  'aguardando-resposta',
  'agendado',
  'convertido',
  'perdido',
];

function agente(over: Partial<AiAgent> = {}): AiAgent {
  return {
    id: 'a1',
    name: 'Marcus SDR',
    description: 'Qualifica lead novo de WhatsApp',
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
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

/** Formato completo, do jeito que o backend sugere — sem `rota`. */
const ESQUEMA_SADIO: Record<string, unknown> = {
  type: 'object',
  properties: {
    mensagem_de_resposta: { type: 'string', description: 'O que enviar ao lead.' },
    etapa: { type: 'string', enum: ETAPAS, description: 'Etapa do funil.' },
    transferir_para_humano: { type: 'boolean', description: 'Pediu humano.' },
    resolver_conversa: { type: 'boolean', description: 'Acabou.' },
  },
  required: ['mensagem_de_resposta', 'etapa', 'transferir_para_humano'],
};

interface EsquemaLido {
  properties: Record<string, Record<string, unknown> | undefined>;
  required: string[];
}

/** Lê o formato que foi ENVIADO para a API, sem `any` e sem confiar em forma. */
function esquemaEnviado(input: AiAgentInput | undefined): EsquemaLido {
  const bruto = input?.outputSchema;
  if (!bruto || typeof bruto !== 'object') {
    throw new Error('nenhum formato de resposta foi enviado para a API');
  }
  const props = bruto.properties;
  const required = bruto.required;
  return {
    properties:
      props && typeof props === 'object'
        ? (props as Record<string, Record<string, unknown> | undefined>)
        : {},
    required: Array.isArray(required)
      ? required.filter((c): c is string => typeof c === 'string')
      : [],
  };
}

function enumDaRota(esquema: EsquemaLido): string[] {
  const lista = esquema.properties.rota?.enum;
  return Array.isArray(lista) ? lista.filter((v): v is string => typeof v === 'string') : [];
}

function ultimoUpdate(): AiAgentInput | undefined {
  return servico.updateAgent.mock.calls.at(-1)?.[1];
}

function renderPainel(agentId: string | null = 'a1') {
  const onEscolher = vi.fn();
  const onFechar = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <PainelAgente agentId={agentId} onEscolher={onEscolher} onFechar={onFechar} />
    </QueryClientProvider>
  );
  return { ...utils, onEscolher, onFechar };
}

/** Espera o formulário aparecer — antes disso só existe o esqueleto de carga. */
function esperarFormulario() {
  return screen.findByLabelText('Nome');
}

function incluirRota(nome: string) {
  fireEvent.change(screen.getByPlaceholderText('financeiro'), { target: { value: nome } });
  fireEvent.click(screen.getByRole('button', { name: 'Incluir' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  servico.getStatus.mockResolvedValue(STATUS);
  servico.listAgents.mockResolvedValue([agente()]);
  servico.updateAgent.mockImplementation((id, input) =>
    Promise.resolve(agente({ id, ...(input as Partial<AiAgent>) }))
  );
  servico.createAgent.mockImplementation((input) =>
    Promise.resolve(agente({ id: 'novo', ...(input as Partial<AiAgent>) }))
  );
});

describe('enum de rota — o bug que mandava toda conversa pelo desvio', () => {
  it('incluir uma rota nova MANTÉM respondeu, humano e encerrou no enum', async () => {
    servico.listAgents.mockResolvedValue([agente({ outputSchema: ESQUEMA_SADIO })]);
    renderPainel();
    await esperarFormulario();

    incluirRota('financeiro');
    expect(screen.getByText('financeiro')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(servico.updateAgent).toHaveBeenCalled());

    // As fixas NA FRENTE e a nova no fim: é esta lista que o backend lê para
    // decidir a saída do bloco.
    expect(enumDaRota(esquemaEnviado(ultimoUpdate()))).toEqual([
      'respondeu',
      'humano',
      'encerrou',
      'financeiro',
    ]);
  });

  it('remover a última rota tira `rota` do formato em vez de deixar enum vazio', async () => {
    servico.listAgents.mockResolvedValue([
      agente({
        outputSchema: {
          ...ESQUEMA_SADIO,
          properties: {
            ...(ESQUEMA_SADIO.properties as Record<string, unknown>),
            rota: { type: 'string', enum: ['respondeu', 'humano', 'encerrou', 'financeiro'] },
          },
        },
      }),
    ]);
    renderPainel();
    await esperarFormulario();

    fireEvent.click(screen.getByRole('button', { name: 'Remover financeiro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(servico.updateAgent).toHaveBeenCalled());

    expect(esquemaEnviado(ultimoUpdate()).properties.rota).toBeUndefined();
  });

  it('segunda rota não apaga a primeira', async () => {
    servico.listAgents.mockResolvedValue([agente({ outputSchema: ESQUEMA_SADIO })]);
    renderPainel();
    await esperarFormulario();

    incluirRota('financeiro');
    incluirRota('suporte');

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(servico.updateAgent).toHaveBeenCalled());

    expect(enumDaRota(esquemaEnviado(ultimoUpdate()))).toEqual([
      'respondeu',
      'humano',
      'encerrou',
      'financeiro',
      'suporte',
    ]);
  });
});

describe('`rota` nunca é obrigatória', () => {
  it('sai de `required` mesmo quando o formato salvo a exigia', async () => {
    servico.listAgents.mockResolvedValue([
      agente({
        outputSchema: {
          ...ESQUEMA_SADIO,
          properties: {
            ...(ESQUEMA_SADIO.properties as Record<string, unknown>),
            rota: { type: 'string', enum: ['respondeu', 'humano', 'encerrou', 'financeiro'] },
          },
          // Formato legado: exigia a rota em toda mensagem.
          required: ['mensagem_de_resposta', 'rota'],
        },
      }),
    ]);
    renderPainel();
    await esperarFormulario();

    incluirRota('suporte');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(servico.updateAgent).toHaveBeenCalled());

    const esquema = esquemaEnviado(ultimoUpdate());
    expect(esquema.required).not.toContain('rota');
    expect(esquema.required).toContain('mensagem_de_resposta');
  });
});

describe('formato padrão criado pelo painel', () => {
  it('agente sem formato ganha mensagem_de_resposta, etapa, humano e encerrou', async () => {
    servico.listAgents.mockResolvedValue([agente({ outputSchema: null })]);
    renderPainel();
    await esperarFormulario();

    // Só a rota é criada pela interface; o resto do formato vem do padrão.
    incluirRota('financeiro');
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(servico.updateAgent).toHaveBeenCalled());

    const esquema = esquemaEnviado(ultimoUpdate());
    // Campo fora do formato = campo que o modelo fica PROIBIDO de emitir, por
    // causa do additionalProperties:false do modo estrito.
    expect(Object.keys(esquema.properties).sort()).toEqual(
      ['etapa', 'mensagem_de_resposta', 'resolver_conversa', 'rota', 'transferir_para_humano'].sort()
    );
    expect(esquema.properties.etapa?.enum).toEqual(ETAPAS);
    expect(esquema.required).toEqual([
      'mensagem_de_resposta',
      'etapa',
      'transferir_para_humano',
    ]);
  });
});

describe('formato com enum de rota quebrado', () => {
  const SO_O_DESVIO: Record<string, unknown> = {
    ...ESQUEMA_SADIO,
    properties: {
      ...(ESQUEMA_SADIO.properties as Record<string, unknown>),
      rota: { type: 'string', enum: ['financeiro'] },
    },
  };

  it('avisa, ao abrir, quais saídas fixas o enum não deixa o agente dizer', async () => {
    servico.listAgents.mockResolvedValue([agente({ outputSchema: SO_O_DESVIO })]);
    renderPainel();
    await esperarFormulario();

    const aviso = screen.getByText(/não deixa o agente dizer/i);
    expect(within(aviso).getByText('respondeu')).toBeInTheDocument();
    expect(within(aviso).getByText('humano')).toBeInTheDocument();
    expect(within(aviso).getByText('encerrou')).toBeInTheDocument();
  });

  it('"Repor as saídas fixas" conserta o enum e o aviso some', async () => {
    servico.listAgents.mockResolvedValue([agente({ outputSchema: SO_O_DESVIO })]);
    renderPainel();
    await esperarFormulario();

    fireEvent.click(screen.getByRole('button', { name: 'Repor as saídas fixas' }));
    expect(screen.queryByText(/não deixa o agente dizer/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(servico.updateAgent).toHaveBeenCalled());
    expect(enumDaRota(esquemaEnviado(ultimoUpdate()))).toEqual([
      'respondeu',
      'humano',
      'encerrou',
      'financeiro',
    ]);
  });

  it('formato sem os sinais de saída avisa só o que falta de verdade', async () => {
    servico.listAgents.mockResolvedValue([
      agente({
        outputSchema: {
          type: 'object',
          properties: {
            mensagem_de_resposta: { type: 'string' },
            transferir_para_humano: { type: 'boolean' },
            resolver_conversa: { type: 'boolean' },
          },
          required: ['mensagem_de_resposta'],
        },
      }),
    ]);
    renderPainel();
    await esperarFormulario();

    const aviso = screen.getByText(/O formato não declara/i);
    expect(within(aviso).getByText('etapa')).toBeInTheDocument();
    expect(aviso.textContent).toContain('a etapa deixa de subir pro funil');
    // As outras duas consequências NÃO podem ser afirmadas: os campos estão lá.
    expect(aviso.textContent).not.toContain('a saída humano fica morta');
    expect(aviso.textContent).not.toContain('a saída encerrou fica morta');

    fireEvent.click(screen.getByRole('button', { name: 'Incluir os campos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(servico.updateAgent).toHaveBeenCalled());
    expect(esquemaEnviado(ultimoUpdate()).properties.etapa?.enum).toEqual(ETAPAS);
  });
});

describe('campos numéricos', () => {
  it('apagar o conteúdo não trava o campo em 0', async () => {
    renderPainel();
    await esperarFormulario();

    const tokens = screen.getByLabelText('Resposta máx.') as HTMLInputElement;
    expect(tokens.value).toBe('1024');

    fireEvent.change(tokens, { target: { value: '' } });
    // O bug era aqui: `Number('')` é 0, e o campo passava a mostrar "0" —
    // impossível digitar "2048" porque cada tecla começava depois do zero.
    expect(tokens.value).toBe('');

    fireEvent.change(tokens, { target: { value: '2048' } });
    expect(tokens.value).toBe('2048');

    fireEvent.blur(tokens);
    expect(tokens.value).toBe('2048');
  });

  it('campo vazio volta ao padrão ao sair, não a 0', async () => {
    renderPainel();
    await esperarFormulario();

    const tokens = screen.getByLabelText('Resposta máx.') as HTMLInputElement;
    fireEvent.change(tokens, { target: { value: '' } });
    fireEvent.blur(tokens);
    expect(tokens.value).toBe('1024');
  });

  it('valor fora da faixa é barrado em português ANTES de chamar a API', async () => {
    // Valor fora da faixa que chega do próprio banco (registro antigo): o
    // usuário nem encosta no campo, então o ajuste do blur nunca roda e quem
    // segura é a conferência do salvar.
    servico.listAgents.mockResolvedValue([agente({ maxTokens: 999999 })]);
    renderPainel();
    await esperarFormulario();

    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(servico.updateAgent).not.toHaveBeenCalled();
    expect(avisos.error).toHaveBeenCalled();
    const mensagem = String(vi.mocked(avisos.error).mock.calls.at(-1)?.[0]);
    expect(mensagem).toContain('Resposta máx.');
    expect(mensagem).toMatch(/precisa ser um número entre/);
  });
});

describe('lista de agentes que falhou', () => {
  it('não se passa por "nenhum agente" nem por "agente excluído"', async () => {
    servico.listAgents.mockRejectedValue(new Error('rede fora'));
    renderPainel('a1');

    expect(await screen.findByText(/Não consegui carregar os agentes/i)).toBeInTheDocument();
    // As duas frases que induziriam o usuário a criar um agente duplicado.
    expect(screen.queryByText(/Nenhum agente neste passo/i)).toBeNull();
    expect(screen.queryByText(/não existe mais/i)).toBeNull();
    // E criar fica bloqueado enquanto a lista não chega.
    expect(screen.getByRole('button', { name: /Criar agente/i })).toBeDisabled();
  });

  it('com a lista OK, um agente realmente excluído continua sendo acusado', async () => {
    // Prova que o teste acima não passa por acidente: a mensagem existe e
    // aparece quando de fato deve.
    servico.listAgents.mockResolvedValue([agente({ id: 'outro' })]);
    renderPainel('a1');

    expect(
      await screen.findByText(/O agente deste passo não existe mais/i)
    ).toBeInTheDocument();
  });
});
