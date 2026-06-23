import { useState, useEffect, useCallback } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Plus, Trash2, Loader2, Send, Calendar } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { listTemplates } from '@/services/whatsapp-templates.backend.service';
import { supabase } from '@/integrations/supabase/client';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { useToast } from '@/hooks/use-toast';
import { ComplianceWarning } from './ComplianceWarning';
import type { ExtractedLead, ChatwootInbox } from './types';

// BUG-013: Radix Select não aceita value="" em SelectItem.
// Usamos um sentinel literal "none" para representar "sem template".
const NO_TEMPLATE_VALUE = 'none';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leads: ExtractedLead[];
  accountId: string;
  onDispatchStarted?: (batchId: string) => void;
}

export function DispatchDialog({ open, onOpenChange, leads, accountId, onDispatchStarted }: Props) {
  const { toast } = useToast();
  const [inboxes, setInboxes] = useState<ChatwootInbox[]>([]);
  const [selectedInboxIds, setSelectedInboxIds] = useState<Set<number>>(new Set());
  const [delay, setDelay] = useState('30');
  const [messages, setMessages] = useState<string[]>(['']);
  const [isSending, setIsSending] = useState(false);
  const [loadingInboxes, setLoadingInboxes] = useState(false);
  const [tipoAgendamento, setTipoAgendamento] = useState<'agora' | 'data_hora' | 'daqui_x'>('agora');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [daquiQuantidade, setDaquiQuantidade] = useState('2');
  const [daquiUnidade, setDaquiUnidade] = useState<'horas' | 'dias'>('horas');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(NO_TEMPLATE_VALUE);
  const [customMessage, setCustomMessage] = useState(false);
  const [optOutCount, setOptOutCount] = useState(0);

  const { data: templates = [] } = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: listTemplates,
    enabled: open,
  });

  useEffect(() => {
    if (!open || !accountId) return;
    setLoadingInboxes(true);

    const fetchInboxes = async () => {
      try {
        let inboxData: ChatwootInbox[];
        if (useBackend) {
          const response = await apiClient.get<any>(API_ENDPOINTS.PROSPECTING.INBOXES);
          const data = (response as any).data || response;
          inboxData = data.inboxes || data;
        } else {
          const { data, error } = await supabase.functions.invoke('dispatch-messages', {
            body: { action: 'list-inboxes', account_id: accountId },
          });
          if (error || !data?.inboxes) return;
          inboxData = data.inboxes;
        }
        setInboxes(inboxData);
      } catch (err) {
        console.error('Error loading inboxes:', err);
      } finally {
        setLoadingInboxes(false);
      }
    };
    fetchInboxes();
  }, [open, accountId]);

  // BUG-022 — Compliance/opt-out check.
  // Faz uma chamada otimista a /api/whatsapp-consents/check-batch ao abrir o dialog.
  // TODO(backend): endpoint /api/whatsapp-consents/check-batch ainda não existe.
  // Quando faltando (404 / erro de rede), tratamos gracefully com optOutCount = 0
  // para não bloquear o disparo.
  useEffect(() => {
    if (!open) return;
    if (!useBackend) {
      setOptOutCount(0);
      return;
    }
    if (leads.length === 0) {
      setOptOutCount(0);
      return;
    }

    let cancelled = false;
    const phones = leads.map((l) => l.telefone).filter(Boolean);

    (async () => {
      try {
        const resp = await apiClient.post<unknown>(
          '/api/whatsapp-consents/check-batch',
          { phones }
        );
        if (cancelled) return;
        const data = (resp as { data?: unknown }).data ?? resp;
        const count =
          (data as { optOutCount?: number })?.optOutCount ??
          (data as { count?: number })?.count ??
          (Array.isArray((data as { optedOut?: unknown[] })?.optedOut)
            ? (data as { optedOut: unknown[] }).optedOut.length
            : 0);
        setOptOutCount(Number(count) || 0);
      } catch {
        // 404 ou qualquer erro: ignora e segue com count=0.
        if (!cancelled) setOptOutCount(0);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, leads]);

  const toggleInbox = useCallback((id: number) => {
    setSelectedInboxIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectedInboxes = inboxes.filter(i => selectedInboxIds.has(i.id));
  const leadsPerInbox = selectedInboxes.length > 0 ? Math.ceil(leads.length / selectedInboxes.length) : 0;

  // BUG-047: validação do delay (5-300s). String vazia ou não numérica também invalida.
  const delayNumber = Number(delay);
  const delayInvalid =
    delay.trim() === '' ||
    !Number.isFinite(delayNumber) ||
    delayNumber < 5 ||
    delayNumber > 300;

  const addMessage = () => {
    if (messages.length >= 10) return;
    setMessages([...messages, '']);
  };

  const removeMessage = (idx: number) => {
    if (messages.length <= 1) return;
    setMessages(messages.filter((_, i) => i !== idx));
  };

  const updateMessage = (idx: number, value: string) => {
    const next = [...messages];
    next[idx] = value;
    setMessages(next);
  };

  const calcScheduledAt = (): string | undefined => {
    if (tipoAgendamento === 'agora') return undefined;
    if (tipoAgendamento === 'data_hora') {
      if (!scheduledDate || !scheduledTime) return undefined;
      return new Date(`${scheduledDate}T${scheduledTime}`).toISOString();
    }
    if (tipoAgendamento === 'daqui_x') {
      const mult = daquiUnidade === 'horas' ? 3600000 : 86400000;
      return new Date(Date.now() + Number(daquiQuantidade) * mult).toISOString();
    }
  };

  const handleTemplateSelect = (value: string) => {
    setSelectedTemplateId(value);
    if (value === NO_TEMPLATE_VALUE) return;
    const tmpl = templates.find(t => t.id === value);
    if (tmpl) {
      setMessages([tmpl.content]);
      setCustomMessage(false);
    }
  };

  const handleMessageUpdate = (idx: number, value: string) => {
    updateMessage(idx, value);
    // BUG-060: ao primeiro edit manual da mensagem, limpar selectedTemplateId
    // imediatamente — não esperar o flag customMessage virar true no próximo render.
    if (selectedTemplateId !== NO_TEMPLATE_VALUE) {
      setSelectedTemplateId(NO_TEMPLATE_VALUE);
    }
    setCustomMessage(true);
  };

  const handleDispatch = async () => {
    const validMessages = messages.filter(m => m.trim());
    if (selectedInboxes.length === 0 || validMessages.length === 0) {
      toast({ title: 'Selecione pelo menos 1 inbox e adicione pelo menos 1 mensagem', variant: 'destructive' });
      return;
    }

    setIsSending(true);
    try {
      const assignments = selectedInboxes.map(inbox => ({
        inbox_id: inbox.id,
        inbox_name: `${inbox.name}${inbox.phone_number ? ` (${inbox.phone_number})` : ''}`,
        contacts: [] as { nome: string; telefone: string }[],
      }));

      leads.forEach((lead, idx) => {
        const assignIdx = idx % assignments.length;
        assignments[assignIdx].contacts.push({ nome: lead.nome, telefone: lead.telefone });
      });

      const scheduledAt = calcScheduledAt();

      let data: any;
      if (useBackend) {
        if (scheduledAt) {
          // BUG-009 FE — disparos agendados precisam ir para o whatsappCampaignController
          // (/api/dispatch/send-batch), porque /api/prospecting/dispatch dispara
          // imediatamente e não aceita scheduledAt.
          const phones = leads.map(l => ({ phone: l.telefone, name: l.nome }));
          const selectedTmpl =
            selectedTemplateId !== NO_TEMPLATE_VALUE
              ? templates.find(t => t.id === selectedTemplateId)
              : undefined;
          const payload: Record<string, unknown> = {
            phones,
            scheduledAt,
            source: 'manual_scheduled',
          };
          if (selectedTmpl) {
            payload.templateId = selectedTmpl.id;
          } else {
            payload.content = validMessages[0];
          }
          const response = await apiClient.post(
            API_ENDPOINTS.PROSPECTING.DISPATCH_START,
            payload
          );
          const respData = (response as any).data || response;
          // whatsappCampaignController retorna { batchId } sem `success` flag.
          // Normalizamos para o shape esperado pelo bloco de pós-processamento.
          data = {
            success: true,
            batch_id: respData?.batchId ?? respData?.batch_id,
            ...respData,
          };
        } else {
          const response = await apiClient.post(API_ENDPOINTS.PROSPECTING.DISPATCH, {
            inbox_assignments: assignments,
            delay_seconds: Number(delay) || 30,
            messages: validMessages,
            source: 'manual',
          });
          data = (response as any).data || response;
        }
      } else {
        const result = await supabase.functions.invoke('dispatch-messages', {
          body: {
            action: 'dispatch',
            account_id: accountId,
            inbox_assignments: assignments,
            delay_seconds: Number(delay) || 30,
            messages: validMessages,
          },
        });
        if (result.error) throw result.error;
        data = result.data;
      }

      if (!data?.success) throw new Error(data?.error || 'Falha no disparo');

      toast({
        title: 'Disparo iniciado!',
        description: `${leads.length} mensagens distribuídas em ${selectedInboxes.length} inbox(es).`,
      });

      if (onDispatchStarted && data.batch_id) {
        onDispatchStarted(data.batch_id);
      }
      onOpenChange(false);
    } catch (err: any) {
      console.error('Dispatch error:', err);
      toast({ title: 'Erro no disparo', description: err.message, variant: 'destructive' });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configurar Disparo</DialogTitle>
          <DialogDescription>
            Enviar mensagens para {leads.length} contatos selecionados
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <ComplianceWarning totalLote={leads.length} totalOptOut={optOutCount} />

          <div className="space-y-2">
            <Label>Números (Inboxes do Chatwoot)</Label>
            <p className="text-xs text-muted-foreground">
              Selecione uma ou mais inboxes para distribuir os leads igualmente
            </p>
            {loadingInboxes ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                Carregando números...
              </div>
            ) : (
              <div className="space-y-2 max-h-40 overflow-y-auto border rounded-md p-2">
                {inboxes.map(inbox => (
                  <label key={inbox.id} className="flex items-center gap-3 py-1 px-2 rounded hover:bg-muted/50 cursor-pointer">
                    <Checkbox
                      checked={selectedInboxIds.has(inbox.id)}
                      onCheckedChange={() => toggleInbox(inbox.id)}
                    />
                    <span className="text-sm flex-1">
                      {inbox.name}
                      {inbox.phone_number && (
                        <span className="text-muted-foreground ml-1">· {inbox.phone_number}</span>
                      )}
                    </span>
                  </label>
                ))}
                {inboxes.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-2">Nenhuma inbox encontrada</p>
                )}
              </div>
            )}
            {selectedInboxes.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {selectedInboxes.map(inbox => (
                  <Badge key={inbox.id} variant="secondary" className="text-xs">
                    {inbox.name} — ~{leadsPerInbox} leads
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <Label>Delay entre mensagens (segundos)</Label>
            <Input
              type="number"
              min={5}
              max={300}
              value={delay}
              onChange={e => setDelay(e.target.value)}
              aria-invalid={delayInvalid}
              aria-describedby={delayInvalid ? 'delay-error' : undefined}
            />
            {delayInvalid ? (
              <p id="delay-error" className="text-xs text-destructive">
                O delay deve estar entre 5 e 300 segundos.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Intervalo mínimo de 5 segundos entre cada envio
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Template (opcional)</Label>
            <Select
              value={selectedTemplateId}
              onValueChange={handleTemplateSelect}
            >
              <SelectTrigger>
                <SelectValue placeholder="Selecionar template..." />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_TEMPLATE_VALUE}>Sem template (mensagem livre)</SelectItem>
                {templates.map(t => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Ao selecionar um template, o conteúdo será preenchido automaticamente
            </p>
          </div>

          <div className="space-y-2">
            <Label>Agendamento</Label>
            <RadioGroup value={tipoAgendamento} onValueChange={(v) => setTipoAgendamento(v as 'agora' | 'data_hora' | 'daqui_x')}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="agora" id="agora" />
                <Label htmlFor="agora" className="font-normal cursor-pointer">Disparar agora</Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="data_hora" id="data_hora" />
                <Label htmlFor="data_hora" className="font-normal cursor-pointer">Agendar para data/hora específica</Label>
              </div>
              {tipoAgendamento === 'data_hora' && (
                <div className="ml-6 flex gap-2">
                  <Input type="date" value={scheduledDate} onChange={e => setScheduledDate(e.target.value)} className="flex-1" />
                  <Input type="time" value={scheduledTime} onChange={e => setScheduledTime(e.target.value)} className="w-32" />
                </div>
              )}
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="daqui_x" id="daqui_x" />
                <Label htmlFor="daqui_x" className="font-normal cursor-pointer">Daqui X horas/dias</Label>
              </div>
              {tipoAgendamento === 'daqui_x' && (
                <div className="ml-6 flex gap-2">
                  <Input
                    type="number"
                    min={1}
                    value={daquiQuantidade}
                    onChange={e => setDaquiQuantidade(e.target.value)}
                    className="w-24"
                  />
                  <Select value={daquiUnidade} onValueChange={(v) => setDaquiUnidade(v as 'horas' | 'dias')}>
                    <SelectTrigger className="w-28">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="horas">Horas</SelectItem>
                      <SelectItem value="dias">Dias</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Variantes de Mensagem ({messages.length}/10)</Label>
              <Button type="button" variant="outline" size="sm" onClick={addMessage} disabled={messages.length >= 10}>
                <Plus className="w-3 h-3 mr-1" />
                Adicionar
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              O sistema escolherá aleatoriamente uma variante para cada contato
            </p>
            {messages.map((msg, idx) => (
              <div key={idx} className="flex gap-2">
                <Textarea
                  placeholder={`Mensagem ${idx + 1}... Use {nome} para o nome do contato`}
                  value={msg}
                  onChange={e => handleMessageUpdate(idx, e.target.value)}
                  rows={2}
                  className="flex-1"
                />
                {messages.length > 1 && (
                  <Button type="button" variant="ghost" size="icon" onClick={() => removeMessage(idx)} className="self-start">
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSending}>
            Cancelar
          </Button>
          <Button onClick={handleDispatch} disabled={isSending || selectedInboxes.length === 0 || delayInvalid}>
            {isSending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Enviando...
              </>
            ) : (
              <>
                <Send className="w-4 h-4 mr-2" />
                Enviar para {leads.length} contatos
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
