import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Package, Star, TrendingUp, TrendingDown, AlertTriangle, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ProductAnalysis {
  id: string;
  nome: string;
  unidadesVendidas: number;
  receita: number;
  ticketMedio: number;
  participacao: number;
  tendencia: 'up' | 'down' | 'stable';
  classification: 'star' | 'opportunity' | 'risk' | 'normal';
}

interface ProductAnalysisTableProps {
  products: ProductAnalysis[];
  totalRevenue: number;
}

export function ProductAnalysisTable({ products, totalRevenue }: ProductAnalysisTableProps) {
  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const getClassificationBadge = (classification: ProductAnalysis['classification']) => {
    switch (classification) {
      case 'star':
        return (
          <Badge className="bg-warning/10 text-warning border-warning/30 gap-1">
            <Star className="w-3 h-3 fill-current" />
            Estrela
          </Badge>
        );
      case 'opportunity':
        return (
          <Badge className="bg-primary/10 text-primary border-primary/30 gap-1">
            <Sparkles className="w-3 h-3" />
            Oportunidade
          </Badge>
        );
      case 'risk':
        return (
          <Badge className="bg-destructive/10 text-destructive border-destructive/30 gap-1">
            <AlertTriangle className="w-3 h-3" />
            Atenção
          </Badge>
        );
      default:
        return null;
    }
  };

  const getTrendIcon = (trend: ProductAnalysis['tendencia']) => {
    switch (trend) {
      case 'up':
        return <TrendingUp className="w-4 h-4 text-success" />;
      case 'down':
        return <TrendingDown className="w-4 h-4 text-destructive" />;
      default:
        return <span className="text-muted-foreground text-xs">—</span>;
    }
  };

  const maxRevenue = Math.max(...products.map(p => p.receita), 1);

  // Highlight products
  const starProduct = products.find(p => p.classification === 'star');
  const opportunityProduct = products.find(p => p.classification === 'opportunity');
  const riskProduct = products.find(p => p.classification === 'risk');

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <Package className="w-5 h-5 text-primary" />
          </div>
          <div>
            <CardTitle className="text-base">Análise de Produtos</CardTitle>
            <p className="text-xs text-muted-foreground">Performance detalhada por produto</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Highlight Cards */}
        <div className="grid grid-cols-1 xs:grid-cols-2 sm:grid-cols-3 gap-3">
          {starProduct && (
            <div className="p-3 rounded-lg bg-warning/5 border border-warning/20">
              <div className="flex items-center gap-2 mb-2">
                <Star className="w-4 h-4 text-warning fill-warning" />
                <span className="text-xs font-medium text-warning">Produto Estrela</span>
              </div>
              <p className="font-semibold text-sm truncate">{starProduct.nome}</p>
              <p className="text-xs text-muted-foreground">{starProduct.unidadesVendidas} vendas · {formatCurrency(starProduct.receita)}</p>
            </div>
          )}
          {opportunityProduct && (
            <div className="p-3 rounded-lg bg-primary/5 border border-primary/20">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-4 h-4 text-primary" />
                <span className="text-xs font-medium text-primary">Oportunidade</span>
              </div>
              <p className="font-semibold text-sm truncate">{opportunityProduct.nome}</p>
              <p className="text-xs text-muted-foreground">Ticket: {formatCurrency(opportunityProduct.ticketMedio)}</p>
            </div>
          )}
          {riskProduct && (
            <div className="p-3 rounded-lg bg-destructive/5 border border-destructive/20">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-destructive" />
                <span className="text-xs font-medium text-destructive">Requer Atenção</span>
              </div>
              <p className="font-semibold text-sm truncate">{riskProduct.nome}</p>
              <p className="text-xs text-muted-foreground">Apenas {riskProduct.unidadesVendidas} venda{riskProduct.unidadesVendidas !== 1 ? 's' : ''}</p>
            </div>
          )}
        </div>

        {/* Full Table */}
        <ScrollArea className="h-[280px] sm:h-[300px]">
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
            <Table className="min-w-[540px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[140px]">Produto</TableHead>
                  <TableHead className="text-center min-w-[60px]">Vendas</TableHead>
                  <TableHead className="text-right min-w-[90px]">Receita</TableHead>
                  <TableHead className="text-right min-w-[80px] hidden sm:table-cell">Ticket</TableHead>
                  <TableHead className="min-w-[90px] hidden md:table-cell">Participação</TableHead>
                  <TableHead className="text-center min-w-[50px]">Trend</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.map((product) => (
                  <TableRow 
                    key={product.id}
                    className={cn(
                      product.classification === 'star' && 'bg-warning/5',
                      product.classification === 'risk' && 'bg-destructive/5'
                    )}
                  >
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium truncate max-w-[140px]">{product.nome}</span>
                        {getClassificationBadge(product.classification)}
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge variant="secondary">{product.unidadesVendidas}</Badge>
                    </TableCell>
                    <TableCell className="text-right font-semibold text-success text-sm">
                      {formatCurrency(product.receita)}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-sm hidden sm:table-cell">
                      {formatCurrency(product.ticketMedio)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex items-center gap-2">
                        <Progress 
                          value={(product.receita / maxRevenue) * 100} 
                          className="h-2 flex-1" 
                        />
                        <span className="text-xs text-muted-foreground w-10">
                          {product.participacao.toFixed(1)}%
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-center">
                      {getTrendIcon(product.tendencia)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
