/**
 * AdminIaAgentesPage (T-027 Fase 1)
 *
 * Onde o cérebro do atendimento passa a morar. Cada agente é o equivalente a um
 * nó `AI Agent` do fluxo n8n — prompt, modelo, base de conhecimento e schema de
 * saída — só que editável aqui e versionado com a conta.
 *
 * O playground executa o agente de VERDADE (gasta token da conta) e mostra os
 * trechos da base que entraram no contexto: é como o admin descobre que o
 * prompt está bom antes de ligar isso num lead real.
 *
 * Serviço: src/services/ai.backend.service.ts
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  aiService,
  AiAgent,
  AiAgentInput,
  AgentRunResult,
  AiProviderName,
} from '@/services/ai.backend.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Pencil,
  Trash2,
  Bot,
  Play,
  AlertTriangle,
  Loader2,
  BookOpen,
  Wrench,
} from 'lucide-react';

// Modelos que rejeitam `temperature` com erro 400 (Claude 4.7+ / família 5).
// O backend remove o campo antes de enviar; aqui o aviso evita o admin ajustar
// um controle que não faz nada.
const NO_TEMPERATURE_PREFIXES = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-fable-5',
];

const MODEL_SUGGESTIONS: Record<AiProviderName, { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-4o-mini', label: 'gpt-4o-mini — rápido e barato (padrão)' },
    { value: 'gpt-4o', label: 'gpt-4o — mais capaz' },
  ],
  anthropic: [
    { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5 — rápido e barato (padrão)' },
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5 — equilíbrio' },
    { value: 'claude-opus-5', label: 'claude-opus-5 — mais capaz' },
  ],
};

const ROLE_LABEL: Record<string, string> = {
  responder: 'Responde ao lead',
  classifier: 'Classifica (não responde)',
  custom: 'Personalizado',
};

const EMPTY_FORM: AiAgentInput & { name: string; systemPrompt: string } = {
  name: '',
  description: '',
  role: 'responder',
  systemPrompt: '',
  provider: 'openai',
  model: '',
  temperature: 0.7,
  maxTokens: 1024,
  historyLimit: 20,
  knowledgeBaseId: null,
  tools: [],
  outputSchema: null,
  subAgentIds: [],
  active: true,
};

export default function AdminIaAgentesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AiAgent | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [schemaText, setSchemaText] = useState('');
  const [schemaError, setSchemaError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<AiAgent | null>(null);

  const [playgroundOf, setPlaygroundOf] = useState<AiAgent | null>(null);
  const [testMessage, setTestMessage] = useState('');
  const [runResult, setRunResult] = useState<AgentRunResult | null>(null);

  const statusQuery = useQuery({ queryKey: ['ai', 'status'], queryFn: aiService.getStatus });
  const agentsQuery = useQuery({ queryKey: ['ai', 'agents'], queryFn: aiService.listAgents });
  const basesQuery = useQuery({ queryKey: ['ai', 'bases'], queryFn: aiService.listBases });

  const saveMutation = useMutation({
    mutationFn: (payload: AiAgentInput) =>
      editing ? aiService.updateAgent(editing.id, payload) : aiService.createAgent(payload as AiAgentInput),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai', 'agents'] });
      setDialogOpen(false);
      toast({ title: editing ? 'Agente atualizado' : 'Agente criado' });
    },
    onError: (err: Error) =>
      toast({ title: 'Não foi possível salvar', description: err.message, variant: 'destructive' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => aiService.deleteAgent(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ai', 'agents'] });
      setDeleting(null);
      toast({ title: 'Agente excluído' });
    },
    onError: (err: Error) =>
      toast({ title: 'Não foi possível excluir', description: err.message, variant: 'destructive' }),
  });

  const runMutation = useMutation({
    mutationFn: () => aiService.runAgent(playgroundOf!.id, { message: testMessage }),
    onSuccess: (result) => setRunResult(result),
    onError: (err: Error) =>
      toast({ title: 'A execução falhou', description: err.message, variant: 'destructive' }),
  });

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setSchemaText('');
    setSchemaError(null);
    setDialogOpen(true);
  };

  const openEdit = (agent: AiAgent) => {
    setEditing(agent);
    setForm({
      name: agent.name,
      description: agent.description ?? '',
      role: agent.role,
      systemPrompt: agent.systemPrompt,
      provider: agent.provider,
      model: agent.model ?? '',
      temperature: Number(agent.temperature),
      maxTokens: agent.maxTokens,
      historyLimit: agent.historyLimit,
      knowledgeBaseId: agent.knowledgeBaseId,
      tools: agent.tools ?? [],
      outputSchema: agent.outputSchema,
      subAgentIds: agent.subAgentIds ?? [],
      active: agent.active,
    });
    setSchemaText(agent.outputSchema ? JSON.stringify(agent.outputSchema, null, 2) : '');
    setSchemaError(null);
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!form.name?.trim()) {
      toast({ title: 'Dê um nome ao agente', variant: 'destructive' });
      return;
    }
    if (!form.systemPrompt?.trim()) {
      toast({ title: 'O prompt do agente é obrigatório', variant: 'destructive' });
      return;
    }

    let outputSchema: Record<string, unknown> | null = null;
    if (schemaText.trim()) {
      try {
        outputSchema = JSON.parse(schemaText);
      } catch {
        setSchemaError('JSON inválido — corrija antes de salvar.');
        return;
      }
    }

    saveMutation.mutate({
      ...form,
      model: form.model?.trim() || null,
      description: form.description?.trim() || null,
      outputSchema,
    });
  };

  const status = statusQuery.data;
  const noProvider = status && !status.providers.openai && !status.providers.anthropic;
  const modelHasNoTemperature =
    !!form.model && NO_TEMPERATURE_PREFIXES.some((p) => form.model!.startsWith(p));

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Bot className="w-6 h-6" /> Agentes de IA
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            O prompt, o modelo e a base de conhecimento do seu atendimento — sem depender de
            ferramenta externa.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 mr-2" /> Novo agente
        </Button>
      </div>

      {noProvider && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Nenhuma chave de IA cadastrada nesta conta. Cadastre em{' '}
            <strong>Administração → Integrações</strong> antes de criar agentes.
          </AlertDescription>
        </Alert>
      )}

      {status && !status.knowledgeBaseReady && status.providers.anthropic && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            Você tem chave Anthropic, mas a <strong>base de conhecimento</strong> e a{' '}
            <strong>transcrição de áudio</strong> precisam de uma chave OpenAI — a Anthropic não
            oferece esses recursos. O agente conversa normalmente sem eles.
          </AlertDescription>
        </Alert>
      )}

      {agentsQuery.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : agentsQuery.data?.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Bot className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">Nenhum agente ainda</p>
            <p className="text-sm mt-1">
              Comece com um agente que responde ao lead. Você pode colar aqui o mesmo prompt que
              usa hoje no n8n.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {agentsQuery.data?.map((agent) => (
            <Card key={agent.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="text-base flex items-center gap-2">
                      <span className="truncate">{agent.name}</span>
                      {!agent.active && <Badge variant="secondary">Inativo</Badge>}
                    </CardTitle>
                    {agent.description && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {agent.description}
                      </p>
                    )}
                  </div>
                  <div className="flex gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Testar no playground"
                      onClick={() => {
                        setPlaygroundOf(agent);
                        setRunResult(null);
                        setTestMessage('');
                      }}
                    >
                      <Play className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => openEdit(agent)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleting(agent)}>
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <Badge variant="outline">{ROLE_LABEL[agent.role] ?? agent.role}</Badge>
                  <Badge variant="outline">
                    {agent.provider} · {agent.model || 'modelo padrão'}
                  </Badge>
                  {agent.knowledgeBase && (
                    <Badge variant="outline" className="gap-1">
                      <BookOpen className="w-3 h-3" />
                      {agent.knowledgeBase.name}
                    </Badge>
                  )}
                  {(agent.tools?.length ?? 0) > 0 && (
                    <Badge variant="outline" className="gap-1">
                      <Wrench className="w-3 h-3" />
                      {agent.tools!.length} ferramenta(s)
                    </Badge>
                  )}
                  {agent.outputSchema && <Badge variant="outline">saída estruturada</Badge>}
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2 font-mono">
                  {agent.systemPrompt.slice(0, 160)}
                  {agent.systemPrompt.length > 160 ? '…' : ''}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* ---------- Editor ---------- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? 'Editar agente' : 'Novo agente'}</DialogTitle>
            <DialogDescription>
              O prompt define a persona e as regras. A base de conhecimento entra automaticamente
              no contexto quando o lead pergunta algo do negócio.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ag-nome">Nome</Label>
                <Input
                  id="ag-nome"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Marcus — SDR"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ag-papel">Papel</Label>
                <Select
                  value={form.role}
                  onValueChange={(v) => setForm({ ...form, role: v as AiAgent['role'] })}
                >
                  <SelectTrigger id="ag-papel">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="responder">Responde ao lead</SelectItem>
                    <SelectItem value="classifier">Classifica (não responde)</SelectItem>
                    <SelectItem value="custom">Personalizado</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ag-desc">Descrição (interna)</Label>
              <Input
                id="ag-desc"
                value={form.description ?? ''}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Para que serve este agente"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ag-prompt">Prompt do agente</Label>
              <Textarea
                id="ag-prompt"
                value={form.systemPrompt}
                onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                placeholder="# PERSONA&#10;Você se chama..."
                className="min-h-[240px] font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                Use <code>{'{{variavel}}'}</code> para valores que o fluxo injeta.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="ag-provider">Provedor</Label>
                <Select
                  value={form.provider}
                  onValueChange={(v) =>
                    setForm({ ...form, provider: v as AiProviderName, model: '' })
                  }
                >
                  <SelectTrigger id="ag-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai" disabled={status && !status.providers.openai}>
                      OpenAI{status && !status.providers.openai ? ' (sem chave)' : ''}
                    </SelectItem>
                    <SelectItem value="anthropic" disabled={status && !status.providers.anthropic}>
                      Anthropic{status && !status.providers.anthropic ? ' (sem chave)' : ''}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ag-modelo">Modelo</Label>
                <Select
                  value={form.model || '__default__'}
                  onValueChange={(v) => setForm({ ...form, model: v === '__default__' ? '' : v })}
                >
                  <SelectTrigger id="ag-modelo">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__default__">Padrão do provedor</SelectItem>
                    {MODEL_SUGGESTIONS[form.provider ?? 'openai'].map((m) => (
                      <SelectItem key={m.value} value={m.value}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="ag-temp">Temperatura</Label>
                <Input
                  id="ag-temp"
                  type="number"
                  step="0.1"
                  min={0}
                  max={2}
                  value={form.temperature}
                  disabled={modelHasNoTemperature}
                  onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
                />
                {modelHasNoTemperature && (
                  <p className="text-xs text-muted-foreground">
                    Este modelo não aceita temperatura — o valor é ignorado.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ag-maxtok">Tokens máx. da resposta</Label>
                <Input
                  id="ag-maxtok"
                  type="number"
                  min={64}
                  max={32000}
                  value={form.maxTokens}
                  onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ag-hist">Mensagens de histórico</Label>
                <Input
                  id="ag-hist"
                  type="number"
                  min={0}
                  max={60}
                  value={form.historyLimit}
                  onChange={(e) => setForm({ ...form, historyLimit: Number(e.target.value) })}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ag-base">Base de conhecimento</Label>
              <Select
                value={form.knowledgeBaseId ?? '__none__'}
                onValueChange={(v) =>
                  setForm({ ...form, knowledgeBaseId: v === '__none__' ? null : v })
                }
              >
                <SelectTrigger id="ag-base">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">Nenhuma</SelectItem>
                  {basesQuery.data?.map((b) => (
                    <SelectItem key={b.id} value={b.id}>
                      {b.name} ({b.chunkCount} trechos)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Especialistas que este agente pode consultar</Label>
              <p className="text-[11px] text-muted-foreground">
                Marque quem ele pode chamar no meio do raciocínio. O lead não vê a
                consulta — só a resposta final. Quem é consultado não consulta ninguém.
              </p>
              {(agentsQuery.data ?? []).filter((a) => a.id !== editing?.id).length === 0 ? (
                <p className="text-xs text-muted-foreground rounded-md border p-2.5">
                  Crie outro agente primeiro para poder montar um time.
                </p>
              ) : (
                <div className="space-y-1.5 max-h-44 overflow-y-auto">
                  {(agentsQuery.data ?? [])
                    .filter((a) => a.id !== editing?.id)
                    .map((a) => {
                      const marcado = (form.subAgentIds ?? []).includes(a.id);
                      return (
                        <label
                          key={a.id}
                          className="flex items-start gap-3 rounded-md border p-2.5 cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={marcado}
                            onChange={(e) =>
                              setForm({
                                ...form,
                                subAgentIds: e.target.checked
                                  ? [...(form.subAgentIds ?? []), a.id]
                                  : (form.subAgentIds ?? []).filter((id) => id !== a.id),
                              })
                            }
                          />
                          <span className="min-w-0">
                            <span className="text-sm font-medium block">{a.name}</span>
                            <span className="text-[11px] text-muted-foreground block">
                              {a.description || 'sem descrição — o coordenador usa isso pra saber quando chamar'}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                </div>
              )}
            </div>

            {(status?.tools.length ?? 0) > 0 && (
              <div className="space-y-2">
                <Label>Ferramentas</Label>
                {status!.tools.map((t) => (
                  <label
                    key={t.name}
                    className="flex items-start gap-3 rounded-md border p-2.5 cursor-pointer"
                  >
                    <Switch
                      checked={(form.tools ?? []).includes(t.name)}
                      onCheckedChange={(checked) =>
                        setForm({
                          ...form,
                          tools: checked
                            ? [...(form.tools ?? []), t.name]
                            : (form.tools ?? []).filter((x) => x !== t.name),
                        })
                      }
                    />
                    <span className="text-xs">
                      <span className="font-medium font-mono">{t.name}</span>
                      <span className="block text-muted-foreground">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="ag-schema">Saída estruturada (JSON Schema, opcional)</Label>
              <Textarea
                id="ag-schema"
                value={schemaText}
                onChange={(e) => {
                  setSchemaText(e.target.value);
                  setSchemaError(null);
                }}
                placeholder='{"type":"object","properties":{"etapa":{"type":"string"}},"required":["etapa"]}'
                className="min-h-[120px] font-mono text-xs"
              />
              {schemaError ? (
                <p className="text-xs text-destructive">{schemaError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Com schema, a resposta é validada e o agente tem uma chance de se autocorrigir.
                </p>
              )}
            </div>

            <div className="flex items-center gap-3">
              <Switch
                id="ag-ativo"
                checked={form.active}
                onCheckedChange={(v) => setForm({ ...form, active: v })}
              />
              <Label htmlFor="ag-ativo">Agente ativo</Label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSave} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- Playground ---------- */}
      <Dialog open={!!playgroundOf} onOpenChange={(open) => !open && setPlaygroundOf(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Testar: {playgroundOf?.name}</DialogTitle>
            <DialogDescription>
              Executa o agente de verdade e consome tokens da chave desta conta.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Textarea
              value={testMessage}
              onChange={(e) => setTestMessage(e.target.value)}
              placeholder="Escreva como se fosse o lead: “Oi, queria saber sobre os planos”"
              className="min-h-[80px]"
            />
            <Button
              onClick={() => runMutation.mutate()}
              disabled={!testMessage.trim() || runMutation.isPending}
              className="w-full"
            >
              {runMutation.isPending ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              Executar
            </Button>

            {runResult && (
              <div className="space-y-3 pt-2">
                <div className="rounded-md border p-3 bg-muted/40">
                  <p className="text-xs font-medium text-muted-foreground mb-1">Resposta</p>
                  <p className="text-sm whitespace-pre-wrap">{runResult.text || '(vazio)'}</p>
                </div>

                {runResult.structured && (
                  <div className="rounded-md border p-3">
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      Saída estruturada
                    </p>
                    <pre className="text-xs overflow-x-auto">
                      {JSON.stringify(runResult.structured, null, 2)}
                    </pre>
                  </div>
                )}

                <div className="rounded-md border p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-2">
                    Base de conhecimento usada ({runResult.hits.length} trecho(s))
                  </p>
                  {runResult.hits.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Nenhum trecho passou do corte de relevância — a resposta saiu só do prompt.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {runResult.hits.map((h) => (
                        <li key={h.chunkId} className="text-xs">
                          <span className="font-medium">{h.docTitle || 'sem título'}</span>{' '}
                          <Badge variant="outline" className="ml-1">
                            {(h.score * 100).toFixed(0)}%
                          </Badge>
                          <p className="text-muted-foreground line-clamp-2 mt-0.5">{h.content}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                  <Badge variant="secondary">{runResult.model}</Badge>
                  <Badge variant="secondary">
                    {runResult.usage.inputTokens} entrada / {runResult.usage.outputTokens} saída
                  </Badge>
                  <Badge variant="secondary">
                    {runResult.usage.priced
                      ? `~US$ ${runResult.usage.usdEstimate.toFixed(5)}`
                      : 'custo não estimado (modelo fora da tabela)'}
                  </Badge>
                  {runResult.attempts > 1 && (
                    <Badge variant="outline" className="text-amber-600 border-amber-600/40">
                      precisou de autocorreção
                    </Badge>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              O agente é removido permanentemente. A base de conhecimento vinculada não é afetada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && deleteMutation.mutate(deleting.id)}>
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
