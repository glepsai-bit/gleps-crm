/**
 * Novo disparo: preview por tipo de lista, variável no cursor, anexo, payload final.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
// jsdom não implementa estes dois; o Radix Select/Checkbox os chama.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.hasPointerCapture = vi.fn(() => false);

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, account: { id: 'acc1' } }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/api/client', () => ({
  apiClient: { get: vi.fn(async () => [{ id: 'pub1', name: 'Pacientes sem retorno', total_leads: 120 }]) },
  tokenManager: { getToken: () => null },
}));
vi.mock('@/services/tags.backend.service', () => ({
  tagsBackendService: {
    listStageTags: vi.fn(async () => [{ id: 'etapa1', name: 'Em negociação', type: 'stage' }]),
    listAllTags: vi.fn(async () => [
      { id: 'etapa1', name: 'Em negociação', type: 'stage' },
      { id: 'tag1', name: 'consulta amanhã', type: 'operational' },
    ]),
  },
}));
vi.mock('@/services/whatsapp-templates.backend.service', () => ({ createTemplate: vi.fn(async () => ({})) }));
vi.mock('@/services/disparos.backend.service', async (orig) => {
  const real = await orig<typeof import('@/services/disparos.backend.service')>();
  return {
    ...real,
    disparosService: {
      numeros: vi.fn(async () => ({
        numeros: [
          { inboxId: 'i1', nome: 'Comercial', telefone: '5534988119078', conectado: true, status: 'pronto', dia: null, limiteDiario: 200, restantesHoje: 180, agenteNome: 'Sofia' },
          { inboxId: 'i2', nome: 'Suporte', telefone: '5534991234567', conectado: true, status: 'aquecendo', dia: 7, limiteDiario: 15, restantesHoje: 15, agenteNome: null },
          { inboxId: 'i3', nome: 'Velho', telefone: null, conectado: false, status: 'nao_aquecido', dia: null, limiteDiario: 50, restantesHoje: 50, agenteNome: null },
        ],
        optouts: 12,
      })),
      previewLista: vi.fn(async () => ({ total: 120, vaoReceber: 108, optout: 7, duplicados: 3, invalidos: 2 })),
      variarComIA: vi.fn(),
      enviarAnexo: vi.fn(async () => ({ tipo: 'imagem', path: 'disparos/acc1/x.jpg', nome: 'horarios.jpg', mime: 'image/jpeg', tamanho: 640 * 1024 })),
      criar: vi.fn(async () => ({ id: 'd1' })),
      cancelar: vi.fn(),
    },
  };
});

import { NovoDisparoDialog } from './NovoDisparoDialog';
import { disparosService } from '@/services/disparos.backend.service';

function montar(props: Partial<React.ComponentProps<typeof NovoDisparoDialog>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NovoDisparoDialog open onOpenChange={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

describe('NovoDisparoDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  it('com público pré-selecionado, o preview vai com {tipo:publico} e mostra os chips', async () => {
    montar({ publicoInicial: 'pub1' });
    await waitFor(() => expect(disparosService.previewLista).toHaveBeenCalledWith({ tipo: 'publico', audienceId: 'pub1' }), { timeout: 2000 });
    expect(await screen.findByText(/vão receber/)).toBeInTheDocument();
    expect(screen.getByText(/pediram para sair · pulados/)).toBeInTheDocument();
    expect(screen.getByText(/repetidos · removidos/)).toBeInTheDocument();
    expect(screen.getByText(/sem telefone válido/)).toBeInTheDocument();
  });

  it('leads do CRM: marcar uma tag chama o preview com {tipo:leads, tagIds}', async () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Leads do CRM' }));
    fireEvent.click(await screen.findByRole('button', { name: 'consulta amanhã' }));
    await waitFor(() => expect(disparosService.previewLista).toHaveBeenCalledWith({ tipo: 'leads', tagIds: ['tag1'] }), { timeout: 2000 });
  });

  it('colar números: manda as linhas e a quantidade', async () => {
    montar();
    fireEvent.click(screen.getByRole('button', { name: 'Colar números' }));
    fireEvent.change(screen.getByLabelText('Números'), { target: { value: 'Maria;34988119078\n34991234567' } });
    await waitFor(() =>
      expect(disparosService.previewLista).toHaveBeenCalledWith({ tipo: 'numeros', quantidade: 2, linhas: ['Maria;34988119078', '34991234567'] }),
    { timeout: 2000 });
  });

  it('o chip de variável entra no texto e a prévia usa o primeiro nome', async () => {
    montar({ publicoInicial: 'pub1' });
    const caixa = screen.getByLabelText('Texto') as HTMLTextAreaElement;
    fireEvent.change(caixa, { target: { value: 'Oi , tudo bem?' } });
    caixa.setSelectionRange(3, 3);
    fireEvent.click(screen.getByRole('button', { name: '{{primeiro_nome}}' }));
    expect(caixa.value).toBe('Oi {{primeiro_nome}}, tudo bem?');
    expect(screen.getByTestId('previa-whatsapp')).toHaveTextContent('Oi Maria, tudo bem?');
  });

  it('anexo sobe, aparece na lista e some ao remover', async () => {
    montar();
    const arquivo = new File(['x'], 'horarios.jpg', { type: 'image/jpeg' });
    fireEvent.click(screen.getByRole('button', { name: /Imagem/ }));
    fireEvent.change(screen.getByTestId('disparo-arquivo'), { target: { files: [arquivo] } });
    expect(await screen.findByText(/horarios.jpg/, { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/vai como 2ª mensagem/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remover anexo' }));
    expect(screen.queryByText(/vai como 2ª mensagem/)).not.toBeInTheDocument();
  });

  it('número desconectado fica desabilitado e o recomendado vem marcado', async () => {
    montar({ publicoInicial: 'pub1' });
    const velho = await screen.findByRole('checkbox', { name: 'Velho' });
    expect(velho).toBeDisabled();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Comercial' })).toBeChecked());
    expect(screen.getByText('recomendado')).toBeInTheDocument();
    expect(screen.getByText(/180 de 200 restantes hoje/)).toBeInTheDocument();
  });

  it('manda o payload final com inboxIds, atendeRespostas e sem agendadoPara quando é agora', async () => {
    montar({ publicoInicial: 'pub1' });
    fireEvent.change(screen.getByLabelText('Texto'), { target: { value: 'Oi {{nome}}' } });
    // marca também o segundo número: pode mais de um
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Suporte' }));
    const botao = await screen.findByRole('button', { name: 'Disparar para 108 contatos' }, { timeout: 2000 });
    await waitFor(() => expect(botao).toBeEnabled());
    fireEvent.click(botao);
    await waitFor(() => expect(disparosService.criar).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(disparosService.criar).mock.calls[0][0];
    expect(payload).toMatchObject({
      texto: 'Oi {{nome}}',
      variantes: [],
      anexo: null,
      lista: { tipo: 'publico', audienceId: 'pub1' },
      inboxIds: ['i1', 'i2'],
      atendeRespostas: 'agente',
    });
    expect(payload.agendadoPara).toBeUndefined();
    expect(payload.nome).toContain('Pacientes sem retorno');
  });

  it('agendar: o botão vira "Agendar para" e agendadoPara segue em ISO', async () => {
    montar({ publicoInicial: 'pub1' });
    fireEvent.change(screen.getByLabelText('Texto'), { target: { value: 'Oi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agendar' }));
    fireEvent.change(screen.getByLabelText('Data e hora do envio'), { target: { value: '2999-10-08T09:00' } });
    const botao = await screen.findByRole('button', { name: /Agendar para 08\/10 09:00/ }, { timeout: 2000 });
    await waitFor(() => expect(botao).toBeEnabled());
    fireEvent.click(botao);
    await waitFor(() => expect(disparosService.criar).toHaveBeenCalled());
    // 09:00 em America/Sao_Paulo (UTC-3) = 12:00Z
    expect(vi.mocked(disparosService.criar).mock.calls[0][0].agendadoPara).toBe('2999-10-08T12:00:00.000Z');
  });
});
