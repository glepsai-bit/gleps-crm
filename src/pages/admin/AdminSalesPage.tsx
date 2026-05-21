import { useState, useMemo } from 'react';
import { useFinance } from '@/contexts/FinanceContext';
import { useAuth, useRoleAccess } from '@/contexts/AuthContext';
import { Sale, SaleStatus } from '@/types/crm';
import { RefundConfirmationDialog } from '@/components/finance/RefundConfirmationDialog';
import { CreateSaleDialog } from '@/components/finance/CreateSaleDialog';
import { SaleItemsRow } from '@/components/finance/SaleItemsRow';
import { SaleDetailsSheet } from '@/components/finance/SaleDetailsSheet';
import { SalesAuditLog } from '@/components/finance/SalesAuditLog';
import { AgentFilter } from '@/components/dashboard/AgentFilter';
import { KPICard } from '@/components/dashboard/KPICard';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Plus,
  Search,
  DollarSign,
  TrendingUp,
  CheckCircle,
  Clock,
  FileText,
  ShoppingCart,
} from 'lucide-react';
import { toast } from 'sonner';

export default function AdminSalesPage() {
  const { user } = useAuth();
  const { isAdmin } = useRoleAccess();
  const { 
    sales, 
    getContactById, 
    markAsPaid, 
    refundSale,
    kpis,
  } = useFinance();

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<SaleStatus | 'all'>('all');
  const [selectedAgent, setSelectedAgent] = useState<string>('all');
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [activeTab, setActiveTab] = useState<'sales' | 'report'>('sales');
  const [refundDialog, setRefundDialog] = useState<{ open: boolean; saleId: string | null; valor: number }>({
    open: false,
    saleId: null,
    valor: 0,
  });

  const filteredSales = useMemo(() => {
    return sales.filter((sale) => {
      const contact = getContactById(sale.contact_id);
      const matchesSearch = !searchTerm.trim() || contact?.nome?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === 'all' || sale.status === statusFilter;
      
      // Filter by agent (responsavel_id)
      let matchesAgent = true;
      if (selectedAgent !== 'all' && isAdmin) {
        matchesAgent = sale.responsavel_id === selectedAgent;
      }
      
      return matchesSearch && matchesStatus && matchesAgent;
    });
  }, [sales, searchTerm, statusFilter, selectedAgent, isAdmin, getContactById]);

  // KPIs from context
  const totalRevenue = kpis.faturamentoBruto;
  const pendingSalesCount = kpis.vendasPendentes.count;
  const paidSalesCount = kpis.vendasPagas.count;
  const avgTicket = kpis.ticketMedio;

  const getContactName = (contactId: string) => {
    const contact = getContactById(contactId);
    return contact?.nome || 'Cliente';
  };

  const handleMarkAsPaid = (saleId: string) => {
    markAsPaid(saleId);
    toast.success('Pagamento confirmado!');
  };

  const handleRefundConfirm = async (reason: string, password: string) => {
    if (!refundDialog.saleId) return;
    await refundSale(refundDialog.saleId, reason, password);
    setRefundDialog({ open: false, saleId: null, valor: 0 });
  };

  const showTabs = isAdmin && user?.role === 'admin';

  // Sales content component to avoid duplication
  const SalesContent = () => (
    <>
      {/* KPI Cards */}
      <div className="kpi-grid">
        <KPICard
          title="Faturamento Total"
          subtitle="Vendas pagas"
          value={new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(totalRevenue)}
          icon={DollarSign}
          iconColor="text-success"
          iconBgColor="bg-success/10"
        />
        <KPICard
          title="Ticket Médio"
          subtitle="Média por venda"
          value={new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(avgTicket)}
          icon={TrendingUp}
          iconColor="text-primary"
          iconBgColor="bg-primary/10"
        />
        <KPICard
          title="Vendas Pagas"
          subtitle="Confirmados"
          value={paidSalesCount}
          icon={CheckCircle}
          iconColor="text-success"
          iconBgColor="bg-success/10"
        />
        <KPICard
          title="Pendentes"
          subtitle="Aguardando"
          value={pendingSalesCount}
          icon={Clock}
          iconColor="text-warning"
          iconBgColor="bg-warning/10"
        />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="filter-container">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por cliente..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 min-h-[40px]"
              />
            </div>
            <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as SaleStatus | 'all')}>
              <SelectTrigger className="w-full sm:w-[160px] min-h-[40px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos os status</SelectItem>
                <SelectItem value="paid">Pagos</SelectItem>
                <SelectItem value="pending">Pendentes</SelectItem>
                <SelectItem value="refunded">Estornados</SelectItem>
              </SelectContent>
            </Select>
            
            {/* Agent Filter - Only for Admins */}
            {showTabs && (
              <AgentFilter value={selectedAgent} onChange={setSelectedAgent} />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-[700px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[130px]">Cliente</TableHead>
                  <TableHead className="min-w-[120px]">Produtos</TableHead>
                  <TableHead className="min-w-[100px]">Valor Total</TableHead>
                  <TableHead className="hidden md:table-cell min-w-[90px]">Método</TableHead>
                  <TableHead className="min-w-[90px]">Status</TableHead>
                  <TableHead className="hidden sm:table-cell min-w-[90px]">Data</TableHead>
                  <TableHead className="text-right min-w-[80px]">Ações</TableHead>
                </TableRow>
              </TableHeader>
            <TableBody>
              {filteredSales.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                    Nenhuma venda encontrada
                  </TableCell>
                </TableRow>
              ) : (
                filteredSales.map((sale) => (
                  <SaleItemsRow
                    key={sale.id}
                    sale={sale}
                    contactName={getContactName(sale.contact_id)}
                    onMarkAsPaid={handleMarkAsPaid}
                    onRefundSale={(saleId, valor) => setRefundDialog({ open: true, saleId, valor })}
                    onInspect={(sale) => setSelectedSale(sale)}
                  />
                ))
              )}
            </TableBody>
          </Table>
          </div>
        </CardContent>
      </Card>
    </>
  );

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div className="min-w-0">
          <h1 className="title-responsive text-foreground">Vendas</h1>
          <p className="text-responsive-sm text-muted-foreground">Gerencie vendas e pagamentos</p>
        </div>
        <CreateSaleDialog
          trigger={
            <Button className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2 min-h-[40px] sm:min-h-0">
              <Plus className="w-4 h-4" />
              <span className="hidden xs:inline">Nova Venda</span>
              <span className="xs:hidden">Nova</span>
            </Button>
          }
        />
      </div>

      {/* Conditional Tabs for Admins */}
      {showTabs ? (
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'sales' | 'report')}>
          <TabsList className="bg-muted">
            <TabsTrigger value="sales" className="gap-2">
              <ShoppingCart className="w-4 h-4" />
              Vendas
            </TabsTrigger>
            <TabsTrigger value="report" className="gap-2">
              <FileText className="w-4 h-4" />
              Relatório
            </TabsTrigger>
          </TabsList>

          <TabsContent value="sales" className="mt-6 space-y-6">
            <SalesContent />
          </TabsContent>

          <TabsContent value="report" className="mt-6">
            <SalesAuditLog />
          </TabsContent>
        </Tabs>
      ) : (
        <div className="space-y-6">
          <SalesContent />
        </div>
      )}

      {/* Refund Dialog with Password Confirmation */}
      <RefundConfirmationDialog
        open={refundDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setRefundDialog({ open: false, saleId: null, valor: 0 });
          }
        }}
        saleValue={refundDialog.valor}
        onConfirm={handleRefundConfirm}
      />

      {/* Sale Details Sheet */}
      <SaleDetailsSheet
        sale={selectedSale}
        open={!!selectedSale}
        onOpenChange={(open) => {
          if (!open) setSelectedSale(null);
        }}
        onMarkAsPaid={handleMarkAsPaid}
        onRefundSale={(saleId, valor) => setRefundDialog({ open: true, saleId, valor })}
      />
    </div>
  );
}
