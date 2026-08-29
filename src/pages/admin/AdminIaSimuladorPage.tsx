/**
 * T-031 — simulador de atendimento.
 *
 * Ajustar prompt de IA é um ciclo de tentativa e erro, e até aqui esse ciclo
 * custava caro: mandar mensagem de um número de teste, esperar o agrupamento,
 * abrir as execuções e ler os passos. Ninguém itera assim.
 *
 * Aqui o fluxo INTEIRO roda na hora — mesmos nós, mesmo agente, mesma memória —
 * só que em modo sombra: nada sai pro WhatsApp e nada muda no funil. À direita
 * ficam os passos do último turno, que é onde se descobre *por que* a IA
 * respondeu aquilo.
 */
import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  Send,
  RotateCcw,
  Bot,
  User,
  CheckCircle2,
  XCircle,
  MinusCircle,
  Clock,
  Brain,
  MessageSquareDashed,
  AlertTriangle,
  Loader2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  flowsService,
  type FlowPreview,
  type FlowRunStep,
} from '@/services/flows.backend.service';

interface Fala {
  autor: 'lead' | 'ia';
  texto: string;
  /** Só nas falas da IA: o turno que a produziu, pra abrir os passos. */
  turno?: FlowPreview;
}

export default function AdminIaSimuladorPage() {
  const [flowId, setFlowId] = useState<string>('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [falas, setFalas] = useState<Fala[]>([]);
  const [rascunho, setRascunho] = useState('');
  const [turnoAberto, setTurnoAberto] = useState<FlowPreview | null>(null);
  const fimDaLista = useRef<HTMLDivElement>(null);

  const { data: fluxos, isLoading: carregandoFluxos } = useQuery({
    queryKey: ['flows'],
    queryFn: () => flowsService.list(),
  });

  // O detalhe traz `problemas` — a mesma validação que bloqueia publicar. Sem
  // isso o usuário só descobriria o grafo quebrado ao mandar a primeira
  // mensagem e receber um toast de erro.
  const { data: fluxo } = useQuery({
    queryKey: ['flow', flowId],
    queryFn: () => flowsService.get(flowId),
    enabled: Boolean(flowId),
  });

  const { data: catalogo } = useQuery({
    queryKey: ['flow-catalog'],
    queryFn: () => flowsService.catalog(),
    staleTime: Infinity,
  });

  // Nome amigável do nó — "Responder no WhatsApp" em vez de "chat.reply".
  const rotuloDoNo = (tipo: string) =>
    catalogo?.nodes.find((n) => n.type === tipo)?.label ?? tipo;

  const fluxoSelecionado = fluxos?.find((f) => f.id === flowId);

  // Escolhe sozinho quando só existe um fluxo — um passo a menos pra testar.
  useEffect(() => {
    if (!flowId && fluxos?.length === 1) setFlowId(fluxos[0].id);
  }, [fluxos, flowId]);

  useEffect(() => {
    fimDaLista.current?.scrollIntoView({ behavior: 'smooth' });
  }, [falas]);

  const enviar = useMutation({
    mutationFn: (texto: string) =>
      flowsService.preview(flowId, { message: texto, conversationId }),
    onSuccess: (turno) => {
      setConversationId(turno.conversationId);
      setTurnoAberto(turno);
      setFalas((atual) => [
        ...atual,
        turno.resposta
          ? { autor: 'ia' as const, texto: turno.resposta, turno }
          : {
              autor: 'ia' as const,
              texto: motivoDoSilencio(turno),
              turno,
            },
      ]);
    },
    onError: (e: Error) => {
      toast.error(e.message || 'Não deu pra rodar o fluxo');
      // A fala do lead fica: o erro é do fluxo, não do que foi digitado.
    },
  });

  const reiniciar = useMutation({
    mutationFn: async () => {
      if (conversationId) await flowsService.resetPreview(conversationId);
    },
    onSuccess: () => {
      setConversationId(null);
      setFalas([]);
      setTurnoAberto(null);
      toast.success('Conversa de teste zerada — a IA não lembra de nada.');
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra zerar'),
  });

  function mandar() {
    const texto = rascunho.trim();
    if (!texto || !flowId || enviar.isPending) return;
    setFalas((atual) => [...atual, { autor: 'lead', texto }]);
    setRascunho('');
    enviar.mutate(texto);
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Simulador de atendimento</h1>
          <p className="text-muted-foreground mt-1 max-w-2xl">
            Converse como se fosse o lead e veja a IA responder na hora. Roda o fluxo inteiro —
            mesmo agente, mesma base de conhecimento, mesma memória — mas{' '}
            <strong>nada sai pro WhatsApp</strong> e nada muda no funil.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Select value={flowId} onValueChange={setFlowId} disabled={carregandoFluxos}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder="Escolha o fluxo" />
            </SelectTrigger>
            <SelectContent>
              {fluxos?.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant="outline"
            onClick={() => reiniciar.mutate()}
            disabled={!conversationId || reiniciar.isPending}
            title="Descarta a conversa de teste e a memória construída nela"
          >
            <RotateCcw className="w-4 h-4 mr-2" />
            Recomeçar
          </Button>
        </div>
      </div>

      {!carregandoFluxos && !fluxos?.length && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nenhum fluxo criado ainda. Monte um em <strong>Fluxos</strong> e volte aqui pra testar.
          </CardContent>
        </Card>
      )}

      {fluxo?.problemas?.length ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <div className="flex items-center gap-2 font-medium text-destructive">
            <AlertTriangle className="w-4 h-4" />
            Este fluxo não roda como está
          </div>
          <ul className="mt-1.5 ml-6 list-disc text-destructive/90 text-xs space-y-0.5">
            {fluxo.problemas.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {fluxoSelecionado && (
        <div className="flex gap-6 items-start">
          {/* ---------- Conversa ---------- */}
          <Card className="flex-1 min-w-0 flex flex-col h-[calc(100vh-16rem)]">
            <CardContent className="flex-1 overflow-y-auto p-4 space-y-3">
              {falas.length === 0 && (
                <div className="h-full flex flex-col items-center justify-center text-center text-sm text-muted-foreground gap-2">
                  <MessageSquareDashed className="w-8 h-8" />
                  <p className="max-w-sm">
                    Escreva a primeira mensagem como se fosse o lead chegando no WhatsApp.
                  </p>
                </div>
              )}

              {falas.map((f, i) => (
                <Balao
                  key={i}
                  fala={f}
                  selecionado={Boolean(f.turno && f.turno.runId === turnoAberto?.runId)}
                  onAbrir={() => f.turno && setTurnoAberto(f.turno)}
                />
              ))}

              {enviar.isPending && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  Rodando o fluxo…
                </div>
              )}
              <div ref={fimDaLista} />
            </CardContent>

            <Separator />

            <div className="p-3 flex gap-2 items-end">
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
                className="resize-none"
                disabled={enviar.isPending}
              />
              <Button onClick={mandar} disabled={!rascunho.trim() || enviar.isPending}>
                {enviar.isPending ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Send className="w-4 h-4" />
                )}
              </Button>
            </div>
          </Card>

          {/* ---------- O que aconteceu por trás ---------- */}
          <div className="w-[28rem] shrink-0 space-y-3 max-h-[calc(100vh-16rem)] overflow-y-auto">
            {!turnoAberto && (
              <Card>
                <CardContent className="py-8 text-center text-xs text-muted-foreground">
                  Os passos do fluxo aparecem aqui a cada resposta.
                </CardContent>
              </Card>
            )}

            {turnoAberto && <PainelDoTurno turno={turnoAberto} rotuloDoNo={rotuloDoNo} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** Quando o fluxo roda mas não responde, o motivo é a informação útil. */
function motivoDoSilencio(turno: FlowPreview): string {
  if (turno.error) return `O fluxo falhou: ${turno.error}`;
  if (turno.stopReason) return `O fluxo parou antes de responder (${turno.stopReason}).`;
  return 'O fluxo rodou até o fim sem chegar num passo de resposta.';
}

function Balao({
  fala,
  selecionado,
  onAbrir,
}: {
  fala: Fala;
  selecionado: boolean;
  onAbrir: () => void;
}) {
  const doLead = fala.autor === 'lead';
  const semResposta = !doLead && !fala.turno?.resposta;

  return (
    <div className={`flex gap-2 ${doLead ? 'justify-end' : 'justify-start'}`}>
      {!doLead && (
        <span className="w-6 h-6 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0 mt-0.5">
          <Bot className="w-3.5 h-3.5" />
        </span>
      )}

      <button
        onClick={onAbrir}
        disabled={doLead}
        className={`max-w-[80%] text-left rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words transition-colors ${
          doLead
            ? 'bg-primary text-primary-foreground cursor-default'
            : semResposta
              ? 'border border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400'
              : `bg-muted ${selecionado ? 'ring-2 ring-primary/40' : 'hover:bg-muted/70'}`
        }`}
      >
        {semResposta && <AlertTriangle className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />}
        {fala.texto}
      </button>

      {doLead && (
        <span className="w-6 h-6 rounded-full bg-muted text-muted-foreground flex items-center justify-center shrink-0 mt-0.5">
          <User className="w-3.5 h-3.5" />
        </span>
      )}
    </div>
  );
}

function PainelDoTurno({
  turno,
  rotuloDoNo,
}: {
  turno: FlowPreview;
  rotuloDoNo: (tipo: string) => string;
}) {
  const totalMs = turno.steps.reduce((soma, s) => soma + s.ms, 0);

  return (
    <>
      <Card>
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">Passos deste turno</span>
            <span className="text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {(totalMs / 1000).toFixed(1)}s
            </span>
          </div>

          {turno.error && (
            <div className="text-[11px] rounded-md border border-destructive/30 bg-destructive/10 text-destructive p-2 break-words">
              {turno.error}
            </div>
          )}

          <div className="space-y-1.5">
            {turno.steps.map((s) => (
              <Passo key={s.id} step={s} rotulo={rotuloDoNo(s.nodeType)} />
            ))}
          </div>
        </CardContent>
      </Card>

      {/*
        As duas memórias lado a lado. É o que deixa ver, turno a turno, o que a
        IA guardou sobre a pessoa e onde ela acha que está no roteiro — a causa
        mais comum de "por que ela perguntou isso de novo?".
      */}
      <Memoria
        titulo="Sobre esta pessoa"
        ajuda="Longo prazo — fica no contato e vale nas próximas conversas."
        dados={turno.memoria}
      />
      <Memoria
        titulo="Nesta conversa"
        ajuda="Curto prazo — morre junto com a conversa."
        dados={turno.sessao}
      />
    </>
  );
}

function Memoria({
  titulo,
  ajuda,
  dados,
}: {
  titulo: string;
  ajuda: string;
  dados: Record<string, unknown>;
}) {
  const itens = Object.entries(dados ?? {});
  return (
    <Card>
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center gap-1.5">
          <Brain className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium">{titulo}</span>
        </div>
        <p className="text-[11px] text-muted-foreground leading-snug">{ajuda}</p>
        {itens.length === 0 ? (
          <p className="text-[11px] text-muted-foreground italic">Nada guardado ainda.</p>
        ) : (
          <dl className="space-y-1">
            {itens.map(([chave, valor]) => (
              <div key={chave} className="text-[11px] flex gap-2">
                <dt className="text-muted-foreground shrink-0 max-w-[45%] truncate">{chave}</dt>
                <dd className="font-medium break-words min-w-0">{textoDoValor(valor)}</dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

const textoDoValor = (v: unknown): string =>
  typeof v === 'string' ? v : JSON.stringify(v);

function Passo({ step, rotulo }: { step: FlowRunStep; rotulo: string }) {
  const [aberto, setAberto] = useState(false);

  const icone =
    step.status === 'ok' ? (
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
    ) : step.status === 'error' ? (
      <XCircle className="w-3.5 h-3.5 text-destructive shrink-0" />
    ) : (
      <MinusCircle className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
    );

  const saida = (step.output ?? {}) as Record<string, unknown>;
  const simulado = Boolean(saida.simulado);

  return (
    <div className="rounded-md border text-xs">
      <button
        onClick={() => setAberto((v) => !v)}
        className="w-full flex items-center gap-2 p-2 text-left hover:bg-muted/40"
      >
        {icone}
        <span className="font-medium truncate">{rotulo}</span>
        {simulado && (
          <Badge
            variant="outline"
            className="bg-amber-500/15 text-amber-600 border-amber-500/30 text-[10px] py-0 shrink-0"
          >
            simulado
          </Badge>
        )}
        <span className="ml-auto text-muted-foreground shrink-0">{step.ms}ms</span>
      </button>

      {aberto && (
        <div className="border-t p-2 space-y-2 bg-muted/20">
          {step.error && <div className="text-destructive break-words">{step.error}</div>}
          {step.output && (
            <pre className="text-[10px] leading-snug whitespace-pre-wrap break-words text-muted-foreground max-h-64 overflow-y-auto">
              {JSON.stringify(step.output, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
