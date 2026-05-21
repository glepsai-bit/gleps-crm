import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { useProduct } from '@/contexts/ProductContext';
import { PaymentMethod } from '@/types/crm';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';

const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'pix', label: 'PIX' },
  { value: 'debito', label: 'Débito' },
  { value: 'credito', label: 'Crédito' },
  { value: 'boleto', label: 'Boleto' },
  { value: 'dinheiro', label: 'Dinheiro' },
  { value: 'convenio', label: 'Convênio' },
];

export function CreateProductDialog() {
  const { createProduct, convenios, addConvenio } = useProduct();
  const [open, setOpen] = useState(false);

  const [formData, setFormData] = useState({
    nome: '',
    valor_padrao: '',
    metodos_pagamento: [] as PaymentMethod[],
    convenios_aceitos: [] as string[],
    ativo: true,
  });

  const [newConvenio, setNewConvenio] = useState('');

  const hasConvenio = formData.metodos_pagamento.includes('convenio');

  const handleMethodToggle = (method: PaymentMethod) => {
    setFormData((prev) => {
      const hasMethod = prev.metodos_pagamento.includes(method);
      const newMethods = hasMethod
        ? prev.metodos_pagamento.filter((m) => m !== method)
        : [...prev.metodos_pagamento, method];
      
      // Clear convenios if convenio method is removed
      if (method === 'convenio' && hasMethod) {
        return { ...prev, metodos_pagamento: newMethods, convenios_aceitos: [] };
      }
      
      return { ...prev, metodos_pagamento: newMethods };
    });
  };

  const handleAddConvenio = () => {
    const trimmed = newConvenio.trim();
    if (!trimmed) return;
    
    if (!formData.convenios_aceitos.includes(trimmed)) {
      setFormData((prev) => ({
        ...prev,
        convenios_aceitos: [...prev.convenios_aceitos, trimmed],
      }));
      
      // Also add to global list if new
      addConvenio(trimmed);
    }
    setNewConvenio('');
  };

  const handleRemoveConvenio = (nome: string) => {
    setFormData((prev) => ({
      ...prev,
      convenios_aceitos: prev.convenios_aceitos.filter((c) => c !== nome),
    }));
  };

  const handleSelectExistingConvenio = (nome: string) => {
    if (!formData.convenios_aceitos.includes(nome)) {
      setFormData((prev) => ({
        ...prev,
        convenios_aceitos: [...prev.convenios_aceitos, nome],
      }));
    }
  };

  const handleSubmit = () => {
    const valor = parseFloat(formData.valor_padrao);
    
    const result = createProduct({
      nome: formData.nome,
      valor_padrao: valor,
      metodos_pagamento: formData.metodos_pagamento,
      convenios_aceitos: formData.convenios_aceitos,
      ativo: formData.ativo,
    });

    if (result.success) {
      toast.success(`Produto "${formData.nome}" criado com sucesso!`);
      handleClose();
    } else {
      toast.error(result.error || 'Erro ao criar produto');
    }
  };

  const handleClose = () => {
    setOpen(false);
    resetForm();
  };

  const resetForm = () => {
    setFormData({
      nome: '',
      valor_padrao: '',
      metodos_pagamento: [],
      convenios_aceitos: [],
      ativo: true,
    });
    setNewConvenio('');
  };

  const isFormValid = useMemo(() => {
    if (!formData.nome.trim()) return false;
    if (!formData.valor_padrao || parseFloat(formData.valor_padrao) <= 0) return false;
    if (formData.metodos_pagamento.length === 0) return false;
    return true;
  }, [formData]);

  // Available convenios not yet selected
  const availableConvenios = convenios.filter(
    (c) => !formData.convenios_aceitos.includes(c)
  );

  return (
    <Dialog open={open} onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          Novo Produto
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Novo Produto</DialogTitle>
          <DialogDescription>
            Cadastre um novo produto ou procedimento com seus métodos de pagamento aceitos.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 py-4 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {/* Nome */}
          <div className="space-y-2">
            <Label htmlFor="nome">Nome do Produto *</Label>
            <Input
              id="nome"
              value={formData.nome}
              onChange={(e) => setFormData((prev) => ({ ...prev, nome: e.target.value }))}
              placeholder="Ex: Consulta Inicial"
              maxLength={100}
            />
          </div>

          {/* Valor Padrão */}
          <div className="space-y-2">
            <Label htmlFor="valor">Valor Padrão *</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                R$
              </span>
              <Input
                id="valor"
                type="number"
                step="0.01"
                min="0"
                value={formData.valor_padrao}
                onChange={(e) => setFormData((prev) => ({ ...prev, valor_padrao: e.target.value }))}
                className="pl-10"
                placeholder="0,00"
              />
            </div>
          </div>

          {/* Métodos de Pagamento */}
          <div className="space-y-3">
            <Label>Meios de Pagamento Aceitos *</Label>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {PAYMENT_METHODS.map((method) => (
                <div
                  key={method.value}
                  className="flex items-center space-x-2"
                >
                  <Checkbox
                    id={`method-${method.value}`}
                    checked={formData.metodos_pagamento.includes(method.value)}
                    onCheckedChange={() => handleMethodToggle(method.value)}
                  />
                  <label
                    htmlFor={`method-${method.value}`}
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer"
                  >
                    {method.label}
                  </label>
                </div>
              ))}
            </div>
          </div>

          {/* Convênios Aceitos */}
          {hasConvenio && (
            <div className="space-y-3 p-4 bg-muted/50 rounded-lg border border-border">
              <Label>Convênios Aceitos</Label>
              
              {/* Selected Convenios */}
              {formData.convenios_aceitos.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {formData.convenios_aceitos.map((nome) => (
                    <Badge
                      key={nome}
                      variant="secondary"
                      className="gap-1 pr-1"
                    >
                      {nome}
                      <button
                        type="button"
                        onClick={() => handleRemoveConvenio(nome)}
                        className="ml-1 rounded-full p-0.5 hover:bg-destructive/20"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}

              {/* Add new convenio */}
              <div className="flex gap-2">
                <Input
                  value={newConvenio}
                  onChange={(e) => setNewConvenio(e.target.value)}
                  placeholder="Adicionar convênio..."
                  className="flex-1"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddConvenio();
                    }
                  }}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="secondary"
                  onClick={handleAddConvenio}
                  disabled={!newConvenio.trim()}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {/* Quick select from existing */}
              {availableConvenios.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Convênios cadastrados:</p>
                  <div className="flex flex-wrap gap-1">
                    {availableConvenios.map((nome) => (
                      <Badge
                        key={nome}
                        variant="outline"
                        className="cursor-pointer hover:bg-primary/10"
                        onClick={() => handleSelectExistingConvenio(nome)}
                      >
                        + {nome}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Status */}
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="status">Status</Label>
              <p className="text-sm text-muted-foreground">
                Produtos inativos não aparecem para seleção em vendas
              </p>
            </div>
            <Switch
              id="status"
              checked={formData.ativo}
              onCheckedChange={(checked) => setFormData((prev) => ({ ...prev, ativo: checked }))}
            />
          </div>
        </div>

        <DialogFooter className="flex-shrink-0 flex-col sm:flex-row gap-3">
          <Button variant="outline" onClick={handleClose} className="w-full sm:w-auto">
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={!isFormValid} className="w-full sm:w-auto">
            Salvar Produto
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
