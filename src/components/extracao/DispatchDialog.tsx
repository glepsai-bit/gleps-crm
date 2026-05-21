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
import { Plus, Trash2, Loader2, Send } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { useToast } from '@/hooks/use-toast';
import type { ExtractedLead, ChatwootInbox } from './types';

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

      let data: any;
      if (useBackend) {
        const response = await apiClient.post(API_ENDPOINTS.PROSPECTING.DISPATCH, {
          inbox_assignments: assignments,
          delay_seconds: Number(delay) || 30,
          messages: validMessages,
        });
        data = (response as any).data || response;
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
            />
            <p className="text-xs text-muted-foreground">
              Intervalo mínimo de 5 segundos entre cada envio
            </p>
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
                  onChange={e => updateMessage(idx, e.target.value)}
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
          <Button onClick={handleDispatch} disabled={isSending || selectedInboxes.length === 0}>
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
