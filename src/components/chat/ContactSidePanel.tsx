/**
 * ContactSidePanel — T-022 Sprint 4
 *
 * Coluna direita: detalhes do contato + Custom Attributes editáveis + tags +
 * histórico de conversas + vendas recentes. Link rápido para a página
 * completa do contato.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  User as UserIcon,
  Phone,
  Mail,
  ExternalLink,
  Save,
  MessageSquare,
  ShoppingCart,
  Loader2,
  ChevronRight,
  X,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  conversationsBackendService,
  type Conversation,
} from '@/services/conversations.backend.service';
import {
  customAttributesBackendService,
  type CustomAttribute,
} from '@/services/custom-attributes.backend.service';
import { tagsBackendService } from '@/services/tags.backend.service';
import { salesService } from '@/services/sales.service';
import { agentAvailabilityBackendService } from '@/services/agent-availability.backend.service';
import { chatSocket, type AgentStatus } from '@/services/socket.client';
import { tokenManager } from '@/api/client';

interface ContactSidePanelProps {
  conversation: Conversation;
  onClose?: () => void;
}

function getInitials(name: string | null | undefined): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? '' : '';
  return (first + last).toUpperCase() || null;
}

function formatCurrency(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(n);
}

/**
 * Chaves de atributos usadas internamente pelo backend/IA/CSAT que NÃO devem
 * aparecer na lista padrão de "Outros (sem definição)" — quando vazavam ali,
 * o painel do contato virava um dump técnico. Ficam escondidas atrás do
 * collapsible "Dados do sistema" para debug.
 */
const SYSTEM_ATTR_KEYS = new Set<string>([
  'ai_handled',
  'ai_handled_at',
  'human_active',
  'human_intervened',
  'human_intervened_at',
  'resolved_by_attr',
  'resolved_by_human',
  'resolved_by_ai',
  'csat_request',
  'csat_sent_at',
  'csat_response_at',
]);

