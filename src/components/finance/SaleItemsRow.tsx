import { Fragment } from 'react';
import { Sale } from '@/types/crm';
import { useFinance } from '@/contexts/FinanceContext';
import { useAuth } from '@/contexts/AuthContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { TableCell, TableRow } from '@/components/ui/table';
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
import {
  MoreHorizontal,
  CheckCircle,
  RotateCcw,
  Eye,
} from 'lucide-react';

interface SaleItemsRowProps {
  sale: Sale;
  contactName: string;
  onMarkAsPaid: (saleId: string) => void;
  onRefundSale: (saleId: string, valor: number) => void;
  onInspect: (sale: Sale) => void;
}

export function SaleItemsRow({
  sale,
  contactName,
  onMarkAsPaid,
  onRefundSale,
  onInspect,
}: SaleItemsRowProps) {
  const { getProductById } = useFinance();
  const { user } = useAuth();

  // Check if user can manage this sale
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const isOwner = user?.id === sale.responsavel_id;
  const hasRefundPermission = user?.permissions?.includes('refunds') || false;
  
  // Only the owner can confirm payment (to ensure accountability for entries)
  // Admins can always refund; Agents need 'refunds' permission (to prevent fraud)
  const canConfirmPayment = isOwner;
  const canRefundSale = isAdmin || hasRefundPermission;

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

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

  const getPaymentMethodBadge = (method: string | null) => {
    const labels: Record<string, string> = {
      pix: 'PIX',
      debito: 'Débito',
      credito: 'Crédito',
      boleto: 'Boleto',
      dinheiro: 'Dinheiro',
      convenio: 'Convênio',
    };
    return method ? (
      <Badge variant="secondary">{labels[method] || method}</Badge>
    ) : (
      <Badge variant="secondary">-</Badge>
    );
  };

  // Count active and refunded items
  const activeItemsCount = sale.items.filter((item) => !item.refunded).length;
  const hasRefundedItems = sale.items.some((item) => item.refunded);

  return (
    <TableRow className="group hover:bg-muted/50">
      <TableCell>
        <div className="flex items-center gap-2">
          <span className="font-medium">{contactName}</span>
          {sale.is_recurring && (
            <Badge variant="outline" className="text-xs">
              Retorno
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground">
            {sale.items.length === 1 
              ? getProductById(sale.items[0].product_id)?.nome || 'Produto'
              : `${sale.items.length} itens`
            }
          </span>
          {hasRefundedItems && (
            <Badge variant="outline" className="text-xs text-warning border-warning/30">
              Parcial
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="font-bold">{formatCurrency(sale.valor)}</TableCell>
      <TableCell>{getPaymentMethodBadge(sale.metodo_pagamento)}</TableCell>
      <TableCell>{getStatusBadge(sale.status)}</TableCell>
      <TableCell className="text-muted-foreground">
        {format(new Date(sale.created_at), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-primary hover:text-primary hover:bg-primary/10"
            onClick={() => onInspect(sale)}
          >
            <Eye className="w-4 h-4" />
            Detalhes
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
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
                <DropdownMenuItem disabled>
                  Nenhuma ação disponível
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  );
}
