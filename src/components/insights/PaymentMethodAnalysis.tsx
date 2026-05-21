import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { CreditCard, TrendingUp, Zap } from 'lucide-react';

interface PaymentMethodData {
  method: string;
  label: string;
  count: number;
  revenue: number;
  ticketMedio: number;
  participacao: number;
}

interface PaymentMethodAnalysisProps {
  data: PaymentMethodData[];
  highlightInsight: string | null;
}

export function PaymentMethodAnalysis({ data, highlightInsight }: PaymentMethodAnalysisProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const maxRevenue = Math.max(...data.map(d => d.revenue), 1);
  const topMethod = data.length > 0 ? data[0] : null;
  const highestTicket = data.length > 0 
    ? data.reduce((a, b) => a.ticketMedio > b.ticketMedio ? a : b)
    : null;

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <CreditCard className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">Métodos de Pagamento</CardTitle>
            <p className="text-xs text-muted-foreground">Análise por forma de pagamento</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Quick Insights */}
        <div className="grid grid-cols-2 gap-3">
          {topMethod && (
            <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
              <div className="flex items-center gap-1 mb-1">
                <TrendingUp className="w-3 h-3 text-primary" />
                <span className="text-xs font-medium text-primary">Mais usado</span>
              </div>
              <p className="font-semibold text-sm">{topMethod.label}</p>
              <p className="text-xs text-muted-foreground">{topMethod.participacao.toFixed(1)}% das vendas</p>
            </div>
          )}
          {highestTicket && highestTicket.method !== topMethod?.method && (
            <div className="p-3 rounded-lg bg-success/5 border border-success/20">
              <div className="flex items-center gap-1 mb-1">
                <Zap className="w-3 h-3 text-success" />
                <span className="text-xs font-medium text-success">Maior ticket</span>
              </div>
              <p className="font-semibold text-sm">{highestTicket.label}</p>
              <p className="text-xs text-muted-foreground">{formatCurrency(highestTicket.ticketMedio)}</p>
            </div>
          )}
        </div>

        {/* Insight Highlight */}
        {highlightInsight && (
          <div className="p-3 rounded-lg bg-warning/5 border border-warning/20">
            <p className="text-xs text-warning-foreground">💡 {highlightInsight}</p>
          </div>
        )}

        {/* Table */}
        <div className="overflow-x-auto">
          <Table className="min-w-[400px]">
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[120px]">Método</TableHead>
                <TableHead className="text-center">Vendas</TableHead>
                <TableHead className="text-right">Receita</TableHead>
                <TableHead className="text-right hidden sm:table-cell">Ticket</TableHead>
                <TableHead className="min-w-[100px]">Volume</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((item, index) => (
                <TableRow key={item.method} className={index === 0 ? 'bg-primary/5' : ''}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{item.label}</span>
                      {index === 0 && (
                        <Badge variant="secondary" className="text-xs">
                          #1
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-center">
                    <Badge variant="outline">{item.count}</Badge>
                  </TableCell>
                  <TableCell className="text-right font-semibold text-success">
                    {formatCurrency(item.revenue)}
                  </TableCell>
                  <TableCell className="text-right text-muted-foreground hidden sm:table-cell">
                    {formatCurrency(item.ticketMedio)}
                  </TableCell>
                  <TableCell>
                    <Progress value={(item.revenue / maxRevenue) * 100} className="h-2" />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
