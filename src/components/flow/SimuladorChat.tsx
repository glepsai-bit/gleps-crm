/**
 * T-034 — o simulador dentro do canvas.
 *
 * Antes o simulador era uma tela separada: você testava lá, descobria que um
 * passo quebrou, voltava pro canvas, procurava o bloco, corrigia, voltava pra
 * testar. Quatro trocas de contexto por ajuste.
 *
 * Aqui a conversa fica ao lado do desenho, e os blocos ACENDEM conforme
 * executam — verde no que passou, vermelho onde quebrou. O erro deixa de ser
 * uma linha de log e vira um bloco iluminado na tela.
 *
 * A espera é REAL. Com "Agrupar mensagens" no desenho, o turno fica na janela
 * e a resposta só vem quando ela fecha — igual pro lead. Pular a janela aqui
 * era o que fazia a simulação responder mensagem por mensagem enquanto o
 * cliente, em produção, recebia uma resposta só pras três que mandou seguidas.
 * Quem quer testar com fidelidade precisa sentir o mesmo ritmo.
 *
 * Um componente só, usado pela aba do fluxo e pela página autônoma: se cada uma
 * tivesse a sua cópia, elas divergiriam no primeiro ajuste.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Send,
  RotateCcw,
  Bot,
  User,
  Loader2,
  AlertTriangle,
  MessageSquareDashed,
  Timer,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  flowsService,
  ehTurnoAgrupando,
  RUN_STATUS_TERMINAL,
  type FlowPreview,
  type FlowPreviewRunAtual,
  type FlowRunStep,
} from '@/services/flows.backend.service';

export interface Fala {
  autor: 'lead' | 'ia';
  texto: string;
  turno?: FlowPreview;
}

/** Como um passo se saiu no último teste — o que o canvas pinta no bloco. */
export interface ExecDoNo {
  status: string;
  ms: number;
  error: string | null;
  /**
   * Espera pulada no simulador, no texto legível que o motor devolve ("2 dias").
   * O bloco mostra "pulado no simulador (2 dias)" em vez de um verde mudo que
   * faria parecer que o fluxo esperou de verdade.
   */
  puladoNoSimulador?: string | null;
}

/** Estado de execução de cada nó, para o canvas pintar. */
export type StatusPorNo = Record<string, ExecDoNo>;

/**
 * Status que só existe na tela: o run ainda nem começou, está na janela de
 * agrupamento. O bloco "Agrupar mensagens" acende assim durante a contagem.
 */
export const STATUS_AGUARDANDO = 'waiting';

/** Enquanto o turno roda, os passos são lidos neste intervalo. */
const INTERVALO_POLL_MS = 600;
/** Cadência da contagem regressiva. Mais lento que isso e o "s" pula visível. */
const INTERVALO_RELOGIO_MS = 250;

/** A janela de agrupamento em andamento. */
interface Janela {
  runId: string;
  /** Quando fecha, no relógio do CLIENTE (ms). Derivado do `runAfter` do servidor. */
  fechaEm: number;
  segundos: number;
}

interface Props {
  flowId: string;
  /** Passos do turno atual, conforme chegam. O canvas usa pra acender os nós. */
  onPassos?: (porNo: StatusPorNo) => void;
  /** Turno concluído — o painel lateral mostra memórias e tempos. */
  onTurno?: (turno: FlowPreview) => void;
  /**
   * O bloco "Agrupar mensagens" do desenho SALVO. Durante a janela ele acende
   * como "aguardando" — é o que mostra onde o fluxo está parado.
   */
  noDeAgrupamento?: string | null;
  compacto?: boolean;
}

/** Lê dos passos o que o bloco precisa mostrar. */
function execDoPasso(s: FlowRunStep): ExecDoNo {
  const saida = (s.output ?? {}) as { pulado?: unknown; duracao?: unknown };
  const pulado = saida.pulado === 'simulador';
  return {
    status: s.status,
    ms: s.ms,
    error: s.error,
    puladoNoSimulador: pulado ? (typeof saida.duracao === 'string' ? saida.duracao : '') : null,
  };
}

