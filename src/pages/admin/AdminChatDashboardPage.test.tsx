/**
 * Dashboard de atendimento — layout novo.
 *  - KPIs com dados; variação vs. período anterior (melhora/piora, tempos invertidos);
 *  - sem `anterior` / `fechamento` / `reunioes` a tela não quebra;
 *  - faixa Agora: chip só com esperando > 0;
 *  - seletor de período refaz a consulta com outra janela.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatMetricsResult, LiveAttendanceResult } from '@/services/chat-metrics.backend.service';

// jsdom não tem ResizeObserver (recharts ResponsiveContainer precisa).
class ResizeObserverFalso {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverFalso);

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', account_id: 'acc1' }, account: { id: 'acc1' } }),
}));
vi.mock('@/services/socket.client', () => ({
  chatSocket: { onConversationUpdated: () => () => {} },
}));
vi.mock('@/services/inboxes.backend.service', () => ({
  inboxesBackendService: { listInboxes: vi.fn().mockResolvedValue([{ id: 'i1', name: 'WhatsApp Comercial' }]) },
}));
vi.mock('@/services/teams.backend.service', () => ({
  teamsBackendService: { listTeams: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/services/users.backend.service', () => ({
  usersBackendService: { list: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/services/conversations.backend.service', () => ({
  conversationsBackendService: { listConversations: vi.fn().mockResolvedValue({ data: [], total: 0 }) },
}));

const getChatMetrics = vi.fn();
const getLiveAttendance = vi.fn();
vi.mock('@/services/chat-metrics.backend.service', () => ({
  chatMetricsBackendService: {
    getChatMetrics: (...a: unknown[]) => getChatMetrics(...a),
    getLiveAttendance: (...a: unknown[]) => getLiveAttendance(...a),
    getReturningLeadsCount: vi.fn().mockResolvedValue({ count: 6, leadIds: [] }),
    getReturningLeadsList: vi.fn().mockResolvedValue({ data: [], total: 0 }),
  },
}));

import AdminChatDashboardPage from './AdminChatDashboardPage';

const base: ChatMetricsResult = {
  totalConversations: 128,
  openConversations: 31,
  resolvedConversations: 97,
  avgFirstResponseMin: 2,
  avgResolutionMin: 72,
  resolvedByAi: 71,
  resolvedByHuman: 26,
  slaBreaches: 0,
  byAgent: [
    { agentId: 'a1', agentName: 'Ana Paula', total: 14, resolved: 12, open: 2, avgFirstResponseMin: 6, avgResolutionMin: 125, slaBreaches: 0 },
  ],
  byTeam: [],
  byInbox: [{ inboxId: 'i1', inboxName: 'WhatsApp Comercial', total: 71, resolved: 50, open: 21, slaBreaches: 0 }],
  dailyVolume: [{ date: '2026-10-05', total: 5, resolved: 3, open: 2 }],
};

const completo: ChatMetricsResult = {
  ...base,
  anterior: {
    totalConversations: 100,
    resolvedConversations: 110,
    avgFirstResponseMin: 2.63, // ficou 38 s mais rápido
    avgResolutionMin: 68, // ficou 4 min mais lento
    reunioes: 20,
  },
  reunioes: { total: 23, peloAgente: 19, porDia: [{ date: '2026-10-05', total: 2 }] },
  transferidasParaHumano: { total: 31, pct: 24 },
  origem: { anuncio: 51, organico: 33 },
  fechamento: {
    conversoes: 11, novosContatos: 84, taxaConversao: 13.9, receita: 8450, vendasComValor: 9, perdas: 7,
    atendidos: 79, comReuniao: 23, ticketMedio: 939, semValor: 2,
  },
};

const ao_vivo = (esperandoHaMais5Min?: number): LiveAttendanceResult => ({
  ia: { count: 9, conversationIds: [] },
  humano: { count: 3, conversationIds: [] },
  emAberto: { count: 2, conversationIds: [] },
  total: 14,
  esperandoHaMais5Min,
});

function montar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AdminChatDashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function cartao(label: string): HTMLElement {
  const el = screen.getByText(label, { selector: 'div' });
  return el.parentElement as HTMLElement;
}

beforeEach(() => {
  getChatMetrics.mockReset();
  getLiveAttendance.mockReset();
  getLiveAttendance.mockResolvedValue(ao_vivo(0));
});

describe('AdminChatDashboardPage', () => {
  it('renderiza os indicadores com dados e o cabeçalho', async () => {
    getChatMetrics.mockResolvedValue(completo);
    montar();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    await waitFor(() => expect(within(cartao('Conversas')).getByText('128')).toBeInTheDocument());
    expect(within(cartao('Resolvidas')).getByText('97')).toBeInTheDocument();
    expect(within(cartao('Reuniões marcadas')).getByText('23')).toBeInTheDocument();
    expect(within(cartao('Reuniões marcadas')).getByText(/pelo agente de IA/)).toBeInTheDocument();
    await waitFor(() => expect(within(cartao('Leads que voltaram')).getByText('6')).toBeInTheDocument());
    expect(screen.getByText(/Últimos 30 dias/)).toBeInTheDocument();
    expect(screen.queryByText('SLA')).not.toBeInTheDocument();
  });

  it('sinaliza variação: contagem sobe = melhora; tempo menor = mais rápido; maior = mais lento', async () => {
    getChatMetrics.mockResolvedValue(completo);
    montar();
    const conv = await waitFor(() => {
      const c = cartao('Conversas');
      expect(within(c).getByText('+28%')).toBeInTheDocument();
      return c;
    });
    expect(within(conv).getByText('+28%')).toHaveClass('text-success');
    expect(within(conv).getByText(/vs\. 30 dias antes/)).toBeInTheDocument();

    // Resolvidas caiu 97 vs 110 = -12% => piora (âmbar)
    expect(within(cartao('Resolvidas')).getByText('−12%')).toHaveClass('text-warning');

    const primeira = cartao('1ª resposta');
    expect(within(primeira).getByText('−38 s')).toHaveClass('text-success');
    expect(within(primeira).getByText('mais rápido')).toBeInTheDocument();

    const resolucao = cartao('Resolução');
    expect(within(resolucao).getByText('+4 min')).toHaveClass('text-warning');
    expect(within(resolucao).getByText('mais lento')).toBeInTheDocument();
  });

  it('mostra o funil, a origem e as transferidas quando vêm do backend', async () => {
    getChatMetrics.mockResolvedValue(completo);
    montar();
    await screen.findByText('Do primeiro contato ao fechamento');
    expect(screen.getByText('R$ 8.450')).toBeInTheDocument();
    expect(screen.getByText(/2 sem valor informado/)).toBeInTheDocument();
    expect(screen.getByText('R$ 939')).toBeInTheDocument();
    expect(screen.getByText(/Transferidas para humano/)).toBeInTheDocument();
    expect(screen.getByText(/anúncios Meta/)).toBeInTheDocument();
    expect(screen.getByTestId('linha-ia')).toBeInTheDocument();
  });

  it('não quebra sem anterior / fechamento / reunioes (deploy antigo)', async () => {
    getChatMetrics.mockResolvedValue(base);
    montar();
    await waitFor(() => expect(within(cartao('Conversas')).getByText('128')).toBeInTheDocument());
    // sem variação: cai no subtítulo
    expect(within(cartao('Resolvidas')).getByText(/das conversas/)).toBeInTheDocument();
    expect(within(cartao('Reuniões marcadas')).getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Do primeiro contato ao fechamento')).not.toBeInTheDocument();
    expect(screen.queryByText(/Transferidas para humano/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Origem dos contatos novos/)).not.toBeInTheDocument();
  });

  it('faixa Agora: chip de espera só aparece com esperandoHaMais5Min > 0', async () => {
    getChatMetrics.mockResolvedValue(base);
    getLiveAttendance.mockResolvedValue(ao_vivo(0));
    const { unmount } = montar();
    await screen.findByText('conversas em aberto');
    expect(screen.queryByText(/esperando há mais de 5 min/)).not.toBeInTheDocument();
    unmount();

    getLiveAttendance.mockResolvedValue(ao_vivo(2));
    montar();
    expect(await screen.findByText(/2 esperando há mais de 5 min/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Abrir o Chat/ })).toHaveAttribute('href', '/admin/chat');
  });

  it('total 0: "Nenhuma conversa em aberto agora" e sem barra', async () => {
    getChatMetrics.mockResolvedValue(base);
    getLiveAttendance.mockResolvedValue({
      ia: { count: 0, conversationIds: [] },
      humano: { count: 0, conversationIds: [] },
      emAberto: { count: 0, conversationIds: [] },
      total: 0,
    });
    montar();
    expect(await screen.findByText('Nenhuma conversa em aberto agora')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /IA \d+, humano/ })).not.toBeInTheDocument();
  });

  it('seletor de período refaz a consulta com outra janela', async () => {
    getChatMetrics.mockResolvedValue(base);
    montar();
    await waitFor(() => expect(getChatMetrics).toHaveBeenCalled());
    const dias = (f: { fromDate: string; toDate: string }) =>
      Math.round((new Date(f.toDate).getTime() - new Date(f.fromDate).getTime()) / 86_400_000);
    expect(dias(getChatMetrics.mock.calls[0][0])).toBe(31);

    const grupo = screen.getByRole('group', { name: 'Período' });
    expect(within(grupo).getByRole('button', { name: '30 dias' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(grupo).getByRole('button', { name: '7 dias' }));
    expect(within(grupo).getByRole('button', { name: '7 dias' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      const ultima = getChatMetrics.mock.calls.at(-1)![0];
      expect(dias(ultima)).toBe(8);
    });
  });

  it('clicar numa linha da equipe filtra por agente', async () => {
    getChatMetrics.mockResolvedValue(base);
    montar();
    const linha = (await screen.findByText('Ana Paula')).closest('tr') as HTMLElement;
    fireEvent.click(linha);
    await waitFor(() => expect(getChatMetrics.mock.calls.at(-1)![0].agentId).toBe('a1'));
  });
});
