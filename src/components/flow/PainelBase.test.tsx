/**
 * PainelBase — a base de conhecimento editada por cima do canvas.
 *
 * Os defeitos que estes testes travam são de PERDA SILENCIOSA:
 *  - a lista de bases falha e o painel acusa "a base não existe mais", levando
 *    o usuário a criar uma duplicada e desligar o bloco da base de verdade;
 *  - fechar no Esc / no X / no clique fora leva junto o documento que o usuário
 *    acabou de colar, sem perguntar nada;
 *  - salvar o "sobre o negócio" e ver o texto voltar ao valor antigo, o que
 *    parece — e é indistinguível de — não ter salvo;
 *  - um arquivo que entra pelo caminho errado (PDF como texto puro, planilha
 *    como binário) vira lixo indexado sem ninguém perceber;
 *  - o erro que o servidor devolve (PDF escaneado, página sem texto) morre num
 *    toast e o usuário fica sem saber por que o documento não apareceu.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as XLSX from 'xlsx';
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
    uploadDoc: vi.fn(),
    createDocFromUrl: vi.fn(),
    reindexDoc: vi.fn(),
    deleteDoc: vi.fn(),
  },
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { toast } from 'sonner';

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

function doc(over: Partial<KnowledgeDoc> = {}): KnowledgeDoc {
  return {
    id: 'd1',
    title: 'Catálogo',
    summary: null,
    sourceType: 'file',
    sourceRef: 'catalogo.pdf',
    status: 'pending',
    error: null,
    chunkCount: 0,
    tokens: 0,
    indexedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
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

/**
 * O jsdom desta versão não implementa `File.text()` nem `File.arrayBuffer()`
 * (o navegador tem os dois). O componente usa exatamente esses; aqui eles são
 * postos no objeto à mão, com o conteúdo que o teste quer.
 */
function arquivo(nome: string, conteudo: string | ArrayBuffer, tipo = ''): File {
  const f = new File([conteudo], nome, { type: tipo });
  Object.defineProperty(f, 'text', {
    value: () =>
      Promise.resolve(
        typeof conteudo === 'string' ? conteudo : new TextDecoder().decode(conteudo)
      ),
  });
  Object.defineProperty(f, 'arrayBuffer', {
    value: () =>
      Promise.resolve(
        typeof conteudo === 'string' ? new TextEncoder().encode(conteudo).buffer : conteudo
      ),
  });
  return f;
}

/** Uma planilha de verdade, escrita pela mesma lib que o painel usa pra ler. */
function planilhaXlsx(): ArrayBuffer {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Produto', 'Preço'],
    ['Básico', 'R$ 297'],
    ['Pro', 'R$ 497'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Tabela');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

async function abrirEnviarArquivo() {
  const painel = renderPainel('b1');
  fireEvent.click(await screen.findByRole('button', { name: /Enviar arquivo/i }));
  return { ...painel, input: screen.getByLabelText('Arquivo') as HTMLInputElement };
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
  vi.unstubAllGlobals();
});

describe('criar base a partir do arquivo', () => {
  /*
    O formulário pedia um NOME — abstração — para alguém que chegou com um
    arquivo na mão. Numa conta real a pessoa colou a tabela de preços no campo
    do nome, e nome de base não é indexado: nunca chegou ao agente.
  */
  it('o arquivo cria a base e o nome sai dele', async () => {
    servico.createBase.mockResolvedValue({ ...base(), id: 'nova-1', name: 'Tabela de precos' });
    servico.uploadDoc.mockResolvedValue(doc());
    const { onEscolher } = renderPainel();

    fireEvent.click(await screen.findByRole('button', { name: /nova base/i }));
    const arquivo = new File(['%PDF-1.4'], 'tabela-de-precos.pdf', { type: 'application/pdf' });
    fireEvent.change(document.getElementById('pb-arquivo-novo')!, { target: { files: [arquivo] } });

    await waitFor(() => expect(servico.createBase).toHaveBeenCalled());
    // O nome vem do arquivo, sem hífen e com maiúscula.
    expect(servico.createBase.mock.calls[0][0].name).toBe('Tabela de precos');
    await waitFor(() => expect(servico.uploadDoc).toHaveBeenCalled());
    expect(servico.uploadDoc.mock.calls[0][1]).toBe(arquivo);
    await waitFor(() => expect(onEscolher).toHaveBeenCalledWith('nova-1'));
  });

  it('arquivo recusado não joga fora a base recém-criada', async () => {
    servico.createBase.mockResolvedValue({ ...base(), id: 'nova-2' });
    servico.uploadDoc.mockRejectedValue(new Error('PDF sem texto (provavelmente escaneado).'));
    const { onEscolher } = renderPainel();

    fireEvent.click(await screen.findByRole('button', { name: /nova base/i }));
    fireEvent.change(document.getElementById('pb-arquivo-novo')!, {
      target: { files: [new File([''], 'escaneado.pdf', { type: 'application/pdf' })] },
    });

    // A base fica em pé: a pessoa tenta outro arquivo sem recomeçar.
    await waitFor(() => expect(onEscolher).toHaveBeenCalledWith('nova-2'));
    // E o erro não passa em branco: neste instante o painel está trocando de
    // base, então o aviso da seção de material ainda não está montado.
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/escaneado/i))
    );
  });
});

