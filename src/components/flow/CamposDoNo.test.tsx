/**
 * CamposDoNo — os dois blocos que passaram a conversar com o resto do CRM.
 *
 * "Transferir para humano" ganhou time (é o que transforma uma rota
 * "financeiro" num departamento), e "Aplicar etapa" trocou o texto livre por
 * uma lista fechada com as etapas REAIS do funil — escrever "agendado" num
 * textarea parecia funcionar e o motor recusava em silêncio.
 *
 * O Select do Radix em jsdom precisa de três coisas que o jsdom não tem
 * (scrollIntoView, pointer capture e ResizeObserver); estão no topo.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CamposDoNo, type CamposDoNoProps } from './CamposDoNo';
import { tagsBackendService } from '@/services/tags.backend.service';
import { teamsBackendService, type TeamWithMembers } from '@/services/teams.backend.service';
import type { Tag } from '@/services/tags.cloud.service';

vi.mock('@/services/tags.backend.service', () => ({
  tagsBackendService: { listStageTags: vi.fn() },
}));

vi.mock('@/services/teams.backend.service', () => ({
  teamsBackendService: { listTeams: vi.fn() },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { account_id: 'acc1' }, account: null }),
}));

const etapasApi = vi.mocked(tagsBackendService);
const timesApi = vi.mocked(teamsBackendService);

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

function time(over: Partial<TeamWithMembers> = {}): TeamWithMembers {
  return {
    id: 't1',
    accountId: 'acc1',
    name: 'Financeiro',
    description: null,
    allowAutoAssign: true,
    sharedVisibility: true,
    businessHours: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    members: [],
    ...over,
  };
}

function renderCampos(props: Partial<CamposDoNoProps> & Pick<CamposDoNoProps, 'tipo'>) {
  const set = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <CamposDoNo config={{}} agentes={[]} set={set} {...props} />
    </QueryClientProvider>
  );
  return { ...utils, set };
}

/** Abre o Select pelo nome acessível do gatilho e devolve a opção pedida. */
async function abrirEEscolher(nomeDoSelect: string, opcao: string | RegExp) {
  fireEvent.click(screen.getByRole('combobox', { name: nomeDoSelect }));
  const item = await screen.findByRole('option', { name: opcao });
  fireEvent.click(item);
}

beforeEach(() => {
  vi.clearAllMocks();
  etapasApi.listStageTags.mockResolvedValue([
    etapa('novo-lead', 'Novo lead', 0),
    etapa('agendado', 'Agendado', 1),
  ]);
  timesApi.listTeams.mockResolvedValue([
    time({ id: 't1', name: 'Financeiro' }),
    time({ id: 't2', name: 'Suporte' }),
  ]);
});

describe('Transferir para humano — time', () => {
  it('sem time salvo, o padrão é "Qualquer atendente online"', async () => {
    renderCampos({ tipo: 'chat.assign_human' });
    const gatilho = screen.getByRole('combobox', { name: 'Time' });
    expect(gatilho.textContent).toContain('Qualquer atendente online');
    expect(await screen.findByText(/Sem time, sorteia entre todos/)).toBeInTheDocument();
  });

  it('escolher um time grava config.teamId', async () => {
    const { set } = renderCampos({ tipo: 'chat.assign_human' });
    // Espera a lista chegar antes de abrir — senão a opção não existe ainda.
    await screen.findByText(/Sem time, sorteia entre todos/);

    await abrirEEscolher('Time', 'Suporte');
    expect(set).toHaveBeenCalledWith('teamId', 't2');
  });

  it('voltar para "Qualquer atendente online" apaga o teamId', async () => {
    const { set } = renderCampos({ tipo: 'chat.assign_human', config: { teamId: 't1' } });
    await screen.findByText(/Sem time, sorteia entre todos/);
    expect(screen.getByRole('combobox', { name: 'Time' }).textContent).toContain('Financeiro');

    await abrirEEscolher('Time', 'Qualquer atendente online');
    expect(set).toHaveBeenCalledWith('teamId', undefined);
  });

  it('time salvo que não existe mais continua visível — sumir seria apagá-lo no próximo salvar', async () => {
    renderCampos({ tipo: 'chat.assign_human', config: { teamId: 'apagado' } });
    await screen.findByText(/Sem time, sorteia entre todos/);
    expect(screen.getByRole('combobox', { name: 'Time' }).textContent).toContain(
      'Time não encontrado'
    );
  });

  it('conta sem time explica onde criar', async () => {
    timesApi.listTeams.mockResolvedValue([]);
    renderCampos({ tipo: 'chat.assign_human' });
    expect(await screen.findByText(/A conta não tem time cadastrado/)).toBeInTheDocument();
  });
});

