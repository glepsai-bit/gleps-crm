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
 * Um componente só, usado pela aba do fluxo e pela página autônoma: se cada uma
 * tivesse a sua cópia, elas divergiriam no primeiro ajuste.
 */
import { useState, useRef, useEffect, useCallback } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Send, RotateCcw, Bot, User, Loader2, AlertTriangle, MessageSquareDashed } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { toast } from 'sonner';
import {
  flowsService,
  type FlowPreview,
  type FlowRunStep,
} from '@/services/flows.backend.service';

export interface Fala {
  autor: 'lead' | 'ia';
  texto: string;
  turno?: FlowPreview;
}

/** Estado de execução de cada nó, para o canvas pintar. */
export type StatusPorNo = Record<string, { status: string; ms: number; error: string | null }>;

/** Enquanto o turno roda, os passos são lidos neste intervalo. */
const INTERVALO_POLL_MS = 600;

interface Props {
  flowId: string;
  /** Passos do turno atual, conforme chegam. O canvas usa pra acender os nós. */
  onPassos?: (porNo: StatusPorNo) => void;
  /** Turno concluído — o painel lateral mostra memórias e tempos. */
  onTurno?: (turno: FlowPreview) => void;
  compacto?: boolean;
}

export function SimuladorChat({ flowId, onPassos, onTurno, compacto = false }: Props) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [falas, setFalas] = useState<Fala[]>([]);
  const [rascunho, setRascunho] = useState('');
  const fim = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const pararPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Fluxo trocado: a conversa de teste era de outro fluxo e não serve mais.
  useEffect(() => {
    setConversationId(null);
    setFalas([]);
    onPassos?.({});
  }, [flowId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => pararPoll(), [pararPoll]);
  useEffect(() => {
    fim.current?.scrollIntoView({ behavior: 'smooth' });
  }, [falas]);

  const aplicarPassos = useCallback(
    (steps: FlowRunStep[]) => {
      const porNo: StatusPorNo = {};
      for (const s of steps) {
        porNo[s.nodeId] = { status: s.status, ms: s.ms, error: s.error };
      }
      onPassos?.(porNo);
    },
    [onPassos]
  );

  /**
   * Acompanha a execução em andamento.
   *
   * O motor grava cada passo assim que o nó termina, então ler em intervalos
   * curtos mostra o fluxo acontecendo. Só começa a partir do SEGUNDO turno:
   * no primeiro ainda não existe conversa de teste pra consultar.
   */
  const iniciarPoll = useCallback(
    (convId: string | null) => {
      if (!convId) return;
      pararPoll();
      pollRef.current = setInterval(async () => {
        try {
          const r = await flowsService.previewRunAtual(convId);
          if (r) aplicarPassos(r.steps);
        } catch {
          // Falha de leitura não pode derrubar o turno em si — o resultado
          // final chega pela resposta do preview de qualquer jeito.
        }
      }, INTERVALO_POLL_MS);
    },
    [aplicarPassos, pararPoll]
  );

  const enviar = useMutation({
    mutationFn: (texto: string) => flowsService.preview(flowId, { message: texto, conversationId }),
    onMutate: () => {
      onPassos?.({});
      iniciarPoll(conversationId);
    },
    onSettled: () => pararPoll(),
    onSuccess: (turno) => {
      setConversationId(turno.conversationId);
      aplicarPassos(turno.steps);
      onTurno?.(turno);
      setFalas((a) => [
        ...a,
        {
          autor: 'ia',
          texto: turno.resposta ?? motivoDoSilencio(turno),
          turno,
        },
      ]);
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra rodar o fluxo'),
  });

  const reiniciar = useMutation({
    mutationFn: async () => {
      if (conversationId) await flowsService.resetPreview(conversationId);
    },
    onSuccess: () => {
      setConversationId(null);
      setFalas([]);
      onPassos?.({});
      toast.success('Conversa de teste zerada — a IA não lembra de nada.');
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra zerar'),
  });

  function mandar() {
    const texto = rascunho.trim();
    if (!texto || enviar.isPending) return;
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
          disabled={!conversationId || reiniciar.isPending}
          title="Descarta a conversa de teste e a memória construída nela"
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
            <p className="text-[11px]">Nada sai pro WhatsApp.</p>
          </div>
        )}

        {falas.map((f, i) => (
          <Balao key={i} fala={f} compacto={compacto} />
        ))}

        {enviar.isPending && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            Rodando o fluxo…
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
          placeholder="Mensagem do lead…"
          rows={2}
          className="resize-none text-sm"
          disabled={enviar.isPending}
        />
        <Button size="icon" onClick={mandar} disabled={!rascunho.trim() || enviar.isPending}>
          {enviar.isPending ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Send className="w-4 h-4" />
          )}
        </Button>
      </div>
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
