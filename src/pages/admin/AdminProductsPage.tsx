import { useState, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useProduct } from '@/contexts/ProductContext';
import { CreateProductDialog, EditProductDialog, DeleteProductDialog } from '@/components/products';
import { Product, PaymentMethod } from '@/types/crm';
import { Search, MoreVertical, Pencil, ToggleLeft, ToggleRight, Package, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  pix: 'PIX',
  debito: 'Débito',
  credito: 'Crédito',
  boleto: 'Boleto',
  dinheiro: 'Dinheiro',
  convenio: 'Convênio',
};

const PAYMENT_METHOD_COLORS: Record<PaymentMethod, string> = {
  pix: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  debito: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  credito: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  boleto: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  dinheiro: 'bg-green-500/20 text-green-400 border-green-500/30',
  convenio: 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30',
};

export default function AdminProductsPage() {
  const { products, toggleProductStatus, deleteProduct } = useProduct();
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [deletingProduct, setDeletingProduct] = useState<Product | null>(null);

  const filteredProducts = useMemo(() => {
    return products.filter((product) => {
      const matchesSearch = product.nome.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'active' && product.ativo) ||
        (statusFilter === 'inactive' && !product.ativo);
      return matchesSearch && matchesStatus;
    });
  }, [products, searchTerm, statusFilter]);

  const handleToggleStatus = (product: Product) => {
    const result = toggleProductStatus(product.id);
    if (result.success) {
      toast.success(`Produto "${product.nome}" ${product.ativo ? 'desativado' : 'ativado'}`);
    } else {
      toast.error(result.error || 'Erro ao alterar status');
    }
  };

  const handleDeleteProduct = (product: Product) => {
    const result = deleteProduct(product.id);
    if (result.success) {
      toast.success(`Produto "${product.nome}" excluído com sucesso`);
    } else {
      toast.error(result.error || 'Erro ao excluir produto');
    }
  };

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">Produtos & Procedimentos</h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Cadastre os serviços oferecidos e defina os meios de pagamento aceitos
          </p>
        </div>
        <CreateProductDialog />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar produto..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
              />
            </div>
            <Select
              value={statusFilter}
              onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}
            >
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos</SelectItem>
                <SelectItem value="active">Ativos</SelectItem>
                <SelectItem value="inactive">Inativos</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Products Table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Package className="h-5 w-5" />
            Produtos Cadastrados
          </CardTitle>
          <CardDescription>
            {filteredProducts.length} produto{filteredProducts.length !== 1 ? 's' : ''} encontrado{filteredProducts.length !== 1 ? 's' : ''}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {filteredProducts.length === 0 ? (
            <div className="text-center py-12">
              <Package className="h-12 w-12 mx-auto text-muted-foreground/50" />
              <h3 className="mt-4 text-lg font-semibold">Nenhum produto encontrado</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {searchTerm || statusFilter !== 'all'
                  ? 'Tente ajustar os filtros'
                  : 'Comece cadastrando um novo produto'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table className="min-w-[600px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[150px]">Nome</TableHead>
                    <TableHead className="text-right min-w-[100px]">Valor Padrão</TableHead>
                    <TableHead className="min-w-[180px] hidden sm:table-cell">Meios de Pagamento</TableHead>
                    <TableHead className="text-center min-w-[80px]">Status</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProducts.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell className="font-medium">{product.nome}</TableCell>
                      <TableCell className="text-right">
                        {formatCurrency(product.valor_padrao)}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {product.metodos_pagamento.map((method) => (
                            <Badge
                              key={method}
                              variant="outline"
                              className={PAYMENT_METHOD_COLORS[method]}
                            >
                              {PAYMENT_METHOD_LABELS[method]}
                              {method === 'convenio' && product.convenios_aceitos?.length > 0 && (
                                <span className="ml-1">({product.convenios_aceitos.length})</span>
                              )}
                            </Badge>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge
                          variant={product.ativo ? 'default' : 'secondary'}
                          className={
                            product.ativo
                              ? 'bg-green-500/20 text-green-400 border-green-500/30'
                              : 'bg-muted text-muted-foreground'
                          }
                        >
                          {product.ativo ? 'Ativo' : 'Inativo'}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreVertical className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setEditingProduct(product)}>
                              <Pencil className="h-4 w-4 mr-2" />
                              Editar
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => handleToggleStatus(product)}>
                              {product.ativo ? (
                                <>
                                  <ToggleLeft className="h-4 w-4 mr-2" />
                                  Desativar
                                </>
                              ) : (
                                <>
                                  <ToggleRight className="h-4 w-4 mr-2" />
                                  Ativar
                                </>
                              )}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem 
                              onClick={() => setDeletingProduct(product)}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Excluir
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      {editingProduct && (
        <EditProductDialog
          product={editingProduct}
          open={!!editingProduct}
          onOpenChange={(open) => !open && setEditingProduct(null)}
        />
      )}

      {/* Delete Dialog */}
      {deletingProduct && (
        <DeleteProductDialog
          open={!!deletingProduct}
          onOpenChange={(open) => !open && setDeletingProduct(null)}
          productName={deletingProduct.nome}
          onConfirm={() => handleDeleteProduct(deletingProduct)}
        />
      )}
    </div>
  );
}
