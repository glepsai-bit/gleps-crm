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
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type Connection,
  MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTheme } from 'next-themes';
import { FlowNodeCard, type FlowNodeData } from '@/components/flow/FlowNodeCard';
import { SimuladorChat, type StatusPorNo } from '@/components/flow/SimuladorChat';
import { CamposDoNo } from '@/components/flow/CamposDoNo';
import { ExecucoesDoFluxo } from '@/components/flow/ExecucoesDoFluxo';
import { EditorDeFluxoContext } from '@/components/flow/EditorDeFluxoContext';
import {
  ArrowLeft,
  Plus,
  Save,
  Play,
  Eye,
  Pause,
  Trash2,
  AlertTriangle,
  Workflow,
  Zap,
  Clock,
  FlaskConical,
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
    ajuda: 'Não roda. Monte e teste à vontade.',
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

function ListaDeFluxos({ onAbrir }: { onAbrir: (id: string) => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();

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
                    <Badge variant="outline" className={info.classe}>
                      {info.label}
                    </Badge>
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

  const { resolvedTheme } = useTheme();
  const nodeTypes = useMemo(() => ({ passo: FlowNodeCard }), []);

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
  const [abaPainel, setAbaPainel] = useState<'testar' | 'execucoes'>('testar');

  // Resultado do último teste, por nó. Vazio = nenhum teste ainda.
  const [execPorNo, setExecPorNo] = useState<StatusPorNo>({});
  const [testeAberto, setTesteAberto] = useState(false);
  const houveTeste = Object.keys(execPorNo).length > 0;

  const nodesExibidos = useMemo(
    () =>
      nodes.map((n) => {
        const d = n.data as FlowNodeData;
        const exec = execPorNo[n.id];
        const base = { ...d, exec, execRodou: houveTeste };
        if (d.tipo !== 'ai.agent' && d.tipo !== 'ai.atender') return { ...n, data: base };
        const agentId = (d.config as { agentId?: string } | undefined)?.agentId;
        const agente = agentes?.find((a) => a.id === agentId);
        return {
          ...n,
          data: {
            ...base,
            agenteNome: agente?.name ?? null,
            temProblema: !agentId,
            // As portas saem do schema do PRÓPRIO agente: quem monta declara
            // as rotas dele uma vez, e o bloco passa a ter uma saída por rota.
            // Nada disso precisou de backend — o motor casa aresta por nome.
            portas: d.tipo === 'ai.atender' ? portasDoAgente(agente?.outputSchema) : undefined,
          },
        };
      }),
    [nodes, agentes, execPorNo, houveTeste]
  );

  const infoPorTipo = useMemo(() => {
    const m = new Map<string, NodeTypeInfo>();
    catalogo?.nodes.forEach((n) => m.set(n.type, n));
    return m;
  }, [catalogo]);

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
    setEdges(
      flow.graph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.branch && e.branch !== 'default' ? e.branch : undefined,
        data: { branch: e.branch ?? null },
        markerEnd: { type: MarkerType.ArrowClosed },
        // Rótulo do ramo legível nos dois temas — o padrão do React Flow é
        // fundo branco com texto escuro, que some no modo escuro.
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 4,
        labelBgStyle: { fill: 'hsl(var(--muted))', fillOpacity: 1 },
        labelStyle: { fill: 'hsl(var(--foreground))', fontSize: 11, fontWeight: 500 },
        style: { stroke: 'hsl(var(--muted-foreground))', strokeWidth: 1.5 },
      })) as Edge[]
    );
    setSujo(false);
  }, [flow, setNodes, setEdges]);

  const onConnect = useCallback(
    (c: Connection) => {
      setEdges((eds) =>
        addEdge({ ...c, markerEnd: { type: MarkerType.ArrowClosed }, data: { branch: null } }, eds)
      );
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
    const porNo = new Map(nodes.map((n) => [n.id, n.data as Record<string, unknown>]));
    const pendentes: Promise<unknown>[] = [];

    for (const e of edges) {
      const origem = porNo.get(e.source);
      const destino = porNo.get(e.target);
      if (origem?.tipo !== 'source.knowledge') continue;
      if (destino?.tipo !== 'ai.agent' && destino?.tipo !== 'ai.atender') continue;

      const baseId = (origem.config as { baseId?: string } | undefined)?.baseId;
      const agentId = (destino.config as { agentId?: string } | undefined)?.agentId;
      if (!baseId || !agentId) continue;

      // Só grava quando mudou — salvar o fluxo não deve escrever em todo
      // agente do desenho a cada clique.
      const atual = agentes?.find((a) => a.id === agentId);
      if (atual?.knowledgeBaseId === baseId) continue;
      pendentes.push(aiService.updateAgent(agentId, { knowledgeBaseId: baseId }));
    }

    if (pendentes.length > 0) {
      await Promise.all(pendentes);
      qc.invalidateQueries({ queryKey: ['ai-agents'] });
    }
  }, [nodes, edges, agentes, qc]);

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
      toast({ title: 'Fluxo salvo' });
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
      ampliar: (nodeId: string) => setAmpliado(nodeId),
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
        </div>
      </div>

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
          <div className="space-y-1">
            {catalogo?.nodes
              .filter((n) => !n.type.startsWith('trigger.'))
              .map((n) => (
                <button
                  key={n.type}
                  onClick={() => adicionarNo(n.type)}
                  className="w-full text-left text-xs rounded-md border px-2 py-1.5 hover:border-primary/40 hover:bg-muted/40 transition-colors"
                  title={n.description}
                >
                  <div className="flex items-center gap-1.5 font-medium">
                    {n.mutates && <Zap className="w-3 h-3 text-amber-500 shrink-0" />}
                    {n.label}
                  </div>
                </button>
              ))}
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
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
            onNodesChange={(c) => {
              onNodesChange(c);
              if (c.some((x) => x.type === 'position' || x.type === 'remove')) setSujo(true);
            }}
            onEdgesChange={(c) => {
              onEdgesChange(c);
              setSujo(true);
            }}
            onConnect={onConnect}
            onPaneClick={() => setSelecionado(null)}
            fitView
            proOptions={{ hideAttribution: true }}
            /*
              Backspace NÃO apaga bloco.
              A guarda do React Flow só reconhece input/select/textarea
              NATIVOS — o Select do shadcn é um <button role="combobox">, e
              apagar um caractere num campo desses removeria o bloco inteiro,
              em silêncio. Remover agora é só pelo botão dentro do bloco.
            */
            deleteKeyCode={null}
          >
            <Background gap={16} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              className="!bg-card !border !border-border rounded-md"
              maskColor="hsl(var(--muted) / 0.6)"
              nodeColor="hsl(var(--muted-foreground))"
            />
          </ReactFlow>
          </EditorDeFluxoContext.Provider>
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
