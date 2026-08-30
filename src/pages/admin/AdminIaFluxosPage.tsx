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
import { useCallback, useEffect, useMemo, useState } from 'react';
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
        if (d.tipo !== 'ai.agent') return { ...n, data: base };
        const agentId = (d.config as { agentId?: string } | undefined)?.agentId;
        const nome = agentes?.find((a) => a.id === agentId)?.name ?? null;
        return { ...n, data: { ...base, agenteNome: nome, temProblema: !agentId } };
      }),
    [nodes, agentes, execPorNo, houveTeste]
  );

  const infoPorTipo = useMemo(() => {
    const m = new Map<string, NodeTypeInfo>();
    catalogo?.nodes.forEach((n) => m.set(n.type, n));
    return m;
  }, [catalogo]);

  // Carrega o grafo salvo para dentro do canvas.
  useEffect(() => {
    if (!flow) return;
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

  const salvar = useMutation({
    mutationFn: () => flowsService.update(flowId, { graph: paraGrafo() }),
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
    setSelecionado(id);
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
            onNodeClick={(_, n) => setSelecionado(n.id)}
            onPaneClick={() => setSelecionado(null)}
            fitView
            proOptions={{ hideAttribution: true }}
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
        </div>

        {/* Simulador embutido — a conversa ao lado do desenho */}
        {testeAberto && (
          <div className="w-[22rem] border-l shrink-0 flex flex-col min-h-0 bg-card">
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

      {tipo === 'ai.agent' && (
        <div className="space-y-1.5">
          <Label className="text-xs">Agente</Label>
          <Select
            value={String(config.agentId ?? '')}
            onValueChange={(v) => set('agentId', v)}
          >
            <SelectTrigger className="h-8">
              <SelectValue placeholder="Escolha o agente" />
            </SelectTrigger>
            <SelectContent>
              {agentes.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            A saída dele fica em <code>{'{{agente.*}}'}</code> para os passos seguintes.
          </p>
        </div>
      )}

      {tipo === 'buffer.debounce' && (
        <div className="space-y-1.5">
          <Label className="text-xs">Esperar (segundos)</Label>
          <Input
            type="number"
            min={0}
            max={300}
            className="h-8"
            value={Number(config.segundos ?? 15)}
            onChange={(e) => set('segundos', Number(e.target.value))}
          />
          <p className="text-[11px] text-muted-foreground">
            Mensagens que chegarem nesta janela entram na mesma resposta.
          </p>
        </div>
      )}

      {tipo === 'guard.conditions' && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={config.humanoAssumiu !== false}
              onChange={(e) => set('humanoAssumiu', e.target.checked)}
            />
            Parar se um humano assumiu
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={config.conversaResolvida !== false}
              onChange={(e) => set('conversaResolvida', e.target.checked)}
            />
            Parar se a conversa já foi resolvida
          </label>
        </div>
      )}

      {(tipo === 'chat.reply' || tipo === 'crm.apply_stage') && (
        <div className="space-y-1.5">
          <Label className="text-xs">
            {tipo === 'chat.reply' ? 'Texto da resposta' : 'Etapa'}
          </Label>
          <Textarea
            rows={tipo === 'chat.reply' ? 4 : 2}
            value={String(config[tipo === 'chat.reply' ? 'texto' : 'etapa'] ?? '')}
            onChange={(e) => set(tipo === 'chat.reply' ? 'texto' : 'etapa', e.target.value)}
            className="text-xs font-mono"
          />
          <p className="text-[11px] text-muted-foreground">
            Use <code>{'{{agente.campo}}'}</code> para inserir a saída do agente.
          </p>
        </div>
      )}

      {tipo === 'crm.update_contact' && (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Onde guardar</Label>
            <Select
              value={String(config.destino ?? 'lead')}
              onValueChange={(v) => set('destino', v)}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lead">No lead — vale para sempre</SelectItem>
                <SelectItem value="conversa">Nesta conversa — some ao encerrar</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">
              No lead vira <code>{'{{memoria.campo}}'}</code> e sobrevive quando a conversa
              encerra. Na conversa vira <code>{'{{sessao.campo}}'}</code> e morre com ela.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Campos</Label>
            <Textarea
              rows={4}
              className="text-xs font-mono"
              value={JSON.stringify(config.campos ?? {}, null, 2)}
              onChange={(e) => {
                try {
                  set('campos', JSON.parse(e.target.value || '{}'));
                } catch {
                  /* mantém o último JSON válido enquanto o usuário digita */
                }
              }}
            />
            <p className="text-[11px] text-muted-foreground">
              Ex.: <code>{'{ "faturamento": "{{agente.faturamento}}" }'}</code>
            </p>
          </div>
        </div>
      )}

      {tipo === 'logic.switch' && (
        <div className="space-y-1.5">
          <Label className="text-xs">Variável</Label>
          <Input
            className="h-8 font-mono text-xs"
            value={String(config.variavel ?? '')}
            onChange={(e) => set('variavel', e.target.value)}
            placeholder="agente.transferir_para_humano"
          />
          <p className="text-[11px] text-muted-foreground">
            Ligue a saída <code>sim</code> ao caminho desejado; o resto segue pela saída padrão.
          </p>
        </div>
      )}

      {tipo === 'http.request' && (
        <div className="space-y-2">
          <div className="space-y-1.5">
            <Label className="text-xs">URL</Label>
            <Input
              className="h-8 text-xs font-mono"
              value={String(config.url ?? '')}
              onChange={(e) => set('url', e.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Método</Label>
            <Select value={String(config.metodo ?? 'POST')} onValueChange={(v) => set('metodo', v)}>
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['GET', 'POST', 'PUT', 'PATCH'].map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

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