/** O run lido pelo poll, no formato que a tela já entende como turno. */
function turnoDoRun(conversationId: string, r: FlowPreviewRunAtual): FlowPreview {
  return {
    conversationId,
    runId: r.runId,
    resposta: r.resposta,
    status: r.status,
    stopReason: r.stopReason,
    error: r.error,
    steps: r.steps,
    memoria: r.memoria,
    sessao: r.sessao,
  };
}

export function SimuladorChat({
  flowId,
  onPassos,
  onTurno,
  noDeAgrupamento = null,
  compacto = false,
}: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [falas, setFalas] = useState<Fala[]>([]);
  const [rascunho, setRascunho] = useState('');
  const [janela, setJanela] = useState<Janela | null>(null);
  /** O worker pegou o run e está executando — entre a janela fechar e a resposta. */
  const [executando, setExecutando] = useState(false);
  const [agora, setAgora] = useState(() => Date.now());
  const fim = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Espelho síncrono de `janela`: o poll e o envio decidem sem esperar render. */
  const janelaRef = useRef<Janela | null>(null);
  /**
   * Último run já mostrado como concluído. O poll lê "o run mais recente da
   * conversa" — no começo do turno seguinte esse ainda é o anterior, e sem
   * esta marca a tela repetiria a resposta de antes.
   */
  const runConcluidoRef = useRef<string | null>(null);
  /**
   * Relógio do servidor menos o do cliente. `runAfter` vem no relógio de lá;
   * a contagem roda no de cá. Calculado uma vez por janela, a partir do par
   * (runAfter, segundos) que o preview devolve, e reaplicado a cada `runAfter`
   * novo que o poll traz quando uma mensagem empurra a janela.
   */
  const desvioRelogioRef = useRef(0);

  const pararPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const limparTurno = useCallback(() => {
    pararPoll();
    janelaRef.current = null;
    setJanela(null);
    setExecutando(false);
  }, [pararPoll]);

  // Fluxo trocado: a conversa de teste era de outro fluxo e não serve mais.
  useEffect(() => {
    limparTurno();
    setConversationId(null);
    setFalas([]);
    runConcluidoRef.current = null;
    onPassos?.({});
  }, [flowId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => pararPoll(), [pararPoll]);
  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: 'smooth' });
  }, [falas, janela, executando]);

  // A contagem regressiva. Deriva de `fechaEm` a cada batida em vez de contar
  // pra baixo sozinha: quando o servidor empurra a janela, a tela acompanha.
  useEffect(() => {
    if (!janela) return;
    setAgora(Date.now());
    const relogio = setInterval(() => setAgora(Date.now()), INTERVALO_RELOGIO_MS);
    return () => clearInterval(relogio);
  }, [janela]);

  const aplicarPassos = useCallback(
    (steps: FlowRunStep[]) => {
      const porNo: StatusPorNo = {};
      for (const s of steps) porNo[s.nodeId] = execDoPasso(s);
      onPassos?.(porNo);
    },
    [onPassos]
  );

  /** O turno terminou — de qualquer um dos dois caminhos (na hora ou pelo worker). */
  const concluirTurno = useCallback(
    (turno: FlowPreview) => {
      // O mesmo run pode chegar pelo poll E pela resposta do preview; conta uma vez.
      if (runConcluidoRef.current === turno.runId) return;
      runConcluidoRef.current = turno.runId;
      limparTurno();
      setConversationId(turno.conversationId);
      aplicarPassos(turno.steps);
      onTurno?.(turno);
      setFalas((a) => [
        ...a,
        { autor: 'ia', texto: turno.resposta ?? motivoDoSilencio(turno), turno },
      ]);
    },
    [aplicarPassos, limparTurno, onTurno]
  );

  /**
   * Abre (ou empurra) a janela. `segundos` vem só do preview; o poll traz
   * apenas `runAfter` e reaproveita o desvio de relógio já calculado.
   * Nada muda quando o horário é o mesmo — o poll bate a cada 600ms e não
   * pode re-renderizar o canvas a cada batida.
   */
  const abrirJanela = useCallback(
    (runId: string, runAfter: string, segundos: number | null) => {
      const runAfterMs = new Date(runAfter).getTime();
      if (segundos !== null) {
        desvioRelogioRef.current = runAfterMs - segundos * 1000 - Date.now();
      }
      const fechaEm = runAfterMs - desvioRelogioRef.current;
      const atual = janelaRef.current;
      if (atual && atual.runId === runId && atual.fechaEm === fechaEm) return;

      const nova: Janela = { runId, fechaEm, segundos: segundos ?? atual?.segundos ?? 0 };
      janelaRef.current = nova;
      setJanela(nova);
      setExecutando(false);
      if (noDeAgrupamento && atual?.runId !== runId) {
        onPassos?.({ [noDeAgrupamento]: { status: STATUS_AGUARDANDO, ms: 0, error: null } });
      }
    },
    [noDeAgrupamento, onPassos]
  );

  /**
   * Acompanha o turno.
   *
   * O motor grava cada passo assim que o nó termina, então ler em intervalos
   * curtos mostra o fluxo acontecendo. E quando o turno ficou na janela de
   * agrupamento, é por aqui que a resposta chega: o worker executa o run e a
   * tela lê o resultado pela mesma porta que já usava pra acender os blocos.
   */
  const iniciarPoll = useCallback(
    (convId: string | null) => {
      if (!convId) return;
      pararPoll();
      pollRef.current = setInterval(async () => {
        try {
          const r = await flowsService.previewRunAtual(convId);
          if (!r || r.runId === runConcluidoRef.current) return;
          if (r.status === 'buffering') {
            if (r.runAfter) abrirJanela(r.runId, r.runAfter, null);
            return;
          }
          if (r.status === 'running') {
            janelaRef.current = null;
            setJanela(null);
            setExecutando(true);
            aplicarPassos(r.steps);
            return;
          }
          if (RUN_STATUS_TERMINAL.has(r.status)) concluirTurno(turnoDoRun(convId, r));
        } catch {
          // Falha de leitura não pode derrubar o turno em si — a próxima
          // batida tenta de novo, e no caminho imediato o resultado ainda
          // chega pela resposta do preview.
        }
      }, INTERVALO_POLL_MS);
    },
    [abrirJanela, aplicarPassos, concluirTurno, pararPoll]
  );

  const enviar = useMutation({
    mutationFn: (texto: string) => flowsService.preview(flowId, { message: texto, conversationId }),
    onMutate: () => {
      // Mensagem durante a janela NÃO é turno novo: entra na mesma resposta,
      // e a contagem só reinicia quando o servidor devolver o novo horário.
      if (janelaRef.current) return;
      onPassos?.({});
      iniciarPoll(conversationId);
    },
    onSuccess: (r) => {
      setConversationId(r.conversationId);
      if (ehTurnoAgrupando(r)) {
        abrirJanela(r.runId, r.runAfter, r.segundos);
        // No primeiro turno o poll ainda não tinha conversa pra consultar.
        if (!pollRef.current) iniciarPoll(r.conversationId);
        return;
      }
      concluirTurno(r);
    },
    onError: (e: Error) => {
      limparTurno();
      toast.error(e.message || 'Não deu pra rodar o fluxo');
    },
  });

  const reiniciar = useMutation({
    mutationFn: async () => {
      if (conversationId) await flowsService.resetPreview(conversationId);
    },
    onSuccess: () => {
      limparTurno();
      setConversationId(null);
      setFalas([]);
      runConcluidoRef.current = null;
      onPassos?.({});
      toast.success('Conversa de teste zerada — a IA não lembra de nada.');
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra zerar'),
  });

  /*
    Durante a JANELA o campo continua aberto: mandar outra mensagem é
    exatamente o que o lead faz, e o servidor junta tudo na mesma resposta.
    Trava só enquanto o pedido está no ar ou o fluxo está executando.
  */
  const ocupado = enviar.isPending || executando;
  const restante = janela ? Math.max(0, Math.ceil((janela.fechaEm - agora) / 1000)) : 0;

  function mandar() {
    const texto = rascunho.trim();
    if (!texto || ocupado) return;
    setFalas((a) => [...a, { autor: 'lead', texto }]);
    setRascunho('');
    enviar.mutate(texto);
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-xs font-medium">Testar atendimento</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={() => reiniciar.mutate()}
          disabled={!conversationId || ocupado || reiniciar.isPending}
          title="Descarta a conversa de teste, a memória construída nela e a janela em andamento"
        >
          <RotateCcw className="w-3.5 h-3.5 mr-1" />
          Recomeçar
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2.5 min-h-0">
        {falas.length === 0 && (
          <div className="h-full flex flex-col items-center justify-center text-center text-xs text-muted-foreground gap-2 px-4">
            <MessageSquareDashed className="w-7 h-7" />
            <p>
              Escreva como se fosse o lead. Os blocos do desenho acendem conforme executam —
              e ficam vermelhos onde quebrar.
            </p>
            <p className="text-[11px]">
              A espera é real aqui: se o fluxo agrupa mensagens por 15s, a resposta vem depois
              de 15s — o mesmo ritmo que o lead sente. Nada sai pro WhatsApp.
            </p>
          </div>
        )}

        {falas.map((f, i) => (
          <Balao key={i} fala={f} compacto={compacto} />
        ))}

        {janela && !enviar.isPending && (
          <AvisoDeJanela restante={restante} segundos={janela.segundos} />
        )}

        {(enviar.isPending || executando) && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {enviar.isPending && janela ? 'Juntando à mesma resposta…' : 'Rodando o fluxo…'}
          </div>
        )}
        <div ref={fim} />
      </div>

      <Separator />

      <div className="p-2.5 flex gap-2 items-end shrink-0">
        <Textarea
          value={rascunho}
          onChange={(e) => setRascunho(e.target.value)}
          onKeyDown={(e) => {
            // Enter manda, Shift+Enter quebra linha — como no WhatsApp.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              mandar();
            }
          }}
          placeholder={janela ? 'Mande mais uma — entra na mesma resposta' : 'Mensagem do lead…'}
          rows={2}
          className="resize-none text-sm"
          disabled={ocupado}
        />
        <Button size="icon" onClick={mandar} disabled={!rascunho.trim() || ocupado}>
          {ocupado ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
        </Button>
      </div>
    </div>
  );
}

