import { Sale } from '@/types/crm';
import { useFinance } from '@/contexts/FinanceContext';
import { useAuth } from '@/contexts/AuthContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { MoreHorizontal, CheckCircle, RotateCcw, Eye } from 'lucide-react';

interface SaleMobileCardProps {
  sale: Sale;
  contactName: string;
  onMarkAsPaid: (saleId: string) => void;
  onRefundSale: (saleId: string, valor: number) => void;
  onInspect: (sale: Sale) => void;
}

export function SaleMobileCard({
  sale,
  contactName,
  onMarkAsPaid,
  onRefundSale,
  onInspect,
}: SaleMobileCardProps) {
  const { getProductById } = useFinance();
  const { user } = useAuth();

  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const isOwner = user?.id === sale.responsavel_id;
  const hasRefundPermission = user?.permissions?.includes('refunds') || false;

  const canConfirmPayment = isOwner;
  const canRefundSale = isAdmin || hasRefundPermission;

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);

  const getStatusBadge = (status: Sale['status']) => {
    switch (status) {
      case 'paid':
        return <Badge className="bg-success/10 text-success border-success/20">Pago</Badge>;
      case 'pending':
        return <Badge className="bg-warning/10 text-warning border-warning/20">Pendente</Badge>;
      case 'refunded':
        return <Badge className="bg-destructive/10 text-destructive border-destructive/20">Estornado</Badge>;
      case 'partial_refund':
        return <Badge className="bg-warning/10 text-warning border-warning/20">Estorno Parcial</Badge>;
      default:
        return <Badge variant="outline">-</Badge>;
    }
  };

  const getPaymentMethodLabel = (method: string | null) => {
    const labels: Record<string, string> = {
      pix: 'PIX',
      debito: 'Débito',
      credito: 'Crédito',
      boleto: 'Boleto',
      dinheiro: 'Dinheiro',
      convenio: 'Convênio',
    };
    return method ? labels[method] || method : '-';
  };

  const produtosLabel =
    sale.items.length === 1
      ? getProductById(sale.items[0].product_id)?.nome || 'Produto'
      : `${sale.items.length} itens`;
  const hasRefundedItems = sale.items.some((item) => item.refunded);

  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2">
          <span className="font-medium truncate">{contactName}</span>
          {sale.is_recurring && (
            <Badge variant="outline" className="text-xs shrink-0">
              Retorno
            </Badge>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0 h-8 w-8">
              <MoreHorizontal className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="bg-popover">
            <DropdownMenuLabel>Ações Rápidas</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onInspect(sale)}>
              <Eye className="w-4 h-4 mr-2" />
              Ver Detalhes
            </DropdownMenuItem>
            {sale.status === 'pending' && canConfirmPayment && (
              <DropdownMenuItem onClick={() => onMarkAsPaid(sale.id)}>
                <CheckCircle className="w-4 h-4 mr-2 text-success" />
                Confirmar Pagamento
              </DropdownMenuItem>
            )}
            {sale.status === 'pending' && !canConfirmPayment && (
              <DropdownMenuItem disabled className="text-muted-foreground">
                Somente o responsável pode confirmar
              </DropdownMenuItem>
            )}
            {sale.status === 'paid' && canRefundSale && (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => onRefundSale(sale.id, sale.valor)}
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                Estornar Venda Completa
              </DropdownMenuItem>
            )}
            {sale.status === 'paid' && !canRefundSale && (
              <DropdownMenuItem disabled className="text-muted-foreground">
                Sem permissão para estornar
              </DropdownMenuItem>
            )}
            {sale.status === 'refunded' && (
              <DropdownMenuItem disabled>Nenhuma ação disponível</DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-3 space-y-1.5 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Produtos</span>
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate">{produtosLabel}</span>
            {hasRefundedItems && (
              <Badge variant="outline" className="text-xs text-warning border-warning/30 shrink-0">
                Parcial
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Valor Total</span>
          <span className="font-bold">{formatCurrency(sale.valor)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Método</span>
          <span>{getPaymentMethodLabel(sale.metodo_pagamento)}</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Status</span>
          {getStatusBadge(sale.status)}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">Data</span>
          <span>{format(new Date(sale.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}</span>
        </div>
      </div>

      <Button
        variant="outline"
        size="sm"
        className="mt-3 w-full gap-2"
        onClick={() => onInspect(sale)}
      >
        <Eye className="w-4 h-4" />
        Ver Detalhes
      </Button>
    </Card>
  );
}
