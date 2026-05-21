import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RefundConfirmationDialog } from './RefundConfirmationDialog';
import { useFinance } from '@/contexts/FinanceContext';
import { Sale, SaleStatus, PaymentMethod } from '@/types/crm';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import {
  Search,
  MoreHorizontal,
  CheckCircle,
  XCircle,
  RotateCcw,
  Receipt,
} from 'lucide-react';
import { toast } from 'sonner';

interface SalesTableProps {
  isLoading?: boolean;
}

export function SalesTable({ isLoading = false }: SalesTableProps) {
  const { sales, getContactById, markAsPaid, cancelSale, refundSale } = useFinance();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<SaleStatus | 'all'>('all');
  const [refundDialog, setRefundDialog] = useState<{ open: boolean; sale: Sale | null }>({
    open: false,
    sale: null,
  });

  const filteredSales = sales.filter((sale) => {
    const contact = getContactById(sale.contact_id);
    const matchesSearch = !searchTerm.trim() || contact?.nome?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesStatus = statusFilter === 'all' || sale.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const getStatusBadge = (status: SaleStatus) => {
    switch (status) {
      case 'paid':
        return <Badge className="bg-success/10 text-success border-success/20">Pago</Badge>;
      case 'pending':
        return <Badge className="bg-warning/10 text-warning border-warning/20">Pendente</Badge>;
      case 'refunded':
        return <Badge className="bg-primary/10 text-primary border-primary/20">Estornado</Badge>;
      default:
        return <Badge variant="outline">-</Badge>;
    }
  };

  const getPaymentMethodBadge = (method: PaymentMethod | null) => {
    const labels: Record<PaymentMethod, string> = {
      pix: 'PIX',
      debito: 'Débito',
      credito: 'Crédito',
      boleto: 'Boleto',
      dinheiro: 'Dinheiro',
      convenio: 'Convênio',
    };
    return method ? (
      <Badge variant="secondary">{labels[method]}</Badge>
    ) : (
      <Badge variant="outline">-</Badge>
    );
  };

  const handleMarkAsPaid = (saleId: string) => {
    markAsPaid(saleId);
    toast.success('Pagamento confirmado!');
  };

  const handleCancelSale = (saleId: string) => {
    cancelSale(saleId);
    toast.success('Venda cancelada!');
  };

  const handleRefundConfirm = async (reason: string, password: string) => {
    if (!refundDialog.sale) return;
    await refundSale(refundDialog.sale.id, reason, password);
    setRefundDialog({ open: false, sale: null });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="p-3 sm:p-6 pb-3 sm:pb-4">
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Receipt className="w-4 h-4 sm:w-5 sm:h-5 text-primary shrink-0" />
              <CardTitle className="text-sm sm:text-base font-semibold">Tabela de Vendas</CardTitle>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <div className="relative flex-1 sm:flex-none">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar cliente..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-9 w-full sm:w-48 md:w-64 h-9 text-sm"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as SaleStatus | 'all')}
              >
                <SelectTrigger className="w-full sm:w-32 md:w-40 h-9 text-sm">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="paid">Pago</SelectItem>
                  <SelectItem value="pending">Pendente</SelectItem>
                  <SelectItem value="refunded">Estornado</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-3 sm:p-6 pt-0 sm:pt-0">
          <div className="rounded-md border overflow-x-auto -mx-3 sm:mx-0">
            <Table className="min-w-[400px] sm:min-w-[500px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs sm:text-sm min-w-[80px] sm:min-w-[120px]">Cliente</TableHead>
                  <TableHead className="text-xs sm:text-sm min-w-[70px] sm:min-w-[80px]">Valor</TableHead>
                  <TableHead className="text-xs sm:text-sm min-w-[70px] hidden sm:table-cell">Pagamento</TableHead>
                  <TableHead className="text-xs sm:text-sm min-w-[60px] sm:min-w-[80px]">Status</TableHead>
                  <TableHead className="text-xs sm:text-sm min-w-[90px] hidden md:table-cell">Data</TableHead>
                  <TableHead className="text-xs sm:text-sm text-right min-w-[50px] sm:min-w-[60px]">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredSales.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-6 sm:py-8 text-xs sm:text-sm text-muted-foreground">
                      Nenhuma venda encontrada
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredSales.map((sale) => {
                    const contact = getContactById(sale.contact_id);
                    return (
                      <TableRow key={sale.id}>
                        <TableCell className="font-medium text-xs sm:text-sm truncate max-w-[80px] sm:max-w-[150px]">
                          {contact?.nome || 'Cliente não encontrado'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs sm:text-sm">{formatCurrency(sale.valor)}</TableCell>
                        <TableCell className="hidden sm:table-cell">{getPaymentMethodBadge(sale.metodo_pagamento)}</TableCell>
                        <TableCell>{getStatusBadge(sale.status)}</TableCell>
                        <TableCell className="hidden md:table-cell whitespace-nowrap text-xs sm:text-sm">
                          {format(new Date(sale.created_at), 'dd/MM HH:mm', {
                            locale: ptBR,
                          })}
                        </TableCell>
                        <TableCell className="text-right p-1 sm:p-4">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 sm:h-9 sm:w-9">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {sale.status === 'pending' && (
                                <>
                                  <DropdownMenuItem onClick={() => handleMarkAsPaid(sale.id)}>
                                    <CheckCircle className="w-4 h-4 mr-2 text-success" />
                                    Marcar como Pago
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleCancelSale(sale.id)}>
                                    <XCircle className="w-4 h-4 mr-2 text-destructive" />
                                    Cancelar Venda
                                  </DropdownMenuItem>
                                </>
                              )}
                              {sale.status === 'paid' && (
                                <DropdownMenuItem
                                  onClick={() => setRefundDialog({ open: true, sale })}
                                >
                                  <RotateCcw className="w-4 h-4 mr-2 text-warning" />
                                  Estornar Venda
                                </DropdownMenuItem>
                              )}
                              {sale.status === 'refunded' && (
                                <DropdownMenuItem disabled>
                                  Nenhuma ação disponível
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Refund Dialog with Password Confirmation */}
      <RefundConfirmationDialog
        open={refundDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setRefundDialog({ open: false, sale: null });
          }
        }}
        saleValue={refundDialog.sale?.valor || 0}
        onConfirm={handleRefundConfirm}
      />
    </>
  );
}
