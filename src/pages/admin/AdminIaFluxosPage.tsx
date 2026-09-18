/**
 * T-028 Fase 2 — construtor do fluxo de atendimento.
 *
 * Canvas com catálogo FECHADO de nós. Não é um n8n genérico de propósito: o
 * domínio aqui é um só (atendimento), e cada nó a mais seria uma forma a mais
 * de configurar errado o próprio atendimento.
 *
 * O grafo desenhado aqui é exatamente o JSON que o motor executa — a tela é um
 * editor dele, não uma camada por cima.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  reconnectEdge,
  useNodesState,
  useEdgesState,
  ConnectionLineType,
  type Node,
  type Edge,
  type Connection,
  type EdgeTypes,
  type FinalConnectionState,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTheme } from 'next-themes';
import { FlowNodeCard, type FlowNodeData } from '@/components/flow/FlowNodeCard';
import { SimuladorChat, type StatusPorNo } from '@/components/flow/SimuladorChat';
import { CamposDoNo } from '@/components/flow/CamposDoNo';
import { ExecucoesDoFluxo } from '@/components/flow/ExecucoesDoFluxo';
import { EditorDeFluxoContext } from '@/components/flow/EditorDeFluxoContext';
import { ArestaDoFluxo } from '@/components/flow/ArestaDoFluxo';
import { PainelAgente } from '@/components/flow/PainelAgente';
import { PainelBase } from '@/components/flow/PainelBase';
import { PainelMemoria } from '@/components/flow/PainelMemoria';
import {
  TIPOS_DE_AGENTE,
  basesDesenhadas,
  ehFonte,
  entradaDaAresta,
  ligacaoPermitida,
  textoDaConfig,
} from '@/components/flow/portas';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Clock,
  Eye,
  FlaskConical,
  Pause,
  Play,
  Plus,
  Save,
  Trash2,
  Workflow,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import {
  flowsService,
  type FlowGraph,
  type FlowNode,
  type FlowStatus,
  type NodeTypeInfo,
} from '@/services/flows.backend.service';
import { aiService } from '@/services/ai.backend.service';

const STATUS_INFO: Record<FlowStatus, { label: string; classe: string; ajuda: string }> = {
  draft: {
    label: 'Rascunho',
    classe: 'bg-muted text-muted-foreground',
    // "Salvo" não é "ligado": o fluxo salvo em rascunho não atende ninguém.
    ajuda:
      'Não atende ninguém — salvar não liga. Monte e teste à vontade; para atender de ' +
      'verdade, ative em Sombra ou Ativar.',
  },
  shadow: {
    label: 'Sombra',
    classe: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
    ajuda:
      'Roda de verdade e grava cada passo, mas NÃO envia mensagem nem altera a conversa. ' +
      'É o modo para comparar com o n8n antes de virar a chave.',
  },
  active: {
    label: 'Ativo',
    classe: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
    ajuda: 'Atendendo os leads de verdade.',
  },
};

export default function AdminIaFluxosPage() {
  const [abertoId, setAbertoId] = useState<string | null>(null);

  return abertoId ? (
    <EditorDeFluxo flowId={abertoId} onVoltar={() => setAbertoId(null)} />
  ) : (
    <ListaDeFluxos onAbrir={setAbertoId} />
  );
}

// ============================================
// Lista
// ============================================

/**
 * As saídas de um bloco "Atender com IA".
 *
 * Fixas: respondeu, humano, encerrou — os três desfechos que todo atendimento
 * tem. Dinâmicas: cada valor do enum `rota` no schema do agente, que é como
 * quem monta declara "este agente encaminha para vendas, suporte ou fiscal".
 */
/**
 * A paleta agrupada por intenção, e não uma lista plana.
 *
 * Lista plana é armadilha: "Atender com IA" ficava lado a lado com as seis
 * peças que ele substitui, sem dizer isso. Quem não conhece escolhe "Agente de
 * IA" — soa mais básico — e monta na mão o fluxo de onze blocos que a gente
 * acabou de eliminar.
 *
 * As peças continuam disponíveis, em "Em partes": fluxo antigo depende delas, e
 * há casos legítimos (aplicar etapa sem responder, responder texto fixo sem
 * agente). Mas ficam claramente subordinadas.
 */
const GRUPOS: { titulo: string; tipos: string[]; nota?: string; recolhido?: boolean }[] = [
  {
    titulo: 'Atender',
    tipos: ['ai.atender', 'guard.conditions', 'buffer.debounce', 'media.transcribe'],
  },
  {
    titulo: 'Fontes',
    tipos: ['source.knowledge'],
    nota: 'Ligue na entrada tracejada, na lateral esquerda do bloco de atendimento.',
  },
  {
    titulo: 'Agir',
    tipos: [
      'chat.assign_human',
      'chat.resolve',
      'crm.apply_stage',
      'crm.update_contact',
      'chat.reply',
      'http.request',
    ],
  },
  { titulo: 'Tempo', tipos: ['flow.aguardar', 'flow.wait'] },
  {
    titulo: 'Em partes',
    tipos: ['ai.agent', 'logic.switch'],
    nota: 'O que "Atender com IA" já faz junto. Use quando precisar separar.',
    // Fechado por padrão. Estes blocos NÃO podem sair do catálogo — a cadência
    // de follow-up roda com `ai.agent`, e ramificar por variável que não é a
    // rota do agente (`{{memoria.plano}}`) só o `logic.switch` faz. Mas quem
    // está montando um atendimento não deveria tropeçar neles: a montagem
    // normal é o bloco composto.
    recolhido: true,
  },
];

/**
 * Como toda ligação é desenhada e gravada.
 *
 * Um lugar só: antes o estilo vivia no carregamento e a aresta criada no
 * `onConnect` saía sem ele — ligação nova ficava visualmente diferente das
 * salvas até recarregar a página.
 */
const ESTILO_ARESTA = {
  type: 'fluxo',
  markerEnd: { type: MarkerType.ArrowClosed, color: 'hsl(var(--muted-foreground))' },
  style: { stroke: 'hsl(var(--muted-foreground))', strokeWidth: 2 },
} as const;

/**
 * A ligação de uma FONTE até o agente.
 *
 * Tracejada de propósito: ela não é um passo do fluxo, é o material que o
 * agente consulta. Com o mesmo traço da aresta de fluxo, o desenho sugeria que
 * a conversa passava pela base antes de chegar no atendimento.
 */
const ESTILO_ARESTA_FONTE = {
  ...ESTILO_ARESTA,
  style: { ...ESTILO_ARESTA.style, strokeDasharray: '6 5' },
} as const;

/** O ramo gravado numa aresta do canvas. */
function ramoDaAresta(e: Edge): string | null {
  const b = (e.data as Record<string, unknown> | undefined)?.branch;
  return typeof b === 'string' && b ? b : null;
}