/**
 * A bolha de sistema da janela de agrupamento. A contagem vem do horário que o
 * servidor marcou, não de um cronômetro local: quando outra mensagem empurra a
 * janela, o número acompanha.
 */
function AvisoDeJanela({ restante, segundos }: { restante: number; segundos: number }) {
  const fechou = restante <= 0;
  return (
    <div
      role="status"
      className="mx-auto flex max-w-[90%] items-center gap-2 rounded-md border border-sky-500/40 bg-sky-500/10 px-2.5 py-1.5 text-[11px] text-sky-700 dark:text-sky-400"
    >
      {fechou ? (
        <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
      ) : (
        <Timer className="w-3.5 h-3.5 shrink-0" />
      )}
      <span>
        {fechou
          ? 'Janela fechou — rodando o fluxo…'
          : `Agrupando mensagens… responde em ${restante}s`}
        {!fechou && segundos > 0 && (
          <span className="block text-[10px] opacity-80">
            Janela de {segundos}s, igual ao atendimento. Mandar outra mensagem reinicia a contagem.
          </span>
        )}
      </span>
    </div>
  );
}

/** Quando o fluxo roda mas não responde, o motivo é a informação útil. */
function motivoDoSilencio(turno: FlowPreview): string {
  if (turno.error) return `O fluxo falhou: ${turno.error}`;
  if (turno.stopReason) return `O fluxo parou antes de responder (${turno.stopReason}).`;
  return 'O fluxo rodou até o fim sem chegar num passo de resposta.';
}

function Balao({ fala, compacto }: { fala: Fala; compacto: boolean }) {
  const doLead = fala.autor === 'lead';
  const semResposta = !doLead && !fala.turno?.resposta;

  return (
    <div className={`flex gap-2 ${doLead ? 'justify-end' : 'justify-start'}`}>
      {!doLead && (
        <span className="w-5 h-5 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-3 h-3" />
        </span>
      )}
      <div
        className={`max-w-[85%] rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-words ${
          compacto ? 'text-[13px]' : 'text-sm'
        } ${
          doLead
            ? 'bg-primary text-primary-foreground'
            : semResposta
              ? 'border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
              : 'bg-muted'
        }`}
      >
        {semResposta && <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />}
        {fala.texto}
      </div>
      {doLead && (
        <span className="w-5 h-5 rounded-full bg-muted text-muted-foreground flex items-center justify-center shrink-0 mt-0.5">
          <User className="w-3 h-3" />
        </span>
      )}
    </div>
  );
}