function isSystemKey(k: string): boolean {
  if (SYSTEM_ATTR_KEYS.has(k)) return true;
  // Qualquer chave com prefixo técnico também é considerada interna.
  return /^(sys_|_internal|debug_)/i.test(k);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function ContactSidePanel({ conversation, onClose }: ContactSidePanelProps) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const contact = conversation.contact;
  const contactId = contact?.id ?? null;

  // Custom attributes definidos para conversation (escopo)
  const { data: attrDefs = [] } = useQuery({
    queryKey: ['custom-attributes', 'conversation'],
    queryFn: () =>
      customAttributesBackendService.listCustomAttributes('conversation'),
    staleTime: 60_000,
  });

  // Estado local dos valores (editáveis)
  const initialValues = useMemo<Record<string, unknown>>(
    () => conversation.customAttributes ?? {},
    [conversation.customAttributes]
  );
  const [values, setValues] = useState<Record<string, unknown>>(initialValues);
  const [dirty, setDirty] = useState(false);

  // Reset quando trocar de conversa
  useEffect(() => {
    setValues(initialValues);
    setDirty(false);
  }, [conversation.id, initialValues]);

  const setAttrsMutation = useMutation({
    mutationFn: () =>
      conversationsBackendService.setCustomAttributes(conversation.id, values),
    onSuccess: () => {
      // BUG-MSG-GHOST: invalida APENAS a query do sidepanel-meta (sem
      // messages), NUNCA a thread-full. Custom attributes nao mudam o
      // conjunto de mensagens — invalidar thread-full dispararia GET
      // /conversations/:id?include=messages que demora 100-500ms e, durante
      // esse intervalo, qualquer evento socket concorrente pode escrever um
      // setQueryData que confunde o cache. A correcao do backend
      // (stripHeavyRelations no broadcast) + o guard no FE
      // (recusar merge sem messages array) ja blindam, mas evitar o
      // refetch desnecessario reduz a janela de race a zero.
      queryClient.invalidateQueries({
        queryKey: ['conversation', conversation.id, 'sidepanel-meta'],
      });
      toast({ title: 'Atributos salvos' });
      setDirty(false);
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Erro ao salvar';
      toast({ title: 'Falha', description: message, variant: 'destructive' });
    },
  });

  // Tags do contato — coerção defensiva: alguns endpoints históricos retornam
  // { data: [...] } ou null em vez de array nu. Sem o Array.isArray, qualquer
  // `.map` aqui quebra a página inteira do /admin/chat.
  const { data: contactTagsRaw } = useQuery({
    queryKey: ['contact-tags', contactId],
    queryFn: () => tagsBackendService.getLeadTags(contactId!),
    enabled: Boolean(contactId),
    staleTime: 30_000,
  });
  const contactTags = Array.isArray(contactTagsRaw)
    ? contactTagsRaw
    : Array.isArray((contactTagsRaw as any)?.data)
      ? ((contactTagsRaw as any).data as typeof contactTagsRaw)
      : [];

  // Vendas do contato — mesma coerção defensiva.
  const { data: contactSalesRaw } = useQuery({
    queryKey: ['contact-sales', contactId],
    queryFn: () => salesService.getByContact(contactId!),
    enabled: Boolean(contactId),
    staleTime: 30_000,
  });
  const contactSales = Array.isArray(contactSalesRaw)
    ? contactSalesRaw
    : Array.isArray((contactSalesRaw as any)?.data)
      ? ((contactSalesRaw as any).data as typeof contactSalesRaw)
      : [];

  // Presença dos agentes da conta (assignee online/offline) — T-022 Sprint 4
  const assigneeId = conversation.assigneeId;
  const { data: onlineAgents = [] } = useQuery({
    queryKey: ['availability-online'],
    queryFn: () => agentAvailabilityBackendService.listOnlineAgents(),
    enabled: Boolean(assigneeId),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Status local atualizado em tempo real via socket 'agent:status'
  const [liveAgentStatus, setLiveAgentStatus] = useState<
    Record<string, AgentStatus>
  >({});

  useEffect(() => {
    if (!assigneeId) return;
    const token = tokenManager.getToken();
    if (!token) return;

    chatSocket.connect(token);

    const off = chatSocket.onAgentStatusChanged((payload) => {
      setLiveAgentStatus((prev) => ({ ...prev, [payload.userId]: payload.status }));
      // Sempre re-busca pra manter a lista canônica em sincronia
      queryClient.invalidateQueries({ queryKey: ['availability-online'] });
    });

    return () => {
      off();
    };
  }, [assigneeId, queryClient]);

  // Resolve o status atual do assignee: live > onlineAgents > 'offline'
  const assigneeStatus: AgentStatus = (() => {
    if (!assigneeId) return 'offline';
    const fromLive = liveAgentStatus[assigneeId];
    if (fromLive) return fromLive;
    const isOnline = onlineAgents.some((a) => a.id === assigneeId);
    return isOnline ? 'online' : 'offline';
  })();

  const STATUS_DOT_COLOR: Record<AgentStatus, string> = {
    online: 'bg-green-500',
    away: 'bg-yellow-500',
    busy: 'bg-red-500',
    offline: 'bg-gray-400',
  };

  const STATUS_LABEL: Record<AgentStatus, string> = {
    online: 'Online',
    away: 'Ausente',
    busy: 'Ocupado',
    offline: 'Offline',
  };

  // Histórico de conversas do contato
  const { data: contactConversationsData } = useQuery({
    queryKey: ['contact-conversations', contactId],
    queryFn: () =>
      conversationsBackendService.listConversations({
        search: contact?.telefone || contact?.email || contact?.nome || '',
        limit: 10,
      }),
    enabled: Boolean(contactId),
    staleTime: 30_000,
  });
  const historyConversations =
    contactConversationsData?.data.filter((c) => c.id !== conversation.id) ?? [];

  function updateValue(key: string, value: unknown) {
    setValues((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function renderAttrInput(def: CustomAttribute) {
    const raw = values[def.key];
    switch (def.type) {
      case 'text':
        return (
          <Input
            value={(raw as string) ?? ''}
            onChange={(e) => updateValue(def.key, e.target.value)}
            placeholder={def.label}
          />
        );
      case 'number':
        return (
          <Input
            type="number"
            value={raw === undefined || raw === null ? '' : String(raw)}
            onChange={(e) =>
              updateValue(def.key, e.target.value === '' ? null : Number(e.target.value))
            }
          />
        );
      case 'date':
        return (
          <Input
            type="date"
            value={(raw as string) ?? ''}
            onChange={(e) => updateValue(def.key, e.target.value)}
          />
        );
      case 'boolean':
        return (
          <Switch
            checked={Boolean(raw)}
            onCheckedChange={(checked) => updateValue(def.key, checked)}
          />
        );
      case 'list':
        return (
          <Select
            value={(raw as string) ?? ''}
            onValueChange={(v) => updateValue(def.key, v)}
          >
            <SelectTrigger>
              <SelectValue placeholder="Selecione..." />
            </SelectTrigger>
            <SelectContent>
              {(def.options ?? []).map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );
      default:
        return null;
    }
  }

  return (
    // BUG-CHAT-FAIXA-PRETA-DIREITA: `w-full` eh OBRIGATORIO porque o pai
    // (aside.xl:flex) eh flex container — sem w-full o div encolhe pro
    // tamanho do conteudo (~270px) e deixa uma faixa preta de ~50px
    // entre o painel e a borda direita. O placeholder vazio ja tinha
    // w-full, por isso aparecia OK; aqui faltava.
    <div className="flex h-full w-full flex-col border-l border-border bg-card">
      {/* WAVE 1.3 — Header novo: Avatar + nome + telefone + acoes rapidas
          (Phone/Mail). X fecha o drawer mobile (so quando onClose definido). */}
      {(() => {
        // BUG-CHAT-DUP-PHONE: quando o contato não tem nome definido, o
        // fallback original era usar o próprio telefone como displayName.
        const trimmedName = contact?.nome?.trim();
        const displayName =
          trimmedName && trimmedName !== contact?.telefone
            ? trimmedName
            : contact?.telefone || contact?.email || 'Contato sem identificação';
        const initials = getInitials(trimmedName);
        const phone = contact?.telefone || null;
        const email = contact?.email || null;
        return (
          <div className="relative flex flex-col items-center gap-2 border-b border-border p-4 text-center">
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Fechar"
                className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <Avatar className="h-16 w-16">
              <AvatarFallback className="bg-primary/10 text-primary text-lg">
                {initials ?? <Phone className="h-5 w-5" />}
              </AvatarFallback>
            </Avatar>
            <p className="w-full truncate text-sm font-semibold text-foreground">
              {displayName}
            </p>
            {/* NIT-1314-01: so renderiza linha de telefone se nao for o mesmo
                valor ja exibido como displayName (caso contato sem nome). */}
            {phone && phone !== displayName && (
              <p className="text-xs text-muted-foreground truncate w-full">
                {phone}
              </p>
            )}
            <div className="flex items-center gap-2 pt-1">
              <Button
                asChild={Boolean(phone)}
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={!phone}
                title={phone ? `Ligar para ${phone}` : 'Sem telefone'}
              >
                {phone ? (
                  <a href={`tel:${phone}`} aria-label="Ligar">
                    <Phone className="h-4 w-4" />
                  </a>
                ) : (
                  <Phone className="h-4 w-4" />
                )}
              </Button>
              <Button
                asChild={Boolean(email)}
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={!email}
                title={email ? `Enviar e-mail para ${email}` : 'Sem e-mail'}
              >
                {email ? (
                  <a href={`mailto:${email}`} aria-label="Enviar e-mail">
                    <Mail className="h-4 w-4" />
                  </a>
                ) : (
                  <Mail className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        );
      })()}
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {contact && (
            <div className="px-3 pt-2 pb-1">
              <Button
                variant="outline"
                size="sm"
                className="w-full h-7 text-xs"
                onClick={() => contactId && navigate(`/admin/leads?contactId=${contactId}`)}
              >
                <ExternalLink className="w-3 h-3 mr-1.5" />
                Abrir contato completo
              </Button>
            </div>
          )}
          {!contact && (
            <p className="px-3 text-xs text-muted-foreground">
              Conversa sem contato vinculado.
            </p>
          )}

          <Accordion
            type="multiple"
            defaultValue={['responsavel', 'tags-conv', 'atributos']}
            className="w-full"
          >
            {/* Responsavel */}
            {conversation.assignee && (
              <AccordionItem value="responsavel">
                <AccordionTrigger className="text-xs font-semibold uppercase text-muted-foreground px-3 py-2 hover:no-underline">
                  Responsável
                </AccordionTrigger>
                <AccordionContent className="px-3 pb-3">
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`w-2 h-2 rounded-full ${STATUS_DOT_COLOR[assigneeStatus]}`}
                      title={STATUS_LABEL[assigneeStatus]}
                    />
                    <span className="text-foreground truncate">
                      {conversation.assignee.nome || conversation.assignee.email}
                    </span>
                    <Badge
                      variant="outline"
                      className="ml-auto text-[9px] py-0 px-1 h-4"
                    >
                      {STATUS_LABEL[assigneeStatus]}
                    </Badge>
                  </div>
                </AccordionContent>
              </AccordionItem>
            )}

            {/* Tags da conversa */}
            <AccordionItem value="tags-conv">
              <AccordionTrigger className="text-xs font-semibold uppercase text-muted-foreground px-3 py-2 hover:no-underline">
                Tags da conversa
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3">
                {(() => {
                  const conversationLabels = Array.isArray(conversation.labels)
                    ? conversation.labels
                    : [];
                  if (conversationLabels.length === 0) {
                    return (
                      <p className="text-xs text-muted-foreground">
                        Sem tags nesta conversa
                      </p>
                    );
                  }
                  return (
                    <div className="flex flex-wrap gap-1">
                      {conversationLabels.map((label) => (
                        <Badge
                          key={label.id}
                          variant="secondary"
                          className="text-[10px] py-0 px-1.5 h-5"
                          style={{
                            borderColor: label.tag?.color || undefined,
                          }}
                        >
                          {label.tag?.name || '—'}
                        </Badge>
                      ))}
                    </div>
                  );
                })()}
              </AccordionContent>
            </AccordionItem>

            {/* Tags do contato */}
            <AccordionItem value="tags-contato">
              <AccordionTrigger className="text-xs font-semibold uppercase text-muted-foreground px-3 py-2 hover:no-underline">
                Tags do contato
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3">
                {contactTags.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Sem tags</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {contactTags.map((rawLt) => {
                      const lt = rawLt as {
                        id: string;
                        name?: string;
                        color?: string;
                        tag?: { name?: string; color?: string };
                      };
                      return (
                        <Badge
                          key={lt.id}
                          variant="secondary"
                          className="text-[10px] py-0 px-1.5 h-5"
                          style={{
                            borderColor: lt.tag?.color || lt.color || undefined,
                          }}
                        >
                          {lt.tag?.name || lt.name || '—'}
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>

            {/* Atributos */}
            <AccordionItem value="atributos">
              <AccordionTrigger className="text-xs font-semibold uppercase text-muted-foreground px-3 py-2 hover:no-underline">
                Atributos
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3">
                {dirty && (
                  <div className="flex justify-end pb-2">
                    <Button
                      size="sm"
                      variant="default"
                      className="h-6 px-2 text-xs"
                      onClick={() => setAttrsMutation.mutate()}
                      disabled={setAttrsMutation.isPending}
                    >
                      {setAttrsMutation.isPending ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <>
                          <Save className="w-3 h-3 mr-1" />
                          Salvar
                        </>
                      )}
                    </Button>
                  </div>
                )}
                {(() => {
              // CHAT-CUSTOMATTR-005: PATCH /conversations/:id/custom-attributes
              // persiste qualquer chave no JSON `customAttributes`. Antes, a UI
              // só renderizava chaves declaradas em /api/custom-attributes —
              // valores avulsos (gravados via API/webhook/n8n) ficavam invisíveis.
              // Agora mostramos também as chaves "extras" como read-only com um
              // hint pro usuário criar a definição se quiser editar via UI.
              //
              // BUG-CHAT-SYS-ATTR: chaves de sistema (ai_handled, csat_*,
              // human_*, resolved_by_*) eram tratadas como "extras" e
              // poluíam o painel com dados internos. Agora filtramos via
              // `isSystemKey()` e expomos num <Collapsible> separado.
              const definedKeys = new Set(attrDefs.map((d) => d.key));
              const isVisibleValue = (v: unknown) =>
                v !== null && v !== undefined && v !== '';
              const extraEntries = Object.entries(values).filter(
                ([k, v]) =>
                  !definedKeys.has(k) && isVisibleValue(v) && !isSystemKey(k)
              );
              const systemEntries = Object.entries(values).filter(
                ([k, v]) => isSystemKey(k) && isVisibleValue(v)
              );
              if (
                attrDefs.length === 0 &&
                extraEntries.length === 0 &&
                systemEntries.length === 0
              ) {
                return (
                  <p className="text-xs text-muted-foreground">
                    Nenhum atributo customizado configurado.
                  </p>
                );
              }
              return (
                <div className="space-y-2">
                  {attrDefs.map((def) => (
                    <div key={def.id} className="space-y-1">
                      <Label className="text-[11px]">
                        {def.label}
                        {def.required && <span className="text-destructive">*</span>}
                      </Label>
                      {renderAttrInput(def)}
                    </div>
                  ))}
                  {extraEntries.length > 0 && (
                    <div className="space-y-1 pt-1">
                      {attrDefs.length > 0 && (
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          Outros (sem definição)
                        </p>
                      )}
                      {extraEntries.map(([key, val]) => (
                        <div
                          key={key}
                          className="flex items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1 text-xs"
                          title={`${key}: ${String(val)}`}
                        >
                          <span className="font-mono text-[10px] text-muted-foreground truncate">
                            {key}
                          </span>
                          <span className="text-foreground truncate max-w-[60%]">
                            {typeof val === 'object'
                              ? JSON.stringify(val)
                              : String(val)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {systemEntries.length > 0 && (
                    <Collapsible className="pt-1">
                      <CollapsibleTrigger className="group flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors">
                        <ChevronRight className="w-3 h-3 transition-transform group-data-[state=open]:rotate-90" />
                        Dados do sistema ({systemEntries.length})
                      </CollapsibleTrigger>
                      <CollapsibleContent className="space-y-1 pt-1">
                        {systemEntries.map(([key, val]) => (
                          <div
                            key={key}
                            className="font-mono text-[10px] text-muted-foreground border border-dashed border-border rounded px-2 py-1 break-all"
                            title={`${key}: ${String(val)}`}
                          >
                            <span className="text-foreground/70">{key}</span>
                            <span className="mx-1">:</span>
                            <span>
                              {typeof val === 'object'
                                ? JSON.stringify(val)
                                : String(val)}
                            </span>
                          </div>
                        ))}
                      </CollapsibleContent>
                    </Collapsible>
                  )}
                    </div>
                  );
                })()}
              </AccordionContent>
            </AccordionItem>

            {/* Histórico de conversas */}
            <AccordionItem value="historico">
              <AccordionTrigger className="text-xs font-semibold uppercase text-muted-foreground px-3 py-2 hover:no-underline">
                Últimas conversas
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3">
                {historyConversations.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Sem histórico</p>
                ) : (
                  <div className="space-y-1">
                    {historyConversations.slice(0, 5).map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1.5 text-xs"
                      >
                        <div className="flex items-center gap-1.5 min-w-0">
                          <MessageSquare className="w-3 h-3 text-muted-foreground shrink-0" />
                          <span className="truncate capitalize">
                            {c.inbox?.channelType || 'canal'}
                          </span>
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {formatDate(c.updatedAt)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>

            {/* Vendas recentes */}
            <AccordionItem value="vendas">
              <AccordionTrigger className="text-xs font-semibold uppercase text-muted-foreground px-3 py-2 hover:no-underline">
                Vendas recentes
              </AccordionTrigger>
              <AccordionContent className="px-3 pb-3">
                {contactSales.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Sem vendas registradas</p>
                ) : (
                  <div className="space-y-1">
                    {contactSales.slice(0, 5).map((rawSale) => {
                  // BUG-CHAT-SALES-LABEL: antes mostravamos só o status cru
                  // (ex.: "pending · R$10,00"), o que não dava contexto algum
                  // sobre o que tinha sido vendido. Agora resolvemos um título
                  // legível a partir do primeiro item (produto.nome), com
                  // fallback para descricao/contagem de itens.
                  const sale = rawSale as {
                    id: string;
                    status?: string;
                    descricao?: string | null;
                    total?: number | string | null;
                    valor?: number | string | null;
                    produto?: { nome?: string | null } | null;
                    product?: { nome?: string | null } | null;
                    items?: Array<{
                      product?: { nome?: string | null } | null;
                      produto?: { nome?: string | null } | null;
                    }>;
                  };

                  const itemsArr = Array.isArray(sale.items) ? sale.items : [];
                  const firstItemName =
                    itemsArr[0]?.product?.nome ?? itemsArr[0]?.produto?.nome ?? null;
                  const extraItemsSuffix =
                    itemsArr.length > 1 ? ` +${itemsArr.length - 1}` : '';

                  const productLabel =
                    sale.produto?.nome ||
                    sale.product?.nome ||
                    (firstItemName ? `${firstItemName}${extraItemsSuffix}` : null) ||
                    sale.descricao ||
                    'Venda';

                  const STATUS_PT: Record<string, string> = {
                    pending: 'Pendente',
                    paid: 'Paga',
                    refunded: 'Estornada',
                    partial_refund: 'Estorno parcial',
                  };
                  const statusLabel = sale.status
                    ? STATUS_PT[sale.status] ?? sale.status
                    : null;

                  return (
                  <div
                    key={sale.id}
                    className="flex items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1.5 text-xs"
                    title={`${productLabel}${statusLabel ? ` · ${statusLabel}` : ''}`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ShoppingCart className="w-3 h-3 text-muted-foreground shrink-0" />
                      <div className="min-w-0 flex flex-col leading-tight">
                        <span className="truncate text-foreground">
                          {productLabel}
                        </span>
                        {statusLabel && (
                          <span className="truncate text-[10px] text-muted-foreground">
                            {statusLabel}
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="font-medium shrink-0">
                      {formatCurrency(sale.total ?? sale.valor)}
                    </span>
                      </div>
                      );
                    })}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </ScrollArea>
    </div>
  );
}

export default ContactSidePanel;