describe('Aplicar etapa — só do funil real', () => {
  it('lista as etapas da conta e a opção de usar a decisão do agente', async () => {
    renderCampos({ tipo: 'crm.apply_stage' });
    await screen.findByText(/As etapas vêm do seu funil do Kanban/);

    fireEvent.click(screen.getByRole('combobox', { name: 'Etapa' }));
    expect(
      await screen.findByRole('option', { name: 'Usar a etapa que o agente decidiu' })
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Novo lead' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Agendado' })).toBeInTheDocument();
    // Não existe mais campo de texto livre pra inventar etapa.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('escolher uma etapa grava o SLUG, que é o que o motor resolve', async () => {
    const { set } = renderCampos({ tipo: 'crm.apply_stage' });
    await screen.findByText(/As etapas vêm do seu funil do Kanban/);

    await abrirEEscolher('Etapa', 'Agendado');
    expect(set).toHaveBeenCalledWith('etapa', 'agendado');
  });

  it('"usar a etapa que o agente decidiu" grava o template {{agente.etapa}}', async () => {
    const { set } = renderCampos({ tipo: 'crm.apply_stage' });
    await screen.findByText(/As etapas vêm do seu funil do Kanban/);

    await abrirEEscolher('Etapa', 'Usar a etapa que o agente decidiu');
    expect(set).toHaveBeenCalledWith('etapa', '{{agente.etapa}}');
  });

  it('valor antigo fora do funil fica visível e é acusado', async () => {
    renderCampos({ tipo: 'crm.apply_stage', config: { etapa: 'qualificado' } });

    // A acusação só pode vir depois da lista: antes dela não se sabe se o
    // valor é estranho ou só ainda não carregou.
    expect(await screen.findByText(/não é uma etapa do funil/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Etapa' }).textContent).toContain(
      'Valor atual: qualificado'
    );
  });

  it('conta sem etapa avisa em destaque', async () => {
    etapasApi.listStageTags.mockResolvedValue([]);
    renderCampos({ tipo: 'crm.apply_stage' });
    expect(await screen.findByText(/Seu funil não tem etapa nenhuma/)).toBeInTheDocument();
  });
});

describe('o que não mudou', () => {
  it('"Responder" continua com o texto livre', () => {
    renderCampos({ tipo: 'chat.reply', config: { texto: 'Olá {{agente.nome}}' } });
    expect(screen.getByRole('textbox')).toHaveValue('Olá {{agente.nome}}');
  });

  /*
    O gatilho deixou de ser "não tem o que configurar": agrupar e transcrever
    saíram do canvas e vieram pra cá, que é onde a espera e a transcrição
    realmente acontecem — antes do fluxo começar.
  */
  it('o gatilho carrega a janela de agrupamento e o áudio', () => {
    renderCampos({ tipo: 'trigger.message_received' });
    expect(screen.getByLabelText(/juntar mensagens seguidas/i)).toHaveValue(15);
    expect(screen.getByLabelText(/entender áudio do lead/i)).toBeChecked();
    expect(screen.getByText(/dispara sempre que o lead escrever/i)).toBeInTheDocument();
  });

  it('desligar o áudio avisa que o atendimento fica mudo', () => {
    renderCampos({ tipo: 'trigger.message_received', config: { transcreverAudio: false } });
    expect(screen.getByText(/para sem responder/i)).toBeInTheDocument();
  });

  it('a janela digitada vai pra configuração do gatilho', () => {
    const { set } = renderCampos({ tipo: 'trigger.message_received' });
    fireEvent.change(screen.getByLabelText(/juntar mensagens seguidas/i), {
      target: { value: '6' },
    });
    expect(set).toHaveBeenCalledWith('agruparSegundos', 6);
  });
});