/**
 * Qual porta do bloco de origem a aresta sai.
 *
 * Sem isto o React Flow cai em `handles[0]` e TODOS os cabos de um bloco saem
 * da primeira bolinha — o desenho mostrava três linhas nascendo em "respondeu"
 * com os rótulos "humano" e "encerrou" flutuando ao lado. O desenho mentia
 * sobre o fluxo que o motor roda.
 *
 * Quando o ramo salvo não existe mais entre as portas (o agente perdeu uma rota
 * do enum, por exemplo) volta a ser `undefined`: melhor a aresta grudar na
 * primeira porta do que sumir da tela sem explicação.
 */
function portaDaAresta(branch: string | null, portas: string[] | undefined): string | undefined {
  if (!portas || portas.length === 0) return undefined;
  const alvo = branch ?? 'default';
  return portas.includes(alvo) ? alvo : undefined;
}

function portasDoAgente(outputSchema: unknown): string[] {
  const base = ['respondeu', 'humano', 'encerrou'];
  const schema = outputSchema as
    | { properties?: { rota?: { enum?: unknown[] } } }
    | null
    | undefined;
  const rotas = schema?.properties?.rota?.enum;
  if (!Array.isArray(rotas)) return base;
  const extras = rotas.filter((r): r is string => typeof r === 'string' && !base.includes(r));
  return [...base, ...extras];
}

/**
 * As saídas nomeadas de um bloco — ou `undefined` quando ele tem saída única.
 *
 * Vinha fixo só para `ai.atender`. Com isso `guard.conditions` (bloqueado),
 * `http.request` (erro), `chat.assign_human` (sem_atendente) e os casos do
 * `logic.switch` tinham ramo no motor e NENHUMA porta na tela: era impossível
 * desenhar o caminho de erro de uma chamada de API.
 */
function portasDoNo(
  tipo: string,
  config: Record<string, unknown>,
  info: NodeTypeInfo | undefined,
  agentes: { id: string; outputSchema?: unknown }[] | undefined
): string[] | undefined {
  if (tipo === 'ai.atender') {
    const agentId = (config as { agentId?: string }).agentId;
    return portasDoAgente(agentes?.find((a) => a.id === agentId)?.outputSchema);
  }
  if (tipo === 'logic.switch') {
    const casos = Array.isArray(config.casos) ? (config.casos as { branch?: unknown }[]) : [];
    const ramos = casos
      .map((c) => (typeof c.branch === 'string' ? c.branch : ''))
      .filter((b): b is string => Boolean(b));
    return ramos.length ? ['default', ...ramos] : undefined;
  }
  const ramos = info?.branches ?? [];
  return ramos.length > 1 ? ramos.map((b) => b.key) : undefined;
}

/**
 * O que o bloco de agente mostra sobre a base — e o aviso do que ainda não
 * bate com o salvo. É o que faltava pra descobrir que a busca estava ligada
 * num agente sem base: o painel mostrava o estado salvo, e desenhar a linha
 * não mudava nada até salvar.
 */
function baseDoBloco(params: {
  agentId: string | null;
  agente: { knowledgeBaseId: string | null; knowledgeBase?: { name: string } | null } | undefined;
  desenhada: Map<string, string | null>;
  ligadaNoSalvo: Set<string>;
  nomeDaBase: (id: string | null) => string | null;
}): FlowNodeData['base'] {
  const { agentId, agente, desenhada, ligadaNoSalvo, nomeDaBase } = params;
  if (!agentId) return undefined;

  const salvaId = agente?.knowledgeBaseId ?? null;
  const salvaNome = agente?.knowledgeBase?.name ?? nomeDaBase(salvaId);

  if (desenhada.has(agentId)) {
    const baseId = desenhada.get(agentId) ?? null;
    if (!baseId) return { nome: null, aviso: '(escolha a base no bloco ligado)' };
    const nome = nomeDaBase(baseId) ?? 'base';
    return baseId === salvaId ? { nome } : { nome, aviso: '(salvar pra aplicar)' };
  }
  if (salvaId) {
    return ligadaNoSalvo.has(agentId)
      ? { nome: salvaNome, aviso: '(salvar pra desligar)' }
      : { nome: salvaNome, aviso: '(ligada fora deste fluxo)' };
  }
  return { nome: null };
}

/**
 * Excluir um fluxo.
 *
 * Confirma sempre — leva as execuções gravadas junto — e o aviso muda de peso
 * conforme o modo: apagar um rascunho é uma coisa, apagar o fluxo que está
 * atendendo os leads neste minuto é outra.
 */
