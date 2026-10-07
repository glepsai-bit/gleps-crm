/**
 * Tela Disparos: faixa de números, cards por status com os botões certos,
 * concluídos com %, e ?publico= abrindo o diálogo já com o público.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1' }, account: { id: 'acc1' } }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/api/client', () => ({
  apiClient: { get: vi.fn(async () => [{ id: 'pub1', name: 'Pacientes sem retorno' }]) },
  tokenManager: { getToken: () => null },
}));
vi.mock('@/services/tags.backend.service', () => ({
  tagsBackendService: { listAllTags: vi.fn(async () => [{ id: 'etapa1', name: 'Em negociação', type: 'stage' }]) },
}));
vi.mock('@/services/whatsapp-consents.backend.service', () => ({
  whatsappConsentsBackendService: { listOptedOut: vi.fn(async () => []) },
}));
vi.mock('@/services/whatsapp-templates.backend.service', () => ({
  listTemplates: vi.fn(async () => [{ id: 't1', name: 'Reativação', content: 'Oi {{nome}}, tudo bem?', category: 'custom', createdAt: '' }]),
  createTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
}));
vi.mock('@/components/disparos/NovoDisparoDialog', () => ({
  NovoDisparoDialog: (p: { open: boolean; publicoInicial?: string | null; textoInicial?: string | null; editando?: { id: string } | null }) =>
    p.open ? <div data-testid="dialogo">publico={p.publicoInicial ?? ''}|texto={p.textoInicial ?? ''}|editando={p.editando?.id ?? ''}</div> : null,
}));
vi.mock('@/components/disparos/DetalheDisparoSheet', () => ({
  DetalheDisparoSheet: (p: { disparoId: string | null }) => (p.disparoId ? <div data-testid="detalhe">{p.disparoId}</div> : null),
}));

const base = {
  texto: 'Oi {{nome}}', variantes: [], anexo: null, atendeRespostas: 'agente', pausadoMotivo: null, agendadoPara: null,
  iniciadoEm: '2026-10-07T12:10:00.000Z', concluidoEm: null, previsaoTerminoEm: '2026-10-07T14:40:00.000Z',
  total: 108, enviadas: 44, falhas: 1, respondidas: 6, optout: 0, pulados: 0, createdAt: null, inboxIds: ['i1'],
  lista: { tipo: 'publico', audienceId: 'pub1' }, listaRotulo: null,
};

const listar = vi.fn();
const pausar = vi.fn();
const retomar = vi.fn();
const cancelar = vi.fn();
const reenviar = vi.fn();
vi.mock('@/services/disparos.backend.service', async (orig) => {
  const real = await orig<typeof import('@/services/disparos.backend.service')>();
  return {
    ...real,
    disparosService: {
      listar: (...a: unknown[]) => listar(...a),
      numeros: vi.fn(async () => ({
        numeros: [
          { inboxId: 'i1', nome: 'Comercial', telefone: null, conectado: true, status: 'pronto', dia: null, limiteDiario: 200, restantesHoje: 180, agenteNome: null },
          { inboxId: 'i2', nome: 'Suporte', telefone: null, conectado: true, status: 'aquecendo', dia: 7, limiteDiario: 15, restantesHoje: 15, agenteNome: null },
        ],
        optouts: 12,
      })),
      pausar: (...a: unknown[]) => pausar(...a),
      retomar: (...a: unknown[]) => retomar(...a),
      cancelar: (...a: unknown[]) => cancelar(...a),
      reenviarNaoRespondidos: (...a: unknown[]) => reenviar(...a),
    },
  };
});

import AdminDisparosPage from './AdminDisparosPage';

function montar(url = '/admin/disparos') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}><AdminDisparosPage /></MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('AdminDisparosPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listar.mockResolvedValue({
      emAndamento: [
        { ...base, id: 'd1', nome: 'Reativação de outubro', status: 'enviando' },
        { ...base, id: 'd2', nome: 'Promoção de avaliação', status: 'agendado', agendadoPara: '2026-10-08T12:00:00.000Z', enviadas: 0, falhas: 0, respondidas: 0 },
        { ...base, id: 'd3', nome: 'Confirmações', status: 'pausado', pausadoMotivo: '5 falhas seguidas no número Comercial' },
      ],
      concluidos: [
        { ...base, id: 'd4', nome: 'Lembrete de reavaliação', status: 'concluido', total: 64, enviadas: 61, falhas: 2, respondidas: 9, concluidoEm: '2026-10-03T15:00:00.000Z' },
      ],
    });
  });

  it('mostra a faixa de números, o link de opt-outs e as regras', async () => {
    montar();
    expect(await screen.findByText('180', { selector: 'b' })).toBeInTheDocument();
    expect(screen.getByText('aquecendo · dia 7')).toBeInTheDocument();
    expect(await screen.findByText('12', { selector: 'b' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /pediram para sair/ })).toHaveAttribute('href', '/admin/opt-outs');
    expect(screen.getByText('O sistema cuida sozinho')).toBeInTheDocument();
  });

  it('cada status mostra os botões certos', async () => {
    montar();
    const enviando = await screen.findByRole('article', { name: 'Reativação de outubro' });
    expect(within(enviando).getByRole('button', { name: 'Pausar' })).toBeInTheDocument();
    expect(within(enviando).getByRole('button', { name: 'Cancelar' })).toBeInTheDocument();
    expect(within(enviando).queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
    expect(within(enviando).getByText('45 de 108')).toBeInTheDocument();

    const agendado = screen.getByRole('article', { name: 'Promoção de avaliação' });
    expect(within(agendado).getByRole('button', { name: 'Editar' })).toBeInTheDocument();
    expect(within(agendado).queryByRole('button', { name: 'Pausar' })).not.toBeInTheDocument();
    expect(within(agendado).getByText(/Agendado · /)).toBeInTheDocument();

    const pausado = screen.getByRole('article', { name: 'Confirmações' });
    expect(within(pausado).getByRole('button', { name: 'Retomar' })).toBeInTheDocument();
    expect(within(pausado).getByText('5 falhas seguidas no número Comercial')).toBeInTheDocument();
  });

  it('Pausar chama a rota; Cancelar pede confirmação citando o nome', async () => {
    pausar.mockResolvedValue(undefined);
    cancelar.mockResolvedValue(undefined);
    montar();
    const card = await screen.findByRole('article', { name: 'Reativação de outubro' });
    fireEvent.click(within(card).getByRole('button', { name: 'Pausar' }));
    await waitFor(() => expect(pausar).toHaveBeenCalledWith('d1'));

    fireEvent.click(within(card).getByRole('button', { name: 'Cancelar' }));
    expect(await screen.findByText('Cancelar "Reativação de outubro"?')).toBeInTheDocument();
    expect(cancelar).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar disparo' }));
    await waitFor(() => expect(cancelar).toHaveBeenCalledWith('d1'));
  });

  it('concluídos mostram % de respostas e reenviar chama a rota', async () => {
    reenviar.mockResolvedValue({ id: 'novo', nome: 'x · reenvio' });
    montar();
    const linha = (await screen.findByText('Lembrete de reavaliação')).closest('tr')!;
    expect(within(linha).getByText(/· 15%/)).toBeInTheDocument();
    fireEvent.click(within(linha).getByRole('button', { name: 'Reenviar a quem não respondeu' }));
    await waitFor(() => expect(reenviar).toHaveBeenCalledWith('d4'));
  });

  it('Editar abre o diálogo com o disparo agendado; Usar abre com o texto da mensagem salva', async () => {
    montar();
    fireEvent.click(within(await screen.findByRole('article', { name: 'Promoção de avaliação' })).getByRole('button', { name: 'Editar' }));
    expect(await screen.findByTestId('dialogo')).toHaveTextContent('editando=d2');
  });

  it('Usar uma mensagem salva abre o Novo disparo com o texto', async () => {
    montar();
    fireEvent.click(await screen.findByRole('button', { name: 'Usar Reativação' }));
    expect(await screen.findByTestId('dialogo')).toHaveTextContent('texto=Oi {{nome}}, tudo bem?');
  });

  it('?publico=<id> abre o diálogo já com o público', async () => {
    montar('/admin/disparos?publico=pub1');
    expect(await screen.findByTestId('dialogo')).toHaveTextContent('publico=pub1');
  });
});
