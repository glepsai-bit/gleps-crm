/**
 * AdminIaAgendaPage — a tela de regras que alimenta a seção Agenda do
 * agente (`PainelAgente.tsx`). Cobre o que o board pediu: profissionais e
 * serviços do mock aparecem na tela, e cada "Salvar" manda o PUT certo —
 * sem depender do backend estar de pé (ver `agenda.backend.service.ts`).
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AdminIaAgendaPage from './AdminIaAgendaPage';
import {
  agendaBackendService,
  type AgendaConfiguracaoResponse,
  type ProfissionalDaAgenda,
} from '@/services/agenda.backend.service';
import { calendarBackendService } from '@/services/calendar.backend.service';
import { tagsBackendService } from '@/services/tags.backend.service';
import type { Tag } from '@/services/tags.cloud.service';

vi.mock('@/services/agenda.backend.service', async (importOriginal) => {
  // DIAS_DA_SEMANA/DIAS_UTEIS são constantes puras (não fazem rede) — a
  // página as importa direto do módulo, então só o serviço é mockado.
  const real = await importOriginal<typeof import('@/services/agenda.backend.service')>();
  return {
    ...real,
    agendaBackendService: {
      getConfiguracao: vi.fn(),
      atualizarConfiguracao: vi.fn(),
      atualizarProfissional: vi.fn(),
      atualizarServico: vi.fn(),
      getHorarios: vi.fn(),
    },
  };
});

vi.mock('@/services/calendar.backend.service', () => ({
  calendarBackendService: { connectGoogle: vi.fn() },
}));

vi.mock('@/services/tags.backend.service', () => ({
  tagsBackendService: { listStageTags: vi.fn() },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', account_id: 'acc1' }, account: null }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const agendaApi = vi.mocked(agendaBackendService);
const calendarApi = vi.mocked(calendarBackendService);
const etapasApi = vi.mocked(tagsBackendService);

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

function profissional(over: Partial<ProfissionalDaAgenda> = {}): ProfissionalDaAgenda {
  return {
    userId: 'u1',
    nome: 'Dra. Marina',
    email: 'marina@clinica.com',
    ativo: true,
    horarios: { '1': [{ inicio: '09:00', fim: '18:00' }] },
    intervaloMinutos: 15,
    google: {
      conectado: true,
      email: 'marina@gmail.com',
      podeEscrever: true,
      precisaReconectar: false,
      motivo: null,
    },
    ...over,
  };
}

const CONFIG: AgendaConfiguracaoResponse = {
  configuracao: {
    antecedenciaMinimaMinutos: 120,
    janelaMaximaDias: 14,
    passoMinutos: 15,
    holdMinutos: 5,
    etapaAoAgendar: null,
  },
  profissionais: [
    profissional(),
    profissional({
      userId: 'u2',
      nome: 'Dr. Pedro',
      email: 'pedro@clinica.com',
      google: {
        conectado: true,
        email: 'pedro@gmail.com',
        podeEscrever: false,
        precisaReconectar: true,
        motivo: 'token expirado',
      },
    }),
  ],
  servicos: [
    { id: 'p1', nome: 'Botox terço superior', duracaoMinutos: 30, ativo: true },
    { id: 'p2', nome: 'Consultoria (sem duração)', duracaoMinutos: null, ativo: true },
  ],
};

function etapa(slug: string, name: string, ordem: number): Tag {
  return {
    id: `tag-${slug}`,
    account_id: 'acc1',
    funnel_id: 'f1',
    name,
    slug,
    type: 'stage',
    color: '#000',
    ordem,
    ativo: true,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function renderPagina() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AdminIaAgendaPage />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  agendaApi.getConfiguracao.mockResolvedValue(CONFIG);
  agendaApi.atualizarProfissional.mockImplementation((userId, input) =>
    Promise.resolve({ ...CONFIG.profissionais.find((p) => p.userId === userId)!, ...input } as ProfissionalDaAgenda)
  );
  agendaApi.atualizarServico.mockImplementation((id, duracaoMinutos) =>
    Promise.resolve({ ...CONFIG.servicos.find((s) => s.id === id)!, duracaoMinutos })
  );
  agendaApi.atualizarConfiguracao.mockImplementation((input) =>
    Promise.resolve({ ...CONFIG.configuracao, ...input })
  );
  etapasApi.listStageTags.mockResolvedValue([etapa('novo-lead', 'Novo lead', 0), etapa('agendado', 'Agendado', 1)]);
  calendarApi.connectGoogle.mockResolvedValue({ authUrl: 'https://accounts.google.com/auth' });
});

describe('profissionais', () => {
  it('lista os profissionais e serviços que vieram da configuração', async () => {
    renderPagina();

    expect(await screen.findByText('Dra. Marina')).toBeInTheDocument();
    expect(screen.getByText('Dr. Pedro')).toBeInTheDocument();
    expect(screen.getByText('Botox terço superior')).toBeInTheDocument();
    expect(screen.getByText('Consultoria (sem duração)')).toBeInTheDocument();
  });

  it('salvar um profissional envia PUT com ativo, intervalo e horários', async () => {
    renderPagina();
    await screen.findByText('Dra. Marina');

    const cardMarina = screen.getByText('Dra. Marina').closest('.bg-card') as HTMLElement;
    const dentro = within(cardMarina);

    fireEvent.change(dentro.getByLabelText('Intervalo entre atendimentos (min)'), {
      target: { value: '20' },
    });
    fireEvent.click(dentro.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(agendaApi.atualizarProfissional).toHaveBeenCalled());
    expect(agendaApi.atualizarProfissional).toHaveBeenCalledWith('u1', {
      ativo: true,
      intervaloMinutos: 20,
      horarios: { '1': [{ inicio: '09:00', fim: '18:00' }] },
    });
  });

  it('badge de quem precisa reconectar, e o botão só aparece pro próprio usuário logado', async () => {
    renderPagina();
    await screen.findByText('Dr. Pedro');

    expect(screen.getByText('precisa reconectar')).toBeInTheDocument();
    // u2 (Dr. Pedro) não é o usuário logado (u1) — sem botão, só o pedido.
    expect(screen.getByText(/peça para Dr\. Pedro reconectar em Agenda/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconectar' })).toBeNull();
  });

  it('reconectar (quando é o próprio usuário) chama connectGoogle', async () => {
    agendaApi.getConfiguracao.mockResolvedValue({
      ...CONFIG,
      profissionais: [
        profissional({
          google: { conectado: true, email: 'marina@gmail.com', podeEscrever: false, precisaReconectar: true, motivo: 'x' },
        }),
      ],
    });
    renderPagina();
    await screen.findByText('Dra. Marina');

    fireEvent.click(screen.getByRole('button', { name: 'Reconectar' }));
    await waitFor(() => expect(calendarApi.connectGoogle).toHaveBeenCalled());
  });

  it('desligar "atende com hora marcada" esconde o editor de horários', async () => {
    renderPagina();
    await screen.findByText('Dra. Marina');

    const cardMarina = screen.getByText('Dra. Marina').closest('.bg-card') as HTMLElement;
    const dentro = within(cardMarina);
    expect(dentro.getByText('Horários de atendimento')).toBeInTheDocument();

    fireEvent.click(dentro.getByRole('switch', { name: /Dra\. Marina atende com hora marcada/ }));
    expect(dentro.queryByText('Horários de atendimento')).toBeNull();
  });
});

describe('serviços', () => {
  it('editar a duração e sair do campo envia PUT com o número certo', async () => {
    renderPagina();
    await screen.findByText('Botox terço superior');

    const campo = screen.getByLabelText('Duração de Botox terço superior');
    fireEvent.change(campo, { target: { value: '45' } });
    fireEvent.blur(campo);

    await waitFor(() => expect(agendaApi.atualizarServico).toHaveBeenCalledWith('p1', 45));
  });

  it('duração vazia envia null — o serviço vira "só venda"', async () => {
    renderPagina();
    await screen.findByText('Botox terço superior');

    const campo = screen.getByLabelText('Duração de Botox terço superior');
    fireEvent.change(campo, { target: { value: '' } });
    fireEvent.blur(campo);

    await waitFor(() => expect(agendaApi.atualizarServico).toHaveBeenCalledWith('p1', null));
  });
});

describe('regras da conta', () => {
  it('salvar envia o PUT com os quatro números da conta', async () => {
    renderPagina();
    await screen.findByText('Regras da conta');

    fireEvent.change(screen.getByLabelText('Antecedência mínima (min)'), { target: { value: '60' } });

    const cardRegras = screen.getByText('Regras da conta').closest('.bg-card') as HTMLElement;
    fireEvent.click(within(cardRegras).getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(agendaApi.atualizarConfiguracao).toHaveBeenCalled());
    const payload = agendaApi.atualizarConfiguracao.mock.calls.at(-1)?.[0];
    expect(payload).toEqual({
      antecedenciaMinimaMinutos: 60,
      janelaMaximaDias: 14,
      passoMinutos: 15,
      holdMinutos: 5,
      etapaAoAgendar: null,
    });
  });
});

describe('estado de carregamento e erro', () => {
  it('erro ao carregar mostra aviso em vez de travar a tela', async () => {
    agendaApi.getConfiguracao.mockRejectedValue(new Error('rede fora'));
    renderPagina();
    expect(await screen.findByText(/Não consegui carregar a agenda/)).toBeInTheDocument();
  });
});
