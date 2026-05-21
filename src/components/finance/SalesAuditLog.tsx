import { useMemo } from 'react';
import { useFinance } from '@/contexts/FinanceContext';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { format, subDays, isAfter } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Receipt,
  CheckCircle,
  RotateCcw,
  XCircle,
  User,
  Calendar,
  FileText,
} from 'lucide-react';

const eventTypeConfig = {
  'sale.created': {
    label: 'Venda Criada',
    icon: Receipt,
    color: 'bg-primary/10 text-primary border-primary/20',
  },
  'sale.paid': {
    label: 'Pagamento Confirmado',
    icon: CheckCircle,
    color: 'bg-success/10 text-success border-success/20',
  },
  'sale.cancelled': {
    label: 'Venda Cancelada',
    icon: XCircle,
    color: 'bg-warning/10 text-warning border-warning/20',
  },
  'sale.refunded': {
    label: 'Estorno Realizado',
    icon: RotateCcw,
    color: 'bg-destructive/10 text-destructive border-destructive/20',
  },
};

export function SalesAuditLog() {
  const { events, getContactById, sales } = useFinance();

  // Filter events from last 30 days
  const thirtyDaysAgo = subDays(new Date(), 30);

  const recentEvents = useMemo(() => {
    return events
      .filter((event) => isAfter(new Date(event.createdAt), thirtyDaysAgo))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [events, thirtyDaysAgo]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const getSaleInfo = (saleId: string) => {
    const sale = sales.find((s) => s.id === saleId);
    if (!sale) return null;
    const contact = getContactById(sale.contact_id);
    return {
      contactName: contact?.nome || 'Cliente não encontrado',
      valor: sale.valor,
    };
  };

  if (recentEvents.length === 0) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="text-center text-muted-foreground">
            <FileText className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p className="text-lg font-medium">Nenhuma ação registrada</p>
            <p className="text-sm">Os eventos de vendas dos últimos 30 dias aparecerão aqui.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <FileText className="w-5 h-5" />
          Histórico de Ações (Últimos 30 dias)
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea className="h-[500px]">
          <div className="divide-y">
            {recentEvents.map((event) => {
              const config = eventTypeConfig[event.type];
              const Icon = config.icon;
              const saleInfo = getSaleInfo(event.saleId);

              return (
                <div
                  key={event.id}
                  className="p-4 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg ${config.color.split(' ')[0]}`}>
                      <Icon className={`w-4 h-4 ${config.color.split(' ')[1]}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <Badge className={config.color}>{config.label}</Badge>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Calendar className="w-3 h-3" />
                          {format(new Date(event.createdAt), "dd/MM/yyyy 'às' HH:mm", {
                            locale: ptBR,
                          })}
                        </span>
                      </div>
                      <div className="mt-2 space-y-1">
                        <div className="flex items-center gap-2 text-sm">
                          <User className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="font-medium">{event.actorName}</span>
                        </div>
                        {saleInfo && (
                          <p className="text-sm text-muted-foreground">
                            Cliente: <span className="font-medium text-foreground">{saleInfo.contactName}</span>
                            {' • '}
                            Valor: <span className="font-medium text-foreground">{formatCurrency(saleInfo.valor)}</span>
                          </p>
                        )}
                        {event.payload.reason && (
                          <p className="text-sm text-muted-foreground italic">
                            Motivo: "{event.payload.reason as string}"
                          </p>
                        )}
                        {event.payload.itemId && (
                          <Badge variant="outline" className="text-xs">
                            Estorno parcial (item)
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
