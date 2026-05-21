import { useState } from 'react';
import { Sale, SaleItem } from '@/types/crm';
import { useFinance } from '@/contexts/FinanceContext';
import { useAuth } from '@/contexts/AuthContext';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ItemRefundDialog } from './ItemRefundDialog';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  User,
  Package,
  CreditCard,
  Calendar,
  RotateCcw,
  CheckCircle,
  Clock,
  Receipt,
  Repeat,
  Building,
  ShieldAlert,
} from 'lucide-react';

interface SaleDetailsSheetProps {
  sale: Sale | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onMarkAsPaid: (saleId: string) => void;
  onRefundSale: (saleId: string, valor: number) => void;
}

export function SaleDetailsSheet({
  sale,
  open,
  onOpenChange,
  onMarkAsPaid,
  onRefundSale,
}: SaleDetailsSheetProps) {
  const { getProductById, getContactById, refundSaleItem } = useFinance();
  const { user } = useAuth();
  const [itemRefundDialog, setItemRefundDialog] = useState<{
    open: boolean;
    item: SaleItem | null;
    productName: string;
  }>({
    open: false,
    item: null,
    productName: '',
  });

  if (!sale) return null;

  const contact = getContactById(sale.contact_id);
  
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
        return (
          <Badge className="bg-success/10 text-success border-success/20 gap-1">
            <CheckCircle className="w-3 h-3" />
            Pago
          </Badge>
        );
      case 'pending':
        return (
          <Badge className="bg-warning/10 text-warning border-warning/20 gap-1">
            <Clock className="w-3 h-3" />
            Pendente
          </Badge>
        );
      case 'refunded':
        return (
          <Badge className="bg-destructive/10 text-destructive border-destructive/20 gap-1">
            <RotateCcw className="w-3 h-3" />
            Estornado
          </Badge>
        );
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

  const handleItemRefundConfirm = async (reason: string, password: string) => {
    if (!itemRefundDialog.item) return;
    await refundSaleItem(sale.id, itemRefundDialog.item.id, reason, password);
    setItemRefundDialog({ open: false, item: null, productName: '' });
  };

  const activeItemsTotal = sale.items
    .filter((item) => !item.refunded)
    .reduce((sum, item) => sum + item.valor_total, 0);

  const refundedItemsTotal = sale.items
    .filter((item) => item.refunded)
    .reduce((sum, item) => sum + item.valor_total, 0);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="sm:max-w-lg overflow-y-auto">
          <SheetHeader className="space-y-1">
            <SheetTitle className="flex items-center gap-2">
              <Receipt className="w-5 h-5 text-primary" />
              Detalhes da Venda
            </SheetTitle>
            <SheetDescription>
              Venda #{sale.id.slice(0, 8).toUpperCase()}
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6 space-y-6">
            {/* Status and Actions */}
            <div className="flex items-center justify-between">
              {getStatusBadge(sale.status)}
              <div className="flex gap-2">
                {sale.status === 'pending' && canConfirmPayment && (
                  <Button
                    size="sm"
                    className="bg-success hover:bg-success/90 gap-1"
                    onClick={() => {
                      onMarkAsPaid(sale.id);
                      onOpenChange(false);
                    }}
                  >
                    <CheckCircle className="w-4 h-4" />
                    Confirmar
                  </Button>
                )}
                {sale.status === 'paid' && canRefundSale && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="gap-1"
                    onClick={() => {
                      onRefundSale(sale.id, sale.valor);
                      onOpenChange(false);
                    }}
                  >
                    <RotateCcw className="w-4 h-4" />
                    Estornar Tudo
                  </Button>
                )}
              </div>
            </div>

            {/* Warning for non-owner on pending */}
            {!canConfirmPayment && sale.status === 'pending' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border border-border">
                <ShieldAlert className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Somente o responsável pela venda pode confirmar o pagamento.
                </p>
              </div>
            )}

            {/* Warning for non-refund permission on paid */}
            {!canRefundSale && sale.status === 'paid' && (
              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border border-border">
                <ShieldAlert className="w-4 h-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Você não possui permissão para realizar estornos.
                </p>
              </div>
            )}

            <Separator />

            {/* Customer Info */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Cliente
              </h4>
              <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                <div className="p-2 rounded-full bg-primary/10">
                  <User className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <p className="font-medium">{contact?.nome || 'Cliente não encontrado'}</p>
                  {contact?.email && (
                    <p className="text-sm text-muted-foreground">{contact.email}</p>
                  )}
                </div>
                {sale.is_recurring && (
                  <Badge variant="outline" className="ml-auto gap-1">
                    <Repeat className="w-3 h-3" />
                    Retorno
                  </Badge>
                )}
              </div>
            </div>

            {/* Payment Info */}
            <div className="space-y-3">
              <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                Pagamento
              </h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <CreditCard className="w-4 h-4" />
                    <span className="text-xs">Método</span>
                  </div>
                  <p className="font-medium">{getPaymentMethodLabel(sale.metodo_pagamento)}</p>
                </div>
                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Calendar className="w-4 h-4" />
                    <span className="text-xs">Data</span>
                  </div>
                  <p className="font-medium">
                    {format(new Date(sale.created_at), 'dd/MM/yyyy', { locale: ptBR })}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(sale.created_at), 'HH:mm', { locale: ptBR })}
                  </p>
                </div>
              </div>
              {sale.convenio_nome && (
                <div className="p-3 rounded-lg bg-muted/50">
                  <div className="flex items-center gap-2 text-muted-foreground mb-1">
                    <Building className="w-4 h-4" />
                    <span className="text-xs">Convênio</span>
                  </div>
                  <p className="font-medium">{sale.convenio_nome}</p>
                </div>
              )}
            </div>

            <Separator />

            {/* Items */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
                  Itens da Venda
                </h4>
                <Badge variant="outline">{sale.items.length} item(s)</Badge>
              </div>
              
              <div className="space-y-2">
                {sale.items.map((item, index) => {
                  const product = getProductById(item.product_id);
                  const isRefunded = item.refunded;
                  const refundReason = item.refund_reason;
                  
                  return (
                    <div
                      key={item.id}
                      className={`p-3 rounded-lg border ${
                        isRefunded
                          ? 'bg-destructive/5 border-destructive/20'
                          : 'bg-card border-border'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <div className={`p-2 rounded-lg ${isRefunded ? 'bg-destructive/10' : 'bg-primary/10'}`}>
                            <Package className={`w-4 h-4 ${isRefunded ? 'text-destructive' : 'text-primary'}`} />
                          </div>
                          <div>
                            <p className={`font-medium ${isRefunded ? 'line-through text-muted-foreground' : ''}`}>
                              {product?.nome || 'Produto não encontrado'}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-xs text-muted-foreground">
                                {item.quantidade}x {formatCurrency(item.valor_unitario)}
                              </span>
                              {isRefunded && (
                                <Badge className="bg-destructive/10 text-destructive border-destructive/20 text-xs">
                                  Estornado
                                </Badge>
                              )}
                            </div>
                            {isRefunded && refundReason && (
                              <p className="text-xs text-muted-foreground mt-1 italic">
                                Motivo: {refundReason}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="text-right">
                          <p className={`font-bold ${isRefunded ? 'line-through text-muted-foreground' : ''}`}>
                            {formatCurrency(item.valor_total)}
                          </p>
                          {sale.status === 'paid' && !isRefunded && sale.items.length > 1 && canRefundSale && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-destructive hover:text-destructive hover:bg-destructive/10 mt-1 h-7 text-xs"
                              onClick={() =>
                                setItemRefundDialog({
                                  open: true,
                                  item,
                                  productName: product?.nome || 'Produto',
                                })
                              }
                            >
                              <RotateCcw className="w-3 h-3 mr-1" />
                              Estornar
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <Separator />

            {/* Totals */}
            <div className="space-y-2">
              {refundedItemsTotal > 0 && (
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Estornado</span>
                  <span className="line-through">{formatCurrency(refundedItemsTotal)}</span>
                </div>
              )}
              <div className="flex justify-between items-center">
                <span className="font-semibold">Total</span>
                <span className="text-xl font-bold text-primary">
                  {formatCurrency(sale.valor)}
                </span>
              </div>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Item Refund Dialog */}
      <ItemRefundDialog
        open={itemRefundDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setItemRefundDialog({ open: false, item: null, productName: '' });
          }
        }}
        productName={itemRefundDialog.productName}
        itemValue={itemRefundDialog.item?.valor_total || 0}
        onConfirm={handleItemRefundConfirm}
      />
    </>
  );
}