describe('base vazia oferece os quatro assuntos', () => {
  /*
    Base em branco é onde a pessoa trava. E a divisão não é estética: em
    produção, documento de assunto único deu 0,58–0,65 nas buscas, e o que
    misturava quatro assuntos deu 0,35.
  */
  it('mostra o modelo em vez de "nenhum documento"', async () => {
    servico.listDocs.mockResolvedValue([]);
    renderPainel();
    expect(await screen.findByRole('button', { name: /Preços/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dúvidas frequentes/ })).toBeInTheDocument();
  });

  it('escolher um assunto já abre o formulário com o título preenchido', async () => {
    servico.listDocs.mockResolvedValue([]);
    renderPainel();
    // "Dúvidas frequentes" cai no caminho de TEXTO, onde o título aparece na
    // hora — no caminho de arquivo o campo só existe depois de escolher o arquivo.
    fireEvent.click(await screen.findByRole('button', { name: /Dúvidas frequentes/ }));
    await waitFor(() =>
      expect(screen.getByDisplayValue('Dúvidas frequentes')).toBeInTheDocument()
    );
  });
});

describe('criar base: o nome é o assunto, não o conteúdo', () => {
  /*
    Caso real: uma conta em produção tem uma base chamada
    "Botox:500, Harmonização:300," — a tabela de preços foi digitada no campo
    do NOME. Nome de base não é indexado, então aquele preço nunca chegou ao
    agente e nada avisou.
  */
  it('avisa quando o nome tem cara de tabela de preços', async () => {
    renderPainel();
    fireEvent.click(await screen.findByRole('button', { name: /nova base/i }));
    fireEvent.change(screen.getByLabelText(/nome do assunto/i), {
      target: { value: 'Botox:500, Harmonização:300, Limpeza:180,' },
    });
    // O aviso diz o que fazer, não só que está errado: aponta pro Material.
    const aviso = screen.getByText(/parece o/i);
    expect(aviso).toBeInTheDocument();
    expect(aviso.textContent).toMatch(/Material/);
  });

  it('nome normal não dispara aviso nenhum', async () => {
    renderPainel();
    fireEvent.click(await screen.findByRole('button', { name: /nova base/i }));
    fireEvent.change(screen.getByLabelText(/nome do assunto/i), {
      target: { value: 'Produto e preços' },
    });
    expect(screen.queryByText(/parece o/i)).toBeNull();
  });

  it('o aviso não impede criar — só avisa', async () => {
    renderPainel();
    fireEvent.click(await screen.findByRole('button', { name: /nova base/i }));
    fireEvent.change(screen.getByLabelText(/nome do assunto/i), {
      target: { value: 'Botox:500, Harmonização:300, Limpeza:180,' },
    });
    expect(screen.getByRole('button', { name: /criar e usar/i })).toBeEnabled();
  });
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

describe('escolher, criar e excluir a base — com texto, não só ícone', () => {
  it('as três ações estão visíveis e "Excluir esta" abre a confirmação com nome e contagem', async () => {
    servico.listBases.mockResolvedValue([base({ docCount: 3, chunkCount: 41 })]);
    renderPainel('b1');

    expect(await screen.findByRole('button', { name: /Criar nova base/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /Escolher base existente/i })).toBeInTheDocument();
    const excluir = screen.getByRole('button', { name: /Excluir a base Produto e preços/i });
    expect(excluir).toHaveTextContent('Excluir esta');

    fireEvent.click(excluir);
    const aviso = await screen.findByText(/apaga 3 documento\(s\) e os 41 trechos/i);
    expect(aviso).toHaveTextContent('Produto e preços');
    expect(screen.getByRole('button', { name: 'Excluir a base' })).toBeInTheDocument();
  });

  it('sem base ligada, "Excluir esta" fica visível mas desligado', async () => {
    renderPainel(null);
    await screen.findByRole('button', { name: /Criar nova base/i });
    expect(screen.getByRole('button', { name: /Excluir esta base/i })).toBeDisabled();
  });
});

describe('fechar com documento pela metade', () => {
  async function abrirFormularioDeDocumento() {
    const painel = renderPainel('b1');
    fireEvent.click(await screen.findByRole('button', { name: /Colar texto/i }));
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
    await screen.findByRole('button', { name: /Colar texto/i });

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(confirmar).not.toHaveBeenCalled();
    expect(onFechar).toHaveBeenCalledTimes(1);
  });

  it('um arquivo escolhido e ainda não enviado também conta como rascunho', async () => {
    const confirmar = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onFechar, input } = await abrirEnviarArquivo();
    fireEvent.change(input, { target: { files: [arquivo('catalogo.pdf', '%PDF-1.4')] } });
    await screen.findByText('catalogo.pdf');

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(confirmar).toHaveBeenCalledTimes(1);
    expect(onFechar).not.toHaveBeenCalled();
  });

  it('o badge "não salvo" acende com o rascunho da base nova', async () => {
    renderPainel('b1');
    await screen.findByRole('button', { name: /Nova base/i });
    expect(screen.queryByText('não salvo')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Nova base/i }));
    fireEvent.change(screen.getByLabelText(/nome do assunto/i), { target: { value: 'Objeções' } });

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

describe('enviar arquivo — cada formato pelo caminho certo', () => {
  it('xlsx vira CSV no navegador antes de enviar, e vai como texto com o nome de origem', async () => {
    servico.createDoc.mockResolvedValue(doc({ title: 'precos', sourceRef: 'precos.xlsx' }));
    const { input } = await abrirEnviarArquivo();

    fireEvent.change(input, { target: { files: [arquivo('precos.xlsx', planilhaXlsx())] } });
    await screen.findByText('precos.xlsx');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para indexação' }));

    await waitFor(() =>
      expect(servico.createDoc).toHaveBeenCalledWith('b1', {
        title: 'precos',
        content: 'Produto,Preço\nBásico,R$ 297\nPro,R$ 497',
        sourceType: 'file',
        sourceRef: 'precos.xlsx',
      })
    );
    // A planilha NUNCA sobe como binário: o servidor não a aceita.
    expect(servico.uploadDoc).not.toHaveBeenCalled();
  });

  it('pdf vai inteiro por multipart, com o título opcional que o usuário digitou', async () => {
    servico.uploadDoc.mockResolvedValue(doc());
    const { input } = await abrirEnviarArquivo();
    const pdf = arquivo('catalogo.pdf', '%PDF-1.4 ...', 'application/pdf');

    fireEvent.change(input, { target: { files: [pdf] } });
    await screen.findByText('catalogo.pdf');
    fireEvent.change(screen.getByLabelText('Título (opcional)'), {
      target: { value: 'Catálogo 2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para indexação' }));

    await waitFor(() => expect(servico.uploadDoc).toHaveBeenCalledWith('b1', pdf, 'Catálogo 2026'));
    // O navegador não tenta ler o PDF como texto: isso é o que gerava lixo indexado.
    expect(servico.createDoc).not.toHaveBeenCalled();
  });

  it('.txt é lido no navegador e entra como arquivo, com o nome de origem', async () => {
    servico.createDoc.mockResolvedValue(doc({ title: 'faq', sourceRef: 'faq.txt' }));
    const { input } = await abrirEnviarArquivo();

    fireEvent.change(input, {
      target: { files: [arquivo('faq.txt', 'Pergunta: horário?\nResposta: 8h às 18h.')] },
    });
    await screen.findByText('faq.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para indexação' }));

    await waitFor(() =>
      expect(servico.createDoc).toHaveBeenCalledWith('b1', {
        title: 'faq',
        content: 'Pergunta: horário?\nResposta: 8h às 18h.',
        sourceType: 'file',
        sourceRef: 'faq.txt',
      })
    );
  });

  it('formato que ninguém aceita é barrado na hora, sem chamar o servidor', async () => {
    const { input } = await abrirEnviarArquivo();

    fireEvent.change(input, { target: { files: [arquivo('foto.png', 'PNG')] } });

    expect(await screen.findByRole('alert')).toHaveTextContent(/Formato não aceito \(\.png\)/);
    expect(screen.getByRole('button', { name: 'Enviar para indexação' })).toBeDisabled();
    expect(servico.uploadDoc).not.toHaveBeenCalled();
    expect(servico.createDoc).not.toHaveBeenCalled();
  });

  it('o 422 do servidor (PDF escaneado) aparece na tela, como veio, ao lado do botão', async () => {
    const mensagem =
      'PDF sem texto (provavelmente escaneado). Não é lido: converta pra texto ou cole o conteúdo.';
    // O apiClient e o upload rejeitam com um objeto { message, status }, não com Error.
    servico.uploadDoc.mockRejectedValue({ message: mensagem, code: 'DOCUMENTO_ILEGIVEL', status: 422 });
    const { input } = await abrirEnviarArquivo();

    fireEvent.change(input, { target: { files: [arquivo('escaneado.pdf', '%PDF-1.4')] } });
    await screen.findByText('escaneado.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar para indexação' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(mensagem);
    // O arquivo continua escolhido: o usuário lê o motivo e decide o que fazer.
    expect(screen.getByText('escaneado.pdf')).toBeInTheDocument();
  });
});

describe('página do site', () => {
  it('chama o serviço de URL com a base e o endereço, sem título quando não há', async () => {
    servico.createDocFromUrl.mockResolvedValue(doc({ sourceType: 'url', sourceRef: 'https://gleps.com.br/planos' }));
    renderPainel('b1');
    fireEvent.click(await screen.findByRole('button', { name: /Página do site/i }));

    fireEvent.change(screen.getByLabelText('Endereço da página'), {
      target: { value: 'https://gleps.com.br/planos' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Importar página' }));

    await waitFor(() =>
      expect(servico.createDocFromUrl).toHaveBeenCalledWith(
        'b1',
        'https://gleps.com.br/planos',
        undefined
      )
    );
    expect(servico.createDoc).not.toHaveBeenCalled();
    expect(servico.uploadDoc).not.toHaveBeenCalled();
  });

  it('endereço sem esquema ganha https:// — é como a maioria digita', async () => {
    servico.createDocFromUrl.mockResolvedValue(doc({ sourceType: 'url' }));
    renderPainel('b1');
    fireEvent.click(await screen.findByRole('button', { name: /Página do site/i }));

    fireEvent.change(screen.getByLabelText('Endereço da página'), {
      target: { value: 'gleps.com.br/planos' },
    });
    fireEvent.change(screen.getByLabelText('Título (opcional)'), {
      target: { value: 'Planos' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Importar página' }));

    await waitFor(() =>
      expect(servico.createDocFromUrl).toHaveBeenCalledWith(
        'b1',
        'https://gleps.com.br/planos',
        'Planos'
      )
    );
  });

  it('página sem texto útil (422) aparece na tela, como veio', async () => {
    servico.createDocFromUrl.mockRejectedValue({
      message: 'A página não tem texto útil para indexar.',
      code: 'DOCUMENTO_ILEGIVEL',
      status: 422,
    });
    renderPainel('b1');
    fireEvent.click(await screen.findByRole('button', { name: /Página do site/i }));

    fireEvent.change(screen.getByLabelText('Endereço da página'), {
      target: { value: 'https://gleps.com.br/vazia' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Importar página' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A página não tem texto útil para indexar.'
    );
  });
});

/**
 * O que o serviço de verdade manda pela rede. O mock lá em cima cobre o
 * painel; aqui o módulo real entra por `importActual` e só o `fetch` é falso —
 * é o único jeito de provar que a URL e o corpo batem com o contrato do
 * servidor (multipart no campo `file`; JSON { url, title } no de URL).
 */
describe('aiService real — endpoints de upload e URL', () => {
  type ServicoReal = typeof import('@/services/ai.backend.service');

  function respostaOk(body: unknown, status = 201) {
    return { ok: true, status, statusText: 'Created', json: () => Promise.resolve(body) };
  }

  it('uploadDoc: POST multipart em /api/ai/bases/:baseId/docs/upload, campo "file", sem Content-Type fixo', async () => {
    const { aiService: real } = await vi.importActual<ServicoReal>(
      '@/services/ai.backend.service'
    );
    const fetchFalso = vi.fn().mockResolvedValue(respostaOk({ data: doc() }));
    vi.stubGlobal('fetch', fetchFalso);
    const pdf = new File(['%PDF-1.4'], 'catalogo.pdf', { type: 'application/pdf' });

    const criado = await real.uploadDoc('b1', pdf, 'Catálogo');

    expect(criado.id).toBe('d1');
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFalso.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/ai\/bases\/b1\/docs\/upload$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect((form.get('file') as File).name).toBe('catalogo.pdf');
    expect(form.get('title')).toBe('Catálogo');
    // Com Content-Type fixo o navegador não põe o boundary e o multer não lê nada.
    expect(Object.keys((init.headers as Record<string, string>) ?? {})).not.toContain(
      'Content-Type'
    );
  });

  it('uploadDoc: 422 do servidor vira { message, code, status } — o mesmo formato do apiClient', async () => {
    const { aiService: real } = await vi.importActual<ServicoReal>(
      '@/services/ai.backend.service'
    );
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        statusText: 'Unprocessable Entity',
        json: () =>
          Promise.resolve({
            error: { code: 'DOCUMENTO_ILEGIVEL', message: 'PDF sem texto (provavelmente escaneado).' },
          }),
      })
    );

    await expect(
      real.uploadDoc('b1', new File(['x'], 'a.pdf'))
    ).rejects.toEqual({
      message: 'PDF sem texto (provavelmente escaneado).',
      code: 'DOCUMENTO_ILEGIVEL',
      status: 422,
    });
  });

  it('createDocFromUrl: POST JSON { url, title } em /api/ai/bases/:baseId/docs/url', async () => {
    const { aiService: real } = await vi.importActual<ServicoReal>(
      '@/services/ai.backend.service'
    );
    const fetchFalso = vi.fn().mockResolvedValue(
      respostaOk({ data: doc({ sourceType: 'url', sourceRef: 'https://gleps.com.br/planos' }) })
    );
    vi.stubGlobal('fetch', fetchFalso);

    const criado = await real.createDocFromUrl('b1', 'https://gleps.com.br/planos', 'Planos');

    expect(criado.sourceType).toBe('url');
    const [url, init] = fetchFalso.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/ai\/bases\/b1\/docs\/url$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      url: 'https://gleps.com.br/planos',
      title: 'Planos',
    });
  });
});
