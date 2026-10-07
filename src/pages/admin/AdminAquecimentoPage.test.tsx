/**
 * Tela do Aquecimento — estados da lista, diálogo, confirmação de remoção e aviso de infra.
 * O service é mockado: o contrato real vem do backend (etapa W).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminAquecimentoPage from './AdminAquecimentoPage';
import type { ListaAquecimento, NumeroAquecimento } from '@/services/aquecimento.backend.service';

const svc = vi.hoisted(() => ({
  listar: vi.fn(), inboxesDisponiveis: vi.fn(), adicionar: vi.fn(),
  pausar: vi.fn(), retomar: vi.fn(), remover: vi.fn(), historico: vi.fn(),
}));
vi.mock('@/services/aquecimento.backend.service', () => ({ aquecimentoBackendService: svc }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
// recharts não mede tamanho no jsdom; os gráficos não são o foco aqui
vi.mock('@/components/aquecimento/GraficoRampa', () => ({ GraficoRampa: () => <div /> }));
vi.mock('@/components/aquecimento/HistoricoSheet', () => ({ HistoricoSheet: () => null }));

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});

function numero(extra: Partial<NumeroAquecimento>): NumeroAquecimento {
  return {
    id: 'n1', inboxId: 'i1', inboxNome: 'Comercial', telefone: '5534988119078',
    status: 'aquecendo', dia: 7, modo: 'rampa',
    hoje: { planejadas: 15, enviadas: 12, recebidas: 11, disparos: 0 },
    saude: 'boa', falhasSeguidas: 0, pausadoMotivo: null, pausadoEm: null, prontoEm: null,
    limiteDiario: 30, restantesHoje: 3, ...extra,
  };
}

function lista(numeros: NumeroAquecimento[], infraPausaAte: string | null = null): ListaAquecimento {
  return {
    numeros,
    agora: {
      proximaRodadaEm: new Date(Date.now() + 4 * 60000).toISOString(),
      janela: { inicio: '08:00', fim: '20:00', fuso: 'São Paulo' },
      trocadasHoje: 27, falhasHoje: 0, infraPausaAte,
    },
  };
}

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><AdminAquecimentoPage /></QueryClientProvider>);
}

beforeEach(() => {
  Object.values(svc).forEach((f) => f.mockReset());
  svc.inboxesDisponiveis.mockResolvedValue([]);
  svc.historico.mockResolvedValue([]);
});

describe('AdminAquecimentoPage', () => {
  it('renderiza os estados: aquecendo, pronto, pausado e aguardando parceiro', async () => {
    svc.listar.mockResolvedValue(lista([
      numero({ id: 'a', inboxNome: 'Comercial' }),
      numero({ id: 'b', inboxNome: 'Vendas 2', status: 'pronto', dia: 30, modo: 'manutencao', limiteDiario: 200, restantesHoje: 180 }),
      numero({ id: 'c', inboxNome: 'Novo chip', status: 'pausado', saude: 'atencao', falhasSeguidas: 4, pausadoMotivo: 'número não existe no WhatsApp' }),
      numero({ id: 'd', inboxNome: 'Sozinho', status: 'aguardando_parceiro' }),
    ]));
    montar();
    expect(await screen.findByText('Vendas 2')).toBeInTheDocument();
    expect(screen.getByText('Pode disparar')).toBeInTheDocument();
    expect(screen.getByText('4 envios falharam seguidos')).toBeInTheDocument();
    expect(screen.getByText('Aguardando parceiro')).toBeInTheDocument();
    expect(screen.getByText('Precisa de outro número aquecendo')).toBeInTheDocument();
    expect(screen.getAllByText('+55 34 98811-9078').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Retomar' })).toBeInTheDocument();
  });

  it('vazio mostra o card "Nenhum número aquecendo"', async () => {
    svc.listar.mockResolvedValue(lista([]));
    montar();
    expect(await screen.findByText('Nenhum número aquecendo')).toBeInTheDocument();
  });

  it('aviso de infra só aparece com data futura', async () => {
    svc.listar.mockResolvedValue(lista([numero({})], new Date(Date.now() - 60000).toISOString()));
    montar();
    await screen.findByText('Comercial');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('aviso de infra aparece com data futura', async () => {
    svc.listar.mockResolvedValue(lista([numero({})], new Date(Date.now() + 10 * 60000).toISOString()));
    montar();
    expect(await screen.findByRole('status')).toHaveTextContent('não conta como falha');
  });

  it('o diálogo envia o inboxId escolhido', async () => {
    svc.listar.mockResolvedValue(lista([]));
    svc.inboxesDisponiveis.mockResolvedValue([
      { id: 'i9', nome: 'Vendas 3', telefone: '5511977770001' },
      { id: 'i8', nome: 'Financeiro', telefone: null, status: 'close' },
    ]);
    svc.adicionar.mockResolvedValue(numero({}));
    montar();
    await screen.findByText('Nenhum número aquecendo');
    fireEvent.click(screen.getAllByRole('button', { name: /Aquecer um número/ })[0]);
    const dlg = await screen.findByRole('dialog');
    const comeco = within(dlg).getByRole('button', { name: 'Começar a aquecer' });
    expect(comeco).toBeDisabled();
    expect(within(dlg).getByLabelText(/Financeiro/)).toBeDisabled();
    fireEvent.click(await within(dlg).findByLabelText(/Vendas 3/));
    fireEvent.click(comeco);
    await waitFor(() => expect(svc.adicionar).toHaveBeenCalledWith('i9'));
  });

  it('remover exige confirmação citando o nome', async () => {
    svc.listar.mockResolvedValue(lista([numero({ id: 'x', inboxNome: 'Comercial' })]));
    svc.remover.mockResolvedValue(undefined);
    montar();
    await screen.findByText('Comercial');
    fireEvent.click(screen.getByRole('button', { name: 'Tirar do aquecimento' }));
    const alerta = await screen.findByRole('alertdialog');
    expect(alerta).toHaveTextContent('Tirar Comercial do aquecimento?');
    expect(svc.remover).not.toHaveBeenCalled();
    fireEvent.click(within(alerta).getByRole('button', { name: 'Tirar do aquecimento' }));
    await waitFor(() => expect(svc.remover).toHaveBeenCalledWith('x'));
  });
});