function DialogoExcluirFluxo({
  fluxo,
  onFechar,
  onExcluido,
}: {
  fluxo: { id: string; name: string; status: FlowStatus } | null;
  onFechar: () => void;
  onExcluido: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const excluir = useMutation({
    mutationFn: (id: string) => flowsService.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['flows'] });
      toast({ title: 'Fluxo excluído' });
      onExcluido();
    },
    onError: (e: Error) =>
      toast({ title: 'Não foi possível excluir', description: e.message, variant: 'destructive' }),
  });

  // O diálogo anima a saída DEPOIS de `fluxo` virar null. Sem guardar o
  // último, o título piscava `Excluir “”?` durante a animação.
  const ultimo = useRef(fluxo);
  if (fluxo) ultimo.current = fluxo;
  const mostrado = fluxo ?? ultimo.current;

  const emUso = mostrado ? mostrado.status !== 'draft' : false;

  return (
    <AlertDialog open={Boolean(fluxo)} onOpenChange={(v) => !v && onFechar()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Excluir “{mostrado?.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            {emUso && (
              <span className="mb-2 block font-medium text-destructive">
                {mostrado?.status === 'active'
                  ? 'Este fluxo está ATIVO — está atendendo os leads agora. Excluir interrompe o atendimento automático na hora.'
                  : 'Este fluxo está em SOMBRA — está rodando e gravando cada passo para você comparar. Excluir encerra a comparação.'}
              </span>
            )}
            O desenho e todas as execuções gravadas dele vão junto. Não dá para desfazer.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={excluir.isPending}>Manter</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={excluir.isPending}
            onClick={(e) => {
              // O AlertDialog fecha no clique da ação; segurar até a API
              // responder evita a lista piscar como se já tivesse apagado.
              e.preventDefault();
              if (fluxo) excluir.mutate(fluxo.id);
            }}
          >
            {excluir.isPending ? 'Excluindo…' : 'Excluir'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ListaDeFluxos({ onAbrir }: { onAbrir: (id: string) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [paraExcluir, setParaExcluir] = useState<{
    id: string;
    name: string;
    status: FlowStatus;
  } | null>(null);

  const { data: fluxos, isLoading } = useQuery({
    queryKey: ['flows'],
    queryFn: flowsService.list,
  });
  const { data: agentes } = useQuery({ queryKey: ['ai-agents'], queryFn: aiService.listAgents });

  const criarPadrao = useMutation({
    mutationFn: () => flowsService.seedDefault(agentes?.[0]?.id),
    onSuccess: (flow) => {
      qc.invalidateQueries({ queryKey: ['flows'] });
      toast({
        title: 'Fluxo criado',
        description: 'Confira o desenho e escolha o agente antes de publicar.',
      });
      onAbrir(flow.id);
    },
    onError: (e: Error) =>
      toast({ title: 'Não foi possível criar', description: e.message, variant: 'destructive' }),
  });

  const criarFollowup = useMutation({
    mutationFn: () => flowsService.seedFollowup(agentes?.[0]?.id),
    onSuccess: ({ flow }) => {
      qc.invalidateQueries({ queryKey: ['flows'] });
      toast({
        title: 'Cadência de follow-up criada',
        // O aviso é a parte útil: sem o trecho no prompt, o agente ignora o
        // objetivo do toque e escreve como se fosse a primeira mensagem.
        description:
          'Três toques prontos. Adicione {{objetivo_do_passo}} ao prompt do agente para ' +
          'ele escrever cada toque com a intenção certa.',
      });
      onAbrir(flow.id);
    },
    onError: (e: Error) =>
      toast({ title: 'Não foi possível criar', description: e.message, variant: 'destructive' }),
  });

  if (isLoading) return <div className="p-6 text-muted-foreground">Carregando…</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Fluxos de atendimento</h1>
          <p className="text-muted-foreground mt-1">
            O que acontece quando o lead manda mensagem: quem responde, quando transferir e
            quando encerrar.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            onClick={() => criarFollowup.mutate()}
            disabled={criarFollowup.isPending}
            title="Três toques com espera crescente, conferindo se ainda cabe falar"
          >
            <Clock className="w-4 h-4 mr-2" />
            {criarFollowup.isPending ? 'Criando…' : 'Cadência de follow-up'}
          </Button>
          <Button onClick={() => criarPadrao.mutate()} disabled={criarPadrao.isPending}>
            <Plus className="w-4 h-4 mr-2" />
            {criarPadrao.isPending ? 'Criando…' : 'Criar fluxo padrão'}
          </Button>
        </div>
      </div>

      {!fluxos?.length ? (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Workflow className="w-10 h-10 mx-auto text-muted-foreground" />
            <div className="font-medium">Nenhum fluxo ainda</div>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              O fluxo padrão já vem montado com o desenho do atendimento: agrupa as mensagens do
              lead, roda o agente, aplica a etapa no kanban e responde — transferindo para um
              humano quando o lead pedir.
            </p>
            <Button onClick={() => criarPadrao.mutate()} disabled={criarPadrao.isPending}>
              <Plus className="w-4 h-4 mr-2" />
              Criar fluxo padrão
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {fluxos.map((f) => {
            const info = STATUS_INFO[f.status];
            return (
              <Card
                key={f.id}
                className="cursor-pointer hover:border-primary/40 transition-colors"
                onClick={() => onAbrir(f.id)}
              >
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-base">{f.name}</CardTitle>
                    <div className="flex shrink-0 items-center gap-1">
                      <Badge variant="outline" className={info.classe} title={info.ajuda}>
                        {info.label}
                      </Badge>
                      <button
                        type="button"
                        title="Excluir fluxo"
                        aria-label={`Excluir ${f.name}`}
                        // O card inteiro abre o fluxo: sem parar a propagação o
                        // clique na lixeira abriria o editor por baixo do aviso.
                        onClick={(e) => {
                          e.stopPropagation();
                          setParaExcluir({ id: f.id, name: f.name, status: f.status });
                        }}
                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  {f.description && (
                    <CardDescription className="line-clamp-2">{f.description}</CardDescription>
                  )}
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground flex gap-4">
                  <span>{f.nodeCount} passos</span>
                  <span>{f.runCount} execuções</span>
                  <span>v{f.version}</span>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <DialogoExcluirFluxo
        fluxo={paraExcluir}
        onFechar={() => setParaExcluir(null)}
        onExcluido={() => setParaExcluir(null)}
      />
    </div>
  );
}

// ============================================
// Editor (canvas)
// ============================================

function EditorDeFluxo({ flowId, onVoltar }: { flowId: string; onVoltar: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: flow, isLoading } = useQuery({
    queryKey: ['flow', flowId],
    queryFn: () => flowsService.get(flowId),
  });
  const { data: catalogo } = useQuery({ queryKey: ['flow-catalog'], queryFn: flowsService.catalog });
  const { data: agentes } = useQuery({ queryKey: ['ai-agents'], queryFn: aiService.listAgents });
  // Para o bloco de base: sem a lista, o seletor dele fica vazio.
  const { data: bases } = useQuery({ queryKey: ['ai-bases'], queryFn: aiService.listBases });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selecionado, setSelecionado] = useState<string | null>(null);
  const [sujo, setSujo] = useState(false);
  const [excluindo, setExcluindo] = useState(false);

  const { resolvedTheme } = useTheme();
  const nodeTypes = useMemo(() => ({ passo: FlowNodeCard }), []);
  const edgeTypes = useMemo<EdgeTypes>(() => ({ fluxo: ArestaDoFluxo }), []);

  /**
   * Injeta o NOME do agente no cartão. Fica em useMemo (e não no estado) pra
   * que carregar a lista de agentes depois não zere edições não salvas do
   * canvas.
   */
  // Blocos com os campos abertos. Bloco novo nasce aberto e fecha sozinho
  // depois de configurado — ensina o que existe sem deixar o desenho cheio.
  const [abertos, setAbertos] = useState<Set<string>>(new Set());
  /** Bloco cujo campo grande (o prompt) está aberto sobre o canvas. */
  const [ampliado, setAmpliado] = useState<string | null>(null);
  const [memoriaDe, setMemoriaDe] = useState<string | null>(null);

  /*
    Quem está ampliado, e quem é o agente da memória aberta.

    Lê de `nodes` a cada render em vez de guardar o nó no estado: guardar
    congelaria a configuração no instante do clique, e escolher um agente
    dentro do painel precisa se refletir no bloco na hora.
  */
  const noAmpliado = useMemo(() => {
    const n = nodes.find((x) => x.id === ampliado);
    if (!n) return null;
    return {
      id: n.id,
      tipo: String(n.data.tipo ?? ''),
      config: (n.data.config ?? {}) as Record<string, unknown>,
    };
  }, [nodes, ampliado]);

  const agenteDaMemoria = useMemo(() => {
    const n = nodes.find((x) => x.id === memoriaDe);
    return textoDaConfig((n?.data.config ?? {}) as Record<string, unknown>, 'agentId');
  }, [nodes, memoriaDe]);
  const [abaPainel, setAbaPainel] = useState<'testar' | 'execucoes'>('testar');

  // Resultado do último teste, por nó. Vazio = nenhum teste ainda.
  const [execPorNo, setExecPorNo] = useState<StatusPorNo>({});
  const [testeAberto, setTesteAberto] = useState(false);
  const houveTeste = Object.keys(execPorNo).length > 0;

  const infoPorTipo = useMemo(() => {
    const m = new Map<string, NodeTypeInfo>();
    catalogo?.nodes.forEach((n) => m.set(n.type, n));
    return m;
  }, [catalogo]);

  /*
    As três derivações abaixo têm cache por referência de propósito.

    Arrastar um bloco dispara `onNodesChange` a 60-120 Hz. `applyNodeChanges`
    preserva a referência dos nós que não se mexeram, e o React Flow usa
    exatamente essa referência (`checkEquality` em `adoptUserNodes`) para pular
    a reconstrução do nó interno e o re-render do wrapper. Recriar o objeto de
    todo nó a cada frame — que é o que um `nodes.map(n => ({...n}))` faz —
    desmonta essa otimização inteira: quinze blocos re-renderizavam para um
    único ser arrastado. Devolver o MESMO objeto quando nada derivado mudou
    devolve o fast-path.
  */
  const portasRef = useRef(new Map<string, string[]>());
  const portasPorNo = useMemo(() => {
    const anterior = portasRef.current;
    const nova = new Map<string, string[]>();
    for (const n of nodes) {
      const d = n.data as FlowNodeData;
      const p = portasDoNo(d.tipo ?? '', d.config ?? {}, infoPorTipo.get(d.tipo ?? ''), agentes);
      if (p) nova.set(n.id, p);
    }
    if (nova.size === anterior.size) {
      let igual = true;
      for (const [id, portas] of nova) {
        const antes = anterior.get(id);
        if (!antes || antes.join('|') !== portas.join('|')) {
          igual = false;
          break;
        }
      }
      // Mapa estável = as arestas exibidas não recalculam a cada frame de arraste.
      if (igual) return anterior;
    }
    portasRef.current = nova;
    return nova;
  }, [nodes, agentes, infoPorTipo]);

  /**
   * Agentes que ESTE fluxo ligou a uma base, no desenho salvo. É o critério
   * pra desligar ao salvar sem a linha: só se desfaz o que o próprio fluxo
   * fez. Um agente usado também na cadência de follow-up perderia a base
   * toda vez que alguém salvasse a cadência — que nunca teve bloco de base.
   */
  const agentesLigadosNoSalvo = useMemo(() => {
    const ligados = new Set<string>();
    if (!flow) return ligados;
    for (const [agentId, baseId] of basesDesenhadas(flow.graph.nodes, flow.graph.edges)) {
      if (baseId) ligados.add(agentId);
    }
    return ligados;
  }, [flow]);

  /** Agente → base, pelas linhas do canvas como estão AGORA (salvas ou não). */
  const basesNoCanvas = useMemo(
    () =>
      basesDesenhadas(
        nodes.map((n) => ({
          id: n.id,
          type: (n.data as FlowNodeData).tipo ?? '',
          config: (n.data as FlowNodeData).config,
        })),
        edges
      ),
    [nodes, edges]
  );

  const cacheNos = useRef(new Map<string, { origem: Node; saida: Node }>());
  const nodesExibidos = useMemo(() => {
    const cache = cacheNos.current;
    const vistos = new Set<string>();
    const nomeDaBase = (id: string | null) =>
      id ? (bases?.find((b) => b.id === id)?.name ?? null) : null;
    const saida = nodes.map((n) => {
      vistos.add(n.id);
      const d = n.data as FlowNodeData;
      const exec = execPorNo[n.id];
      const portas = portasPorNo.get(n.id);
      const rodaAgente = TIPOS_DE_AGENTE.has(d.tipo ?? '');
      const agentId = rodaAgente ? textoDaConfig(d.config ?? {}, 'agentId') : null;
      const agente = rodaAgente ? agentes?.find((a) => a.id === agentId) : undefined;
      const agenteNome = rodaAgente ? (agente?.name ?? null) : undefined;
      const base = rodaAgente
        ? baseDoBloco({
            agentId,
            agente,
            desenhada: basesNoCanvas,
            ligadaNoSalvo: agentesLigadosNoSalvo,
            nomeDaBase,
          })
        : undefined;

      const anterior = cache.get(n.id);
      if (anterior && anterior.origem === n) {
        const antes = anterior.saida.data as FlowNodeData;
        if (
          antes.exec === exec &&
          antes.execRodou === houveTeste &&
          antes.agenteNome === agenteNome &&
          antes.base?.nome === base?.nome &&
          antes.base?.aviso === base?.aviso &&
          antes.portas === portas
        ) {
          return anterior.saida;
        }
      }

      const saidaDoNo: Node = {
        ...n,
        data: {
          ...d,
          exec,
          execRodou: houveTeste,
          // As portas saem do catálogo e — para "Atender com IA" — do schema do
          // PRÓPRIO agente: quem monta declara as rotas dele uma vez e o bloco
          // passa a ter uma saída por rota. O motor casa aresta por nome.
          portas,
          ...(rodaAgente ? { agenteNome, base, temProblema: !agentId } : {}),
        },
      };
      cache.set(n.id, { origem: n, saida: saidaDoNo });
      return saidaDoNo;
    });
    for (const id of [...cache.keys()]) if (!vistos.has(id)) cache.delete(id);
    return saida;
  }, [nodes, agentes, bases, execPorNo, houveTeste, portasPorNo, basesNoCanvas, agentesLigadosNoSalvo]);

  const cacheArestas = useRef(new Map<string, { origem: Edge; saida: Edge }>());
  const edgesExibidas = useMemo(() => {
    const cache = cacheArestas.current;
    const vistas = new Set<string>();
    const saida = edges.map((e) => {
      vistas.add(e.id);
      const porta = portaDaAresta(ramoDaAresta(e), portasPorNo.get(e.source));
      const anterior = cache.get(e.id);
      if (anterior && anterior.origem === e && anterior.saida.sourceHandle === porta) {
        return anterior.saida;
      }
      const nova = e.sourceHandle === porta ? e : { ...e, sourceHandle: porta };
      cache.set(e.id, { origem: e, saida: nova });
      return nova;
    });
    for (const id of [...cache.keys()]) if (!vistas.has(id)) cache.delete(id);
    return saida;
  }, [edges, portasPorNo]);

  /** O tipo de cada bloco — usado para recusar ligação que o motor não executaria. */
  const tiposPorNo = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of nodes) m.set(n.id, (n.data as FlowNodeData).tipo ?? '');
    return m;
  }, [nodes]);

  // Carrega o grafo salvo para dentro do canvas.
  //
  // `sujoRef` e não `sujo`: o efeito não pode depender do estado sujo, senão
  // recarregaria o grafo no instante em que ele volta a false — mas precisa
  // LER o valor atual.
  const sujoRef = useRef(false);
  sujoRef.current = sujo;

  useEffect(() => {
    if (!flow) return;
    // O React Query revalida ao focar a janela. Sem esta guarda, trocar de
    // aba e voltar no meio de uma edição jogava fora o que estava digitado e
    // ainda zerava o aviso de "não salvo" — o usuário perdia o trabalho e não
    // ficava sabendo. Já era bug latente; com campos no canvas passa a ser
    // frequente, porque o tempo digitando aumenta muito.
    if (sujoRef.current) return;
    setNodes(
      flow.graph.nodes.map((n, i) => ({
        id: n.id,
        type: 'passo',
        position: n.position ?? { x: 320, y: i * 150 },
        data: { label: n.label ?? n.type, tipo: n.type, config: n.config ?? {} },
      })) as Node[]
    );
    const tipoPorId = new Map(flow.graph.nodes.map((n) => [n.id, n.type]));
    setEdges(
      flow.graph.edges.map((e) => {
        const tipoDaOrigem = tipoPorId.get(e.source) ?? '';
        const deFonte = ehFonte(tipoDaOrigem);
        return {
          ...(deFonte ? ESTILO_ARESTA_FONTE : ESTILO_ARESTA),
          id: e.id,
          source: e.source,
          target: e.target,
          // A entrada é derivada do tipo da origem: é o que traz a aresta
          // antiga (salva sem handle) pra entrada de conhecimento.
          targetHandle: entradaDaAresta(tipoDaOrigem),
          // `branch` é a verdade; a porta de saída é derivada dele em
          // `edgesExibidas`, que espera o catálogo chegar em vez de congelar a
          // ligação numa porta que ainda não existia.
          data: { branch: e.branch ?? null },
        };
      }) as Edge[]
    );
    setSujo(false);
  }, [flow, setNodes, setEdges]);

  /**
   * A porta de onde o cabo saiu É o ramo.
   *
   * Isto era um bug de dados, não de estética: o `sourceHandle` era ignorado e
   * toda ligação nascia com `branch: null`. O motor trata ramo nulo como a
   * saída padrão — então puxar o cabo da porta "humano" gravava "saída padrão",
   * e a rota desenhada não era a rota que rodava.
   */
  const onConnect = useCallback(
    (c: Connection) => {
      const branch = c.sourceHandle && c.sourceHandle !== 'default' ? c.sourceHandle : null;
      const estilo = ehFonte(tiposPorNo.get(c.source) ?? '') ? ESTILO_ARESTA_FONTE : ESTILO_ARESTA;
      setEdges((eds) => addEdge({ ...estilo, ...c, data: { branch } }, eds));
      setSujo(true);
    },
    [setEdges, tiposPorNo]
  );

  /**
   * Recusa a ligação que o motor não executaria, ANTES de soltar.
   *
   * Sem isto o React Flow aceita tudo — inclusive um bloco ligado em si mesmo,
   * que o modo "strict" não checa — e o erro só aparece na validação do backend
   * na hora de ativar.
   */
  const conexaoValida = useCallback(
    (c: Connection | Edge): boolean => {
      if (!c.source || !c.target || c.source === c.target) return false;
      // Ligação que JÁ EXISTE não entra de novo. O `addEdge` do React Flow até
      // deduplica, mas compara `targetHandle` com `===` — e a aresta carregada
      // do grafo salvo vem `undefined` enquanto a criada ao soltar em cima do
      // bloco vem `null`. A duplicata passava, ficava empilhada exatamente
      // sobre a original e a faixa de clique dela cobria a lixeira de baixo.
      // Aqui a comparação é pelo que importa pro motor: origem, porta e
      // destino. E como `isValidConnection` roda com o cabo no ar, o alvo já
      // acende como inválido antes de soltar — como no n8n.
      const porta = (h: string | null | undefined) => (h && h !== 'default' ? h : 'default');
      const jaExiste = edges.some(
        (e) => e.source === c.source && e.target === c.target && porta(e.sourceHandle) === porta(c.sourceHandle)
      );
      if (jaExiste) return false;
      // Quem pode ligar em quem, e por qual entrada: regra pura em `portas.ts`.
      return ligacaoPermitida(
        tiposPorNo.get(c.source) ?? '',
        tiposPorNo.get(c.target) ?? '',
        c.targetHandle
      );
    },
    [tiposPorNo, edges]
  );

  /**
   * Soltar o cabo EM CIMA do bloco liga — não só na bolinha de entrada.
   *
   * O React Flow só considera portas dentro do raio de captura. Num card de
   * 300px de altura o único alvo era o topo-centro: soltar no meio do bloco não
   * fazia nada, em silêncio. No n8n você solta em qualquer lugar do nó.
   */
  const onConnectEnd = useCallback(
    (evento: MouseEvent | TouchEvent, estado: FinalConnectionState) => {
      if (estado.isValid || !estado.fromNode || estado.fromHandle?.type !== 'source') return;
      const alvo = (evento.target as Element | null)
        ?.closest?.('.react-flow__node')
        ?.getAttribute('data-id');
      if (!alvo) return;
      const c: Connection = {
        source: estado.fromNode.id,
        target: alvo,
        sourceHandle: estado.fromHandle.id ?? null,
        // Soltar a base em cima do agente precisa mirar a entrada de
        // conhecimento: com a entrada do fluxo, `conexaoValida` recusaria — e
        // soltar em cima do bloco é como se liga a base hoje.
        targetHandle: entradaDaAresta(tiposPorNo.get(estado.fromNode.id) ?? ''),
      };
      if (!conexaoValida(c)) return;
      onConnect(c);
    },
    [conexaoValida, onConnect, tiposPorNo]
  );

  /**
   * Arrastar a ponta de um cabo para outro destino.
   *
   * Sem `onReconnect` definido o React Flow nem desenha as âncoras de religar —
   * o recurso fica inerte. Somado à ausência de tecla de apagar, corrigir a
   * topologia exigia apagar um dos blocos e montar de novo.
   */
  const onReconnect = useCallback(
    (antiga: Edge, nova: Connection) => {
      const branch = nova.sourceHandle && nova.sourceHandle !== 'default' ? nova.sourceHandle : null;
      setEdges((es) => reconnectEdge({ ...antiga, data: { branch } }, nova, es));
      setSujo(true);
    },
    [setEdges]
  );

  const paraGrafo = useCallback((): FlowGraph => {
    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        type: String((n.data as Record<string, unknown>).tipo),
        label: String((n.data as Record<string, unknown>).label ?? ''),
        config: ((n.data as Record<string, unknown>).config ?? {}) as Record<string, unknown>,
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        branch: ((e.data as Record<string, unknown> | undefined)?.branch as string | null) ?? null,
      })),
    };
  }, [nodes, edges]);

  /**
   * A aresta da base até o agente vira o `knowledgeBaseId` dele.
   *
   * É o que faz o bloco de base ser configuração de verdade e não desenho:
   * quem liga a linha está escolhendo a base daquele agente. O campo já existe
   * no agente desde sempre — só nunca tinha aparecido no canvas.
   */
  const ligarBasesAosAgentes = useCallback(async () => {
    const pendentes: Promise<unknown>[] = [];

    for (const [agentId, baseId] of basesNoCanvas) {
      if (!baseId) continue;
      // Só grava quando mudou — salvar o fluxo não deve escrever em todo
      // agente do desenho a cada clique.
      const atual = agentes?.find((a) => a.id === agentId);
      if (atual?.knowledgeBaseId === baseId) continue;
      pendentes.push(aiService.updateAgent(agentId, { knowledgeBaseId: baseId }));
    }

    // Linha removida = base desligada. Antes isto só ligava, nunca zerava: a
    // base ficava presa no agente depois de apagar a linha, e a tela dizia que
    // não havia base enquanto a busca continuava consultando uma. Só desliga
    // o que este fluxo ligou — e só se NENHUM bloco deste agente tem linha.
    for (const agentId of agentesLigadosNoSalvo) {
      if (basesNoCanvas.get(agentId)) continue;
      const atual = agentes?.find((a) => a.id === agentId);
      if (!atual?.knowledgeBaseId) continue;
      pendentes.push(aiService.updateAgent(agentId, { knowledgeBaseId: null }));
    }

    if (pendentes.length > 0) {
      await Promise.all(pendentes);
      qc.invalidateQueries({ queryKey: ['ai-agents'] });
    }
  }, [basesNoCanvas, agentesLigadosNoSalvo, agentes, qc]);

  const salvar = useMutation({
    mutationFn: async () => {
      const r = await flowsService.update(flowId, { graph: paraGrafo() });
      await ligarBasesAosAgentes();
      return r;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['flow', flowId] });
      qc.invalidateQueries({ queryKey: ['flows'] });
      setSujo(false);
      // "Salvo" era lido como "ligado": o rascunho salvo não atende ninguém,
      // e nada dizia isso na hora em que a pessoa achava que tinha terminado.
      toast(
        flow?.status === 'draft'
          ? { title: 'Salvo', description: 'Para atender de verdade, ative em Sombra ou Ativar.' }
          : { title: 'Fluxo salvo' }
      );
    },
    onError: (e: Error) =>
      toast({ title: 'Não foi possível salvar', description: e.message, variant: 'destructive' }),
  });

  const trocarStatus = useMutation({
    mutationFn: (status: FlowStatus) => flowsService.setStatus(flowId, status),
    onSuccess: (f) => {
      qc.invalidateQueries({ queryKey: ['flow', flowId] });
      qc.invalidateQueries({ queryKey: ['flows'] });
      toast({
        title: `Fluxo em ${STATUS_INFO[f.status].label.toLowerCase()}`,
        description: STATUS_INFO[f.status].ajuda,
      });
    },
    onError: (e: Error) =>
      toast({ title: 'Não foi possível publicar', description: e.message, variant: 'destructive' }),
  });

  const adicionarNo = (tipo: string) => {
    const info = infoPorTipo.get(tipo);
    const id = `${tipo.split('.')[1] ?? 'no'}-${Date.now().toString(36)}`;
    setNodes((ns) => [
      ...ns,
      {
        id,
        type: 'passo',
        position: { x: 700, y: 80 + ns.length * 60 },
        data: { label: info?.label ?? tipo, tipo, config: {} },
      } as Node,
    ]);
    // Nasce ABERTO: quem soltou o bloco precisa ver o que dá pra ajustar.
    // Fecha quando o usuário quiser — ou nunca, se ele preferir assim.
    setAbertos((a) => new Set(a).add(id));
    setSujo(true);
  };

  const atualizarConfig = (nodeId: string, config: Record<string, unknown>, label?: string) => {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, config, ...(label !== undefined ? { label } : {}) } }
          : n
      )
    );
    setSujo(true);
  };

  /**
   * O que o bloco no canvas pode fazer. Estável via useCallback: sem isso o
   * contexto mudaria de referência a cada render e nenhum bloco memoizado
   * seguraria nada.
   */
  const editorCtx = useMemo(
    () => ({
      setConfig: (nodeId: string, chave: string, valor: unknown) => {
        // Trocar o TIPO do gatilho não é configuração — é outro nó. Vem por
        // aqui porque é o mesmo gesto pro usuário (um seletor no bloco), e
        // separar em outro canal só espalharia a mesma coisa.
        if (chave === '__trocarTipo') {
          setNodes((ns) =>
            ns.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      tipo: valor,
                      label:
                        valor === 'trigger.webhook' ? 'Chamada externa' : 'Mensagem recebida',
                      config: {},
                    },
                  }
                : n
            )
          );
          setSujo(true);
          return;
        }
        setNodes((ns) =>
          ns.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: {
                    ...n.data,
                    config: { ...((n.data.config ?? {}) as Record<string, unknown>), [chave]: valor },
                  },
                }
              : n
          )
        );
        setSujo(true);
      },
      setLabel: (nodeId: string, label: string) => {
        setNodes((ns) => ns.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, label } } : n)));
        setSujo(true);
      },
      alternarAberto: (nodeId: string) =>
        setAbertos((a) => {
          const novo = new Set(a);
          if (novo.has(nodeId)) novo.delete(nodeId);
          else novo.add(nodeId);
          return novo;
        }),
      remover: (nodeId: string) => {
        setNodes((ns) => ns.filter((n) => n.id !== nodeId));
        setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
        setSujo(true);
      },
      removerAresta: (edgeId: string) => {
        setEdges((es) => es.filter((e) => e.id !== edgeId));
        setSujo(true);
      },
      ampliar: (nodeId: string) => setAmpliado(nodeId),
      abrirMemoria: (nodeId: string) => setMemoriaDe(nodeId),
      agentes: agentes ?? [],
      bases: bases ?? [],
      abertos,
    }),
    [setNodes, setEdges, agentes, bases, abertos]
  );

  const removerNo = (nodeId: string) => {
    setNodes((ns) => ns.filter((n) => n.id !== nodeId));
    setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
    setSelecionado(null);
    setSujo(true);
  };

  if (isLoading || !flow) return <div className="p-6 text-muted-foreground">Carregando…</div>;

  const info = STATUS_INFO[flow.status];
  const problemas = flow.problemas ?? [];
  const noSelecionado = nodes.find((n) => n.id === selecionado);
  // Do desenho SALVO, que é o que o simulador roda: o bloco que acende como
  // "aguardando" durante a janela tem que ser o mesmo que o motor lê.
  const noDeAgrupamento = flow.graph.nodes.find((n) => n.type === 'buffer.debounce')?.id ?? null;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Barra */}
      <div className="border-b px-4 py-3 flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={onVoltar}>
          <ArrowLeft className="w-4 h-4 mr-1" /> Fluxos
        </Button>
        <div className="font-medium">{flow.name}</div>
        <Badge variant="outline" className={info.classe}>
          {info.label}
        </Badge>
        <span className="text-xs text-muted-foreground">v{flow.version}</span>

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => salvar.mutate()} disabled={!sujo || salvar.isPending}>
            <Save className="w-4 h-4 mr-1" />
            {salvar.isPending ? 'Salvando…' : sujo ? 'Salvar' : 'Salvo'}
          </Button>
          {flow.status !== 'shadow' && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => trocarStatus.mutate('shadow')}
              disabled={trocarStatus.isPending}
            >
              <Eye className="w-4 h-4 mr-1" /> Modo sombra
            </Button>
          )}
          {flow.status !== 'active' ? (
            <Button size="sm" onClick={() => trocarStatus.mutate('active')} disabled={trocarStatus.isPending}>
              <Play className="w-4 h-4 mr-1" /> Ativar
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => trocarStatus.mutate('draft')}
              disabled={trocarStatus.isPending}
            >
              <Pause className="w-4 h-4 mr-1" /> Pausar
            </Button>
          )}

          <Button
            size="sm"
            variant={testeAberto ? 'secondary' : 'outline'}
            onClick={() => setTesteAberto((v) => !v)}
            title="Conversar com o fluxo e ver os blocos acenderem"
          >
            <FlaskConical className="w-4 h-4 mr-1" /> Testar
          </Button>

          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setExcluindo(true)}
            title="Excluir este fluxo"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <DialogoExcluirFluxo
        fluxo={excluindo ? { id: flow.id, name: flow.name, status: flow.status } : null}
        onFechar={() => setExcluindo(false)}
        // O fluxo aberto deixou de existir: voltar para a lista é o único
        // estado honesto — ficar no editor mostraria um desenho fantasma.
        onExcluido={() => {
          setExcluindo(false);
          onVoltar();
        }}
      />

      {/* Aviso do modo */}
      <div className="px-4 py-2 text-xs bg-muted/40 border-b text-muted-foreground">
        {info.ajuda}
      </div>

      {problemas.length > 0 && (
        <div className="px-4 py-2 border-b bg-destructive/5 text-destructive text-xs flex gap-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <div className="font-medium">Resolva antes de publicar:</div>
            <ul className="list-disc ml-4 mt-0.5">
              {problemas.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* Paleta */}
        <div className="w-56 border-r p-3 overflow-y-auto shrink-0">
          <div className="text-xs font-medium text-muted-foreground mb-2">Adicionar passo</div>
          <div className="space-y-3">
            {GRUPOS.map((grupo) => {
              const doGrupo = (catalogo?.nodes ?? []).filter((n) => grupo.tipos.includes(n.type));
              if (doGrupo.length === 0) return null;
              const passos = doGrupo.map((n) => (
                <button
                  key={n.type}
                  onClick={() => adicionarNo(n.type)}
                  className={`w-full text-left text-xs rounded-md border px-2 py-1.5 transition-colors ${
                    n.type === 'ai.atender'
                      ? 'border-primary/60 bg-primary/10 hover:bg-primary/15'
                      : 'hover:border-primary/40 hover:bg-muted/40'
                  }`}
                  title={n.description}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {n.mutates && <Zap className="w-3 h-3 text-amber-500 shrink-0" />}
                    {n.label}
                  </div>
                </button>
              ));

              const corpo = (
                <>
                  {passos}
                  {grupo.nota && (
                    <p className="text-[10px] text-muted-foreground/70 leading-snug pt-0.5">
                      {grupo.nota}
                    </p>
                  )}
                </>
              );

              if (grupo.recolhido) {
                return (
                  <details key={grupo.titulo} className="space-y-1 group">
                    <summary className="text-[10px] uppercase tracking-wider text-muted-foreground/70 px-0.5 cursor-pointer select-none list-none flex items-center gap-1 hover:text-muted-foreground">
                      <ChevronRight className="w-3 h-3 transition-transform group-open:rotate-90" />
                      {grupo.titulo}
                    </summary>
                    <div className="space-y-1 pt-1">{corpo}</div>
                  </details>
                );
              }

              return (
                <div key={grupo.titulo} className="space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 px-0.5">
                    {grupo.titulo}
                  </div>
                  {corpo}
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground mt-3 leading-relaxed">
            <Zap className="w-3 h-3 inline text-amber-500" /> age para fora (envia, altera a
            conversa). No modo sombra esses passos são simulados.
          </p>
        </div>

        {/* Canvas */}
        <div className="flex-1 min-w-0">
          <EditorDeFluxoContext.Provider value={editorCtx}>
          <ReactFlow
            nodes={nodesExibidos}
            edges={edgesExibidas}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
            onNodesChange={(c) => {
              onNodesChange(c);
              if (c.some((x) => x.type === 'position' || x.type === 'remove')) setSujo(true);
            }}
            onEdgesChange={(c) => {
              onEdgesChange(c);
              // Só selecionar uma ligação não é edição. Sujar o fluxo aqui
              // acendia "Salvar" a cada clique no desenho, e um aviso de
              // não-salvo que acende sozinho deixa de significar alguma coisa.
              if (c.some((x) => x.type !== 'select')) setSujo(true);
            }}
            onConnect={onConnect}
            onConnectEnd={onConnectEnd}
            onReconnect={onReconnect}
            isValidConnection={conexaoValida}
            onPaneClick={() => setSelecionado(null)}
            onNodeDoubleClick={(ev, n) => {
              // Duplo clique dentro de um campo é seleção de palavra, não
              // "abrir o bloco" — sem esta guarda selecionar uma palavra no
              // prompt fechava os campos por baixo do cursor.
              if ((ev.target as Element | null)?.closest?.('.nodrag')) return;
              editorCtx.alternarAberto(n.id);
            }}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            proOptions={{ hideAttribution: true }}
            /*
              A mira. O raio de captura padrão são 20 unidades de fluxo — com o
              canvas afastado isso vira menos pixels de tela do que a própria
              bolinha, e a porta some justo quando está mais difícil de acertar.
              O n8n usa 60, o Langflow 30.
            */
            connectionRadius={40}
            connectionLineType={ConnectionLineType.SmoothStep}
            connectionLineStyle={{ stroke: 'hsl(var(--primary))', strokeWidth: 2.5 }}
            reconnectRadius={16}
            /*
              Tolerância de gesto. Com o padrão (1px) um tremor de mouse já
              contava como arraste — e acendia "Salvar" sem ninguém ter movido
              nada. O clique no canvas e no bloco ganham a mesma folga, que é o
              que faz o trackpad parar de perder cliques.
            */
            nodeDragThreshold={3}
            connectionDragThreshold={2}
            paneClickDistance={4}
            nodeClickDistance={4}
            snapToGrid
            snapGrid={[16, 16]}
            /* Duplo clique abre o bloco (acima) em vez de dar zoom no canvas. */
            zoomOnDoubleClick={false}
            /* Dois dedos no trackpad passam a mover o canvas; o zoom fica no
               pinça e no Ctrl/Cmd + rolagem, como no n8n e no Figma. */
            panOnScroll
            zoomActivationKeyCode={['Meta', 'Control']}
            autoPanSpeed={20}
            /* Explícito de propósito, embora seja o default: já foi ligado uma vez
               "pra destacar", e com o bloco selecionado as arestas dele subiam
               pra uma camada ACIMA dos rótulos — tapando a lixeira das outras
               onde cruzam. Aresta nunca fica acima de bloco; elevar só custa. */
            elevateEdgesOnSelect={false}
            /*
              Backspace NÃO apaga bloco.
              A guarda do React Flow só reconhece input/select/textarea
              NATIVOS — o Select do shadcn é um <button role="combobox">, e
              apagar um caractere num campo desses removeria o bloco inteiro,
              em silêncio. Remover é pelo botão dentro do bloco; remover
              ligação é pelo "x" que aparece sobre ela.
            */
            deleteKeyCode={null}
          >
            <Background gap={16} size={1} />
            <Controls showInteractive={false} />
            {/* Canto SUPERIOR direito de propósito. Embaixo à direita ele cobria
                a porta de saída do último bloco de um fluxo que cresce pra baixo
                — soltar cabo ali ainda funcionava (é geométrico), mas COMEÇAR um
                cabo daquela porta, não. Medido no navegador: alvo efetivo 0px. */}
            <MiniMap
              position="top-right"
              pannable
              zoomable
              className="!bg-card !border !border-border rounded-md"
              maskColor="hsl(var(--muted) / 0.6)"
              nodeColor="hsl(var(--muted-foreground))"
            />
          </ReactFlow>
          </EditorDeFluxoContext.Provider>

          {/*
            Os painéis que aposentaram as abas "Agentes IA" e "Conhecimento".
            Abrem SOBRE o canvas: o desenho continua atrás, e fechar devolve
            você exatamente onde estava. Montar um agente inteiro — prompt,
            memória e base — deixou de exigir sair da página.

            Ficam fora do Provider de propósito: são Dialog em portal, não
            precisam do contexto do bloco, e gravam direto na API.
          */}
          {noAmpliado && TIPOS_DE_AGENTE.has(noAmpliado.tipo) && (
            <PainelAgente
              agentId={textoDaConfig(noAmpliado.config, 'agentId')}
              onEscolher={(id) => editorCtx.setConfig(noAmpliado.id, 'agentId', id)}
              onFechar={() => setAmpliado(null)}
            />
          )}

          {noAmpliado && noAmpliado.tipo === 'source.knowledge' && (
            <PainelBase
              baseId={textoDaConfig(noAmpliado.config, 'baseId')}
              onEscolher={(id) => editorCtx.setConfig(noAmpliado.id, 'baseId', id)}
              onFechar={() => setAmpliado(null)}
            />
          )}

          {agenteDaMemoria && (
            <PainelMemoria agentId={agenteDaMemoria} onFechar={() => setMemoriaDe(null)} />
          )}
        </div>

        {/* Simulador embutido — a conversa ao lado do desenho */}
        {testeAberto && (
          <div className="w-[22rem] border-l shrink-0 flex flex-col min-h-0 bg-card">
            {/* Testar e Execuções no mesmo painel: testar é o que você acabou
                de fazer, Execuções é o que já aconteceu. Separar em telas
                obrigava a sair do desenho pra responder a mesma pergunta. */}
            <div className="flex border-b px-3 gap-4 shrink-0">
              <button
                type="button"
                onClick={() => setAbaPainel('testar')}
                className={`py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                  abaPainel === 'testar'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Testar
              </button>
              <button
                type="button"
                onClick={() => setAbaPainel('execucoes')}
                className={`py-2.5 text-xs font-medium border-b-2 -mb-px transition-colors ${
                  abaPainel === 'execucoes'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                Execuções
              </button>
            </div>

            {abaPainel === 'execucoes' ? (
              <ExecucoesDoFluxo flowId={flowId} onPassos={setExecPorNo} />
            ) : (
            <SimuladorChat
              flowId={flowId}
              onPassos={setExecPorNo}
              noDeAgrupamento={noDeAgrupamento}
              onTurno={(t) => {
                // Fluxo que parou antes de responder: o motivo vale um aviso,
                // porque o bloco aceso sozinho não diz o porquê.
                if (!t.resposta && t.stopReason) {
                  toast({
                    title: 'O fluxo parou antes de responder',
                    description: t.stopReason,
                  });
                }
              }}
              compacto
            />
            )}
            {houveTeste && (
              <div className="border-t px-3 py-2 text-[10px] text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
                <span className="text-emerald-600 dark:text-emerald-400">■ passou</span>
                <span className="text-sky-600 dark:text-sky-400">■ aguardando / pulado no simulador</span>
                <span className="text-amber-600 dark:text-amber-400">■ parou aqui</span>
                <span className="text-destructive">■ erro</span>
                <span className="opacity-50">■ não passou por aqui</span>
              </div>
            )}
          </div>
        )}

        {/* Painel do nó */}
        {noSelecionado && (
          <PainelDoNo
            node={noSelecionado}
            info={infoPorTipo.get(String((noSelecionado.data as Record<string, unknown>).tipo))}
            agentes={agentes ?? []}
            onChange={(config, label) => atualizarConfig(noSelecionado.id, config, label)}
            onRemove={() => removerNo(noSelecionado.id)}
            onFechar={() => setSelecionado(null)}
          />
        )}
      </div>
    </div>
  );
}

// ============================================
// Painel de configuração do nó
// ============================================

function PainelDoNo({
  node,
  info,
  agentes,
  onChange,
  onRemove,
  onFechar,
}: {
  node: Node;
  info?: NodeTypeInfo;
  agentes: { id: string; name: string }[];
  onChange: (config: Record<string, unknown>, label?: string) => void;
  onRemove: () => void;
  onFechar: () => void;
}) {
  const dados = node.data as Record<string, unknown>;
  const tipo = String(dados.tipo);
  const config = (dados.config ?? {}) as Record<string, unknown>;
  const label = String(dados.label ?? '');

  const set = (chave: string, valor: unknown) => onChange({ ...config, [chave]: valor });

  return (
    <div className="w-80 border-l p-4 overflow-y-auto shrink-0 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-medium text-sm">{info?.label ?? tipo}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{info?.description}</div>
        </div>
        <Button variant="ghost" size="sm" onClick={onFechar}>
          ✕
        </Button>
      </div>

      <Separator />

      <div className="space-y-1.5">
        <Label className="text-xs">Nome do passo</Label>
        <Input value={label} onChange={(e) => onChange(config, e.target.value)} className="h-8" />
      </div>

      {/* Os campos vivem em CamposDoNo: os mesmos aqui e dentro do bloco. */}
      <CamposDoNo tipo={tipo} config={config} agentes={agentes} set={set} />

      {info && info.branches.length > 1 && (
        <div className="text-[11px] text-muted-foreground border rounded-md p-2">
          <div className="font-medium mb-1">Saídas deste passo</div>
          {info.branches.map((b) => (
            <div key={b.key}>
              <code>{b.key}</code> — {b.label || 'padrão'}
            </div>
          ))}
        </div>
      )}

      {!tipo.startsWith('trigger.') && (
        <>
          <Separator />
          <Button variant="ghost" size="sm" className="text-destructive w-full" onClick={onRemove}>
            <Trash2 className="w-4 h-4 mr-1" /> Remover passo
          </Button>
        </>
      )}
    </div>
  );
}
