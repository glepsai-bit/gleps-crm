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
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
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
}

function formatCurrency(value: number | string | null | undefined): string {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(n);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function ContactSidePanel({ conversation }: ContactSidePanelProps) {
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
      queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] });
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
    <div className="flex h-full flex-col border-l border-border bg-card">
      <div className="border-b border-border p-3">
        <h2 className="text-sm font-semibold text-foreground">Contato</h2>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">
          {/* Dados do contato */}
          {contact ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <UserIcon className="w-3.5 h-3.5 text-muted-foreground" />
                <p className="text-sm font-medium text-foreground truncate">
                  {contact.nome || 'Sem nome'}
                </p>
              </div>
              {contact.telefone && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Phone className="w-3 h-3" />
                  <a
                    href={`tel:${contact.telefone}`}
                    className="hover:text-foreground truncate"
                  >
                    {contact.telefone}
                  </a>
                </div>
              )}
              {contact.email && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Mail className="w-3 h-3" />
                  <a
                    href={`mailto:${contact.email}`}
                    className="hover:text-foreground truncate"
                  >
                    {contact.email}
                  </a>
                </div>
              )}
              <Button
                variant="outline"
                size="sm"
                className="w-full mt-2 h-7 text-xs"
                onClick={() => contactId && navigate(`/admin/leads?contactId=${contactId}`)}
              >
                <ExternalLink className="w-3 h-3 mr-1.5" />
                Abrir contato completo
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Conversa sem contato vinculado.
            </p>
          )}

          <Separator />

          {/* Assignee + status (presença em tempo real) */}
          {conversation.assignee && (
            <>
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-muted-foreground uppercase">
                  Responsável
                </h3>
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
              </div>
              <Separator />
            </>
          )}

          {/* Tags do contato */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase">
              Tags
            </h3>
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
          </div>

          <Separator />

          {/* Custom Attributes */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase">
                Atributos
              </h3>
              {dirty && (
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
              )}
            </div>
            {attrDefs.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nenhum atributo customizado configurado.
              </p>
            ) : (
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
              </div>
            )}
          </div>

          <Separator />

          {/* Histórico de conversas */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase">
              Últimas conversas
            </h3>
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
          </div>

          <Separator />

          {/* Vendas recentes */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase">
              Vendas recentes
            </h3>
            {contactSales.length === 0 ? (
              <p className="text-xs text-muted-foreground">Sem vendas registradas</p>
            ) : (
              <div className="space-y-1">
                {contactSales.slice(0, 5).map((rawSale) => {
                  const sale = rawSale as {
                    id: string;
                    status?: string;
                    total?: number | string | null;
                    valor?: number | string | null;
                  };
                  return (
                  <div
                    key={sale.id}
                    className="flex items-center justify-between gap-2 rounded border border-border bg-background px-2 py-1.5 text-xs"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ShoppingCart className="w-3 h-3 text-muted-foreground shrink-0" />
                      <span className="truncate">
                        {sale.status || 'sale'}
                      </span>
                    </div>
                    <span className="font-medium shrink-0">
                      {formatCurrency(sale.total ?? sale.valor)}
                    </span>
                  </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

export default ContactSidePanel;
