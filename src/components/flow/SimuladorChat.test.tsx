/**
 * O simulador fiel — a janela de agrupamento não é mais pulada.
 *
 * O defeito: o simulador respondia mensagem por mensagem enquanto o lead, em
 * produção, recebia UMA resposta pras três que mandou seguidas. Quem testava
 * nunca via o atendimento como o cliente vê. Estes testes fixam o contrato:
 * com janela, a tela conta o tempo a partir do horário que o servidor marcou,
 * deixa mandar mais mensagens (que entram na mesma resposta) e só mostra a
 * resposta quando o run termina no worker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  FlowPreview,
  FlowPreviewBuffering,
  FlowPreviewRunAtual,
} from '@/services/flows.backend.service';

const preview = vi.fn<(flowId: string, input: unknown) => Promise<FlowPreview | FlowPreviewBuffering>>();
const previewRunAtual = vi.fn<(id: string) => Promise<FlowPreviewRunAtual | null>>();
const resetPreview = vi.fn(async () => undefined);

vi.mock('@/services/flows.backend.service', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/services/flows.backend.service')>();
  return {
    ...real,
    flowsService: {
      ...real.flowsService,
      preview: (...a: [string, unknown]) => preview(...a),
      previewRunAtual: (id: string) => previewRunAtual(id),
      resetPreview: () => resetPreview(),
    },
  };
});

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { SimuladorChat } from './SimuladorChat';

const turnoPronto = (extra: Partial<FlowPreview> = {}): FlowPreview => ({
  conversationId: 'c1',
  runId: 'r1',
  resposta: 'Olá! Como posso ajudar?',
  status: 'done',
  stopReason: null,
  error: null,
  steps: [],
  memoria: {},
  sessao: {},
  ...extra,
});

const agrupando = (segundos: number, runId = 'r1'): FlowPreviewBuffering => ({
  conversationId: 'c1',
  runId,
  status: 'buffering',
  runAfter: new Date(Date.now() + segundos * 1000).toISOString(),
  segundos,
});

const runAtual = (extra: Partial<FlowPreviewRunAtual>): FlowPreviewRunAtual => ({
  runId: 'r1',
  status: 'buffering',
  runAfter: null,
  steps: [],
  resposta: null,
  stopReason: null,
  error: null,
  memoria: {},
  sessao: {},
  ...extra,
});

function montar(props: Partial<React.ComponentProps<typeof SimuladorChat>> = {}) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const onPassos = vi.fn();
  const onTurno = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <SimuladorChat flowId="f1" onPassos={onPassos} onTurno={onTurno} {...props} />
    </QueryClientProvider>
  );
  return { onPassos, onTurno };
}

async function mandar(texto: string) {
  const campo = screen.getByPlaceholderText(/mensagem do lead|mande mais uma/i);
  fireEvent.change(campo, { target: { value: texto } });
  fireEvent.keyDown(campo, { key: 'Enter' });
  // Resolve a promessa do preview e o render que ela dispara.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function passar(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  // O jsdom não rola a tela; o componente rola até a última fala a cada render.
  Element.prototype.scrollIntoView = vi.fn();
  vi.useFakeTimers();
  preview.mockReset();
  previewRunAtual.mockReset();
  previewRunAtual.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('estado vazio', () => {
  it('avisa que a espera é real aqui — igual ao atendimento', () => {
    montar();
    expect(screen.getByText(/a espera é real aqui/i)).toBeInTheDocument();
  });
});

describe('sem janela de agrupamento', () => {
  it('responde na hora, como antes', async () => {
    preview.mockResolvedValue(turnoPronto());
    const { onTurno } = montar();

    await mandar('oi');

    expect(screen.getByText('Olá! Como posso ajudar?')).toBeInTheDocument();
    expect(onTurno).toHaveBeenCalledWith(expect.objectContaining({ resposta: 'Olá! Como posso ajudar?' }));
    expect(screen.queryByText(/agrupando mensagens/i)).not.toBeInTheDocument();
  });
});

describe('com janela de agrupamento — a espera é real', () => {
  it('NÃO responde na hora: conta a partir do runAfter e o bloco de agrupar acende como aguardando', async () => {
    preview.mockResolvedValue(agrupando(15));
    previewRunAtual.mockResolvedValue(runAtual({ status: 'buffering' }));
    const { onPassos, onTurno } = montar({ noDeAgrupamento: 'debounce-1' });

    await mandar('oi');

    expect(screen.getByText(/agrupando mensagens… responde em 15s/i)).toBeInTheDocument();
    expect(onTurno).not.toHaveBeenCalled();
    expect(onPassos).toHaveBeenLastCalledWith({
      'debounce-1': { status: 'waiting', ms: 0, error: null },
    });

    // A contagem é derivada do horário, não de um cronômetro próprio.
    await passar(5_000);
    expect(screen.getByText(/responde em 10s/i)).toBeInTheDocument();

    // O campo continua aberto: mandar outra mensagem é o que o lead faz.
    expect(screen.getByPlaceholderText(/mande mais uma/i)).not.toBeDisabled();
  });

  it('mensagem durante a janela é enviada normalmente e a contagem reinicia com o novo runAfter', async () => {
    preview.mockResolvedValueOnce(agrupando(15));
    previewRunAtual.mockResolvedValue(runAtual({ status: 'buffering' }));
    const { onPassos } = montar({ noDeAgrupamento: 'debounce-1' });

    await mandar('oi');
    await passar(9_000);
    expect(screen.getByText(/responde em 6s/i)).toBeInTheDocument();

    // O servidor anexa ao mesmo run e empurra a janela pra 15s de novo.
    preview.mockResolvedValueOnce(agrupando(15));
    const chamadasAntes = onPassos.mock.calls.length;
    await mandar('esqueci de dizer, é pra amanhã');

    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview).toHaveBeenLastCalledWith('f1', {
      message: 'esqueci de dizer, é pra amanhã',
      conversationId: 'c1',
    });
    expect(screen.getByText(/responde em 15s/i)).toBeInTheDocument();
    // As duas falas do lead ficam na conversa; nenhuma resposta ainda.
    expect(screen.getByText('oi')).toBeInTheDocument();
    expect(screen.getByText('esqueci de dizer, é pra amanhã')).toBeInTheDocument();
    // Não zerou os blocos: a janela continua a mesma, só mais longa.
    expect(onPassos.mock.calls.length).toBe(chamadasAntes);
  });

  it('quando o run termina no worker, a resposta chega pelo poll — uma vez só', async () => {
    preview.mockResolvedValue(agrupando(3));
    previewRunAtual.mockResolvedValue(runAtual({ status: 'buffering' }));
    const { onPassos, onTurno } = montar({ noDeAgrupamento: 'debounce-1' });

    await mandar('oi');
    await passar(3_000);
    expect(screen.getByText(/janela fechou/i)).toBeInTheDocument();

    // O worker pegou o run: os passos vão acendendo.
    previewRunAtual.mockResolvedValue(
      runAtual({
        status: 'running',
        steps: [
          {
            id: 's1',
            nodeId: 'debounce-1',
            nodeType: 'buffer.debounce',
            status: 'ok',
            input: null,
            output: { janelaSegundos: 3, mensagensAgrupadas: 1 },
            ms: 2,
            error: null,
            ordem: 0,
            createdAt: '',
          },
        ],
      })
    );
    await passar(700);
    expect(screen.getByText(/rodando o fluxo/i)).toBeInTheDocument();
    expect(onPassos).toHaveBeenLastCalledWith({
      'debounce-1': { status: 'ok', ms: 2, error: null, puladoNoSimulador: null },
    });
    // Executando: agora sim o campo trava.
    expect(screen.getByPlaceholderText(/mensagem do lead/i)).toBeDisabled();

    // Terminou.
    previewRunAtual.mockResolvedValue(
      runAtual({
        status: 'done',
        resposta: 'Perfeito, amanhã às 10h!',
        memoria: { nome: 'Ana' },
        steps: [
          {
            id: 's2',
            nodeId: 'aguardar-1',
            nodeType: 'flow.aguardar',
            status: 'ok',
            input: null,
            output: { pulado: 'simulador', duracao: '2 dias' },
            ms: 1,
            error: null,
            ordem: 1,
            createdAt: '',
          },
        ],
      })
    );
    await passar(700);
    expect(screen.getByText('Perfeito, amanhã às 10h!')).toBeInTheDocument();
    expect(onTurno).toHaveBeenCalledTimes(1);
    expect(onTurno).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'r1', resposta: 'Perfeito, amanhã às 10h!', memoria: { nome: 'Ana' } })
    );
    // A espera longa pulada chega ao bloco com a duração legível.
    expect(onPassos).toHaveBeenLastCalledWith({
      'aguardar-1': { status: 'ok', ms: 1, error: null, puladoNoSimulador: '2 dias' },
    });
    expect(screen.queryByText(/agrupando mensagens/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/mensagem do lead/i)).not.toBeDisabled();

    // O poll parou: o mesmo run terminado não vira segunda resposta.
    await passar(2_000);
    expect(onTurno).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Perfeito, amanhã às 10h!')).toHaveLength(1);
  });
});
