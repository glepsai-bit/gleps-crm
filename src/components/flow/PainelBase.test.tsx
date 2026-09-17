/**
 * PainelBase — a base de conhecimento editada por cima do canvas.
 *
 * Os três defeitos que estes testes travam são todos de PERDA SILENCIOSA:
 *  - a lista de bases falha e o painel acusa "a base não existe mais", levando
 *    o usuário a criar uma duplicada e desligar o bloco da base de verdade;
 *  - fechar no Esc / no X / no clique fora leva junto o documento que o usuário
 *    acabou de colar, sem perguntar nada;
 *  - salvar o "sobre o negócio" e ver o texto voltar ao valor antigo, o que
 *    parece — e é indistinguível de — não ter salvo.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PainelBase } from './PainelBase';
import {
  aiService,
  type AiStatus,
  type KnowledgeBase,
  type KnowledgeDoc,
} from '@/services/ai.backend.service';

vi.mock('@/services/ai.backend.service', () => ({
  aiService: {
    getStatus: vi.fn(),
    listAgents: vi.fn(),
    listBases: vi.fn(),
    createBase: vi.fn(),
    updateBase: vi.fn(),
    deleteBase: vi.fn(),
    searchBase: vi.fn(),
    listDocs: vi.fn(),
    createDoc: vi.fn(),
    reindexDoc: vi.fn(),
    deleteDoc: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const servico = vi.mocked(aiService);

const STATUS: AiStatus = {
  providers: { openai: true, anthropic: true },
  knowledgeBaseReady: true,
  transcriptionReady: true,
  tools: [],
};

function base(over: Partial<KnowledgeBase> = {}): KnowledgeBase {
  return {
    id: 'b1',
    name: 'Produto e preços',
    description: null,
    businessContext: 'Somos a Gleps.',
    docCount: 0,
    chunkCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

const SEM_DOCS: KnowledgeDoc[] = [];

function renderPainel(baseId: string | null = 'b1') {
  const onEscolher = vi.fn();
  const onFechar = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <PainelBase baseId={baseId} onEscolher={onEscolher} onFechar={onFechar} />
    </QueryClientProvider>
  );
  return { ...utils, onEscolher, onFechar };
}

/** O textarea do "sobre o negócio" não tem label associado; o placeholder é o âncora estável. */
function campoDoNegocio() {
  return screen.getByPlaceholderText(/Ticket a partir de/i) as HTMLTextAreaElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  servico.getStatus.mockResolvedValue(STATUS);
  servico.listAgents.mockResolvedValue([]);
  servico.listBases.mockResolvedValue([base()]);
  servico.listDocs.mockResolvedValue(SEM_DOCS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lista de bases que falhou', () => {
  it('não acusa sumiço da base — é o que faria o usuário criar uma duplicada', async () => {
    servico.listBases.mockRejectedValue(new Error('rede fora'));
    renderPainel('b1');

    expect(await screen.findByText(/Não deu pra carregar as bases/i)).toBeInTheDocument();
    expect(screen.queryByText(/não existe mais/i)).toBeNull();
  });

  it('bloqueia criar base enquanto a lista não chega', async () => {
    servico.listBases.mockRejectedValue(new Error('rede fora'));
    renderPainel('b1');

    await screen.findByText(/Não deu pra carregar as bases/i);
    expect(screen.getByRole('button', { name: /Nova base/i })).toBeDisabled();
  });

  it('com a lista OK, uma base realmente excluída continua sendo acusada', async () => {
    // Prova que o teste de cima não passa por acidente: a frase existe e
    // aparece quando a lista CHEGOU e a base não está nela.
    servico.listBases.mockResolvedValue([base({ id: 'outra' })]);
    renderPainel('b1');

    expect(
      await screen.findByText(/A base que estava neste bloco não existe mais/i)
    ).toBeInTheDocument();
  });
});

describe('fechar com documento pela metade', () => {
  async function abrirFormularioDeDocumento() {
    const painel = renderPainel('b1');
    await screen.findByRole('button', { name: /Documento/i });
    fireEvent.click(screen.getByRole('button', { name: /Documento/i }));
    fireEvent.change(await screen.findByLabelText('Título'), {
      target: { value: 'Tabela de preços 2026' },
    });
    return painel;
  }

  it('pergunta antes de sair e, no cancelar, o painel e o texto continuam lá', async () => {
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onFechar } = await abrirFormularioDeDocumento();

    // Esc é o caminho mais fácil de perder o texto sem querer.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(onFechar).not.toHaveBeenCalled();
    // `open` é fixo no componente: quem fecha de verdade é o pai, ao receber
    // onFechar. Então "continua aberto" se prova pelo conteúdo ainda montado.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe(
      'Tabela de preços 2026'
    );
  });

  it('confirmando, aí sim fecha', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onFechar } = await abrirFormularioDeDocumento();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('sem nada escrito, fechar não incomoda o usuário com confirmação', async () => {
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onFechar } = renderPainel('b1');
    await screen.findByRole('button', { name: /Documento/i });

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(confirmar).not.toHaveBeenCalled();
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('o badge "não salvo" acende com o rascunho da base nova', async () => {
    renderPainel('b1');
    await screen.findByRole('button', { name: /Nova base/i });
    expect(screen.queryByText('não salvo')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Nova base/i }));
    fireEvent.change(screen.getByLabelText('Nome'), { target: { value: 'Objeções' } });

    expect(screen.getByText('não salvo')).toBeInTheDocument();
  });
});

describe('salvar "sobre o negócio"', () => {
  it('o texto salvo permanece na tela — não volta ao valor antigo', async () => {
    // A lista só responde UMA vez; a revalidação disparada pelo sucesso fica
    // pendurada. Assim, a única coisa capaz de manter o texto novo na tela é a
    // escrita no cache feita pelo onSuccess — que é exatamente o que se testa.
    let chamadas = 0;
    servico.listBases.mockImplementation(() => {
      chamadas += 1;
      return chamadas === 1
        ? Promise.resolve([base()])
        : new Promise<KnowledgeBase[]>(() => {});
    });
    servico.updateBase.mockImplementation((id, input) =>
      Promise.resolve(base({ id, businessContext: input.businessContext ?? null }))
    );

    renderPainel('b1');
    const campo = await waitFor(campoDoNegocio);
    expect(campo.value).toBe('Somos a Gleps.');

    fireEvent.change(campo, { target: { value: 'Vendemos CRM para clínicas.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(servico.updateBase).toHaveBeenCalledWith('b1', {
        businessContext: 'Vendemos CRM para clínicas.',
      })
    );

    // O rascunho local é descartado no sucesso (os botões somem); daí em diante
    // o textarea mostra o que está no cache.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Salvar' })).toBeNull());
    expect(campoDoNegocio().value).toBe('Vendemos CRM para clínicas.');
  });

  it('cancelar devolve o texto antigo', async () => {
    renderPainel('b1');
    const campo = await waitFor(campoDoNegocio);

    fireEvent.change(campo, { target: { value: 'rascunho descartável' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));

    expect(campoDoNegocio().value).toBe('Somos a Gleps.');
    expect(servico.updateBase).not.toHaveBeenCalled();
  });
});
