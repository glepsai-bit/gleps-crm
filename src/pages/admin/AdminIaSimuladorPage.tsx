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
import { SimuladorChat } from '@/components/flow/SimuladorChat';

export default function AdminIaSimuladorPage() {
  const [flowId, setFlowId] = useState<string>('');
  const [turnoAberto, setTurnoAberto] = useState<FlowPreview | null>(null);

  const { data: fluxos, isLoading: carregandoFluxos } = useQuery({
    queryKey: ['flows'],
    queryFn: () => flowsService.list(),
  });

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

  const rotuloDoNo = (tipo: string) =>
    catalogo?.nodes.find((n) => n.type === tipo)?.label ?? tipo;

  // Escolhe sozinho quando só existe um fluxo — um passo a menos pra testar.
  useEffect(() => {
    if (!flowId && fluxos?.length === 1) setFlowId(fluxos[0].id);
  }, [fluxos, flowId]);

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
          <p className="text-xs text-muted-foreground mt-1.5">
            Para ver os blocos acenderem no desenho enquanto rodam, use o botão{' '}
            <strong>Testar</strong> dentro do fluxo.
          </p>
        </div>

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

      {flowId && (
        <div className="flex gap-6 items-start">
          <Card className="flex-1 min-w-0 h-[calc(100vh-18rem)] overflow-hidden">
            {/* Mesmo componente da aba do fluxo: se cada tela tivesse a sua
                cópia, elas divergiriam no primeiro ajuste. */}
            <SimuladorChat flowId={flowId} onTurno={setTurnoAberto} />
          </Card>

          <div className="w-[28rem] shrink-0 space-y-3 max-h-[calc(100vh-18rem)] overflow-y-auto">
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
