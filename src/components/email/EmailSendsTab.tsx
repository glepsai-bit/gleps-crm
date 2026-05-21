import { useState, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Loader2, Send, RefreshCw } from 'lucide-react';
import { emailService, type EmailSend } from '@/services/email.service';

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  queued: { label: 'Na fila', variant: 'secondary' },
  sent: { label: 'Enviado', variant: 'default' },
  delivered: { label: 'Entregue', variant: 'default' },
  opened: { label: 'Aberto', variant: 'outline' },
  clicked: { label: 'Clicado', variant: 'outline' },
  bounced: { label: 'Bounce', variant: 'destructive' },
  failed: { label: 'Falhou', variant: 'destructive' },
  spam: { label: 'Spam', variant: 'destructive' },
};

export default function EmailSendsTab() {
  const [sends, setSends] = useState<EmailSend[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  useEffect(() => { loadSends(); }, []);

  const loadSends = async () => {
    setLoading(true);
    try {
      const data = await emailService.listSends({ limit: 100 });
      setSends(data);
    } catch (err) {
      console.error('Erro ao carregar envios:', err);
    } finally {
      setLoading(false);
    }
  };

  const filtered = statusFilter === 'all'
    ? sends
    : sends.filter(s => s.status === statusFilter);

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Histórico de e-mails enviados</p>
        <div className="flex items-center gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Filtrar status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {Object.entries(statusConfig).map(([key, cfg]) => (
                <SelectItem key={key} value={key}>{cfg.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="ghost" size="sm" onClick={loadSends}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card className="card-gradient border-border/50">
          <CardContent className="py-12 text-center">
            <Send className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="font-medium text-muted-foreground">Nenhum envio encontrado</p>
            <p className="text-sm text-muted-foreground mt-1">Os e-mails enviados aparecerão aqui.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {/* Header */}
          <div className="grid grid-cols-12 gap-2 px-3 py-2 text-xs font-medium text-muted-foreground uppercase">
            <div className="col-span-3">Destinatário</div>
            <div className="col-span-4">Assunto</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-3 text-right">Data</div>
          </div>

          {filtered.map(send => {
            const cfg = statusConfig[send.status] || { label: send.status, variant: 'secondary' as const };
            return (
              <Card key={send.id} className="card-gradient border-border/50">
                <CardContent className="p-3">
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-3">
                      <p className="text-sm font-medium truncate">{send.contact?.nome || send.to_email}</p>
                      <p className="text-xs text-muted-foreground truncate">{send.to_email}</p>
                    </div>
                    <div className="col-span-4">
                      <p className="text-sm truncate">{send.subject}</p>
                    </div>
                    <div className="col-span-2">
                      <Badge variant={cfg.variant} className="text-[10px]">{cfg.label}</Badge>
                    </div>
                    <div className="col-span-3 text-right">
                      <p className="text-xs text-muted-foreground">
                        {send.sent_at
                          ? new Date(send.sent_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                          : new Date(send.created_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
                        }
                      </p>
                      {send.error_message && (
                        <p className="text-[10px] text-destructive truncate" title={send.error_message}>
                          {send.error_message}
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
