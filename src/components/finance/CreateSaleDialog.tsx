import { useState, useMemo, useEffect, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useFinance, CreateSaleItem } from '@/contexts/FinanceContext';
import { PaymentMethod, Product } from '@/types/crm';
import { Plus, AlertCircle, CheckCircle, UserPlus, AlertTriangle, Trash2, Package } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

interface NewContactForm {
  nome: string;
  telefone: string;
  email: string;
  origem: string;
}

interface SaleItemForm {
  id: string;
  productId: string;
  quantidade: number;
  valorUnitario: string;
}

interface CreateSaleDialogProps {
  preSelectedContactId?: string;
  trigger?: ReactNode;
  onClose?: () => void;
}

export function CreateSaleDialog({ preSelectedContactId, trigger, onClose }: CreateSaleDialogProps) {
  const { contacts, products, createSale, canCreateSale, getContactFunnelStage, createContact, getContactById } = useFinance();
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [isCreatingNewContact, setIsCreatingNewContact] = useState(false);
  
  const [contactId, setContactId] = useState('');
  const [metodoPagamento, setMetodoPagamento] = useState<PaymentMethod | ''>('');
  const [convenioNome, setConvenioNome] = useState('');
  
  // Múltiplos itens da venda
  const [items, setItems] = useState<SaleItemForm[]>([
    { id: `item-${Date.now()}`, productId: '', quantidade: 1, valorUnitario: '' }
  ]);
  
  const [newContact, setNewContact] = useState<NewContactForm>({
    nome: '',
    telefone: '',
    email: '',
    origem: 'manual',
  });
  
  const [validation, setValidation] = useState<{ allowed: boolean; reason?: string } | null>(null);

  // Get available payment methods (intersection of all selected products)
  const availablePaymentMethods = useMemo(() => {
    const selectedProducts = items
      .map(item => products.find(p => p.id === item.productId))
      .filter((p): p is Product => !!p);
    
    if (selectedProducts.length === 0) return [];
    
    // Return intersection of all payment methods
    return selectedProducts.reduce<PaymentMethod[]>((acc, product, index) => {
      if (index === 0) return [...product.metodos_pagamento];
      return acc.filter(method => product.metodos_pagamento.includes(method));
    }, []);
  }, [items, products]);

  // Get available convenios (union of all selected products)
  const availableConvenios = useMemo(() => {
    const selectedProducts = items
      .map(item => products.find(p => p.id === item.productId))
      .filter((p): p is Product => !!p);
    
    const conveniosSet = new Set<string>();
    selectedProducts.forEach(p => {
      p.convenios_aceitos.forEach(c => conveniosSet.add(c));
    });
    
    return Array.from(conveniosSet);
  }, [items, products]);

  // Calculate total value
  const valorTotal = useMemo(() => {
    return items.reduce((sum, item) => {
      const valor = parseFloat(item.valorUnitario) || 0;
      return sum + (valor * item.quantidade);
    }, 0);
  }, [items]);

  // Handle preSelectedContactId
  useEffect(() => {
    if (preSelectedContactId) {
      setContactId(preSelectedContactId);
      const result = canCreateSale(preSelectedContactId);
      setValidation(result);
      setOpen(true);
    }
  }, [preSelectedContactId, canCreateSale]);

  const handleContactChange = (value: string) => {
    if (value === 'new') {
      setIsCreatingNewContact(true);
      setContactId('');
      setValidation({ allowed: true });
    } else {
      setIsCreatingNewContact(false);
      setContactId(value);
      const result = canCreateSale(value);
      setValidation(result);
    }
  };

  const handleAddItem = () => {
    setItems(prev => [
      ...prev,
      { id: `item-${Date.now()}`, productId: '', quantidade: 1, valorUnitario: '' }
    ]);
  };

  const handleRemoveItem = (id: string) => {
    if (items.length <= 1) return;
    setItems(prev => prev.filter(item => item.id !== id));
  };

  const handleItemChange = (id: string, field: keyof SaleItemForm, value: string | number) => {
    setItems(prev => prev.map(item => {
      if (item.id !== id) return item;
      
      if (field === 'productId') {
        const product = products.find(p => p.id === value);
        return {
          ...item,
          productId: value as string,
          valorUnitario: product ? product.valor_padrao.toString() : '',
        };
      }
      
      return { ...item, [field]: value };
    }));
  };

  const handleSubmit = async () => {
    // Validations
    if (isCreatingNewContact) {
      if (!newContact.nome.trim() || !newContact.telefone.trim()) {
        toast.error('Nome e telefone são obrigatórios para novo cliente');
        return;
      }
    } else if (!contactId) {
      toast.error('Selecione um cliente');
      return;
    }

    // Validate items
    const validItems = items.filter(item => item.productId && parseFloat(item.valorUnitario) > 0);
    if (validItems.length === 0) {
      toast.error('Adicione pelo menos um produto válido');
      return;
    }

    if (!metodoPagamento) {
      toast.error('Selecione o método de pagamento');
      return;
    }

    if (metodoPagamento === 'convenio' && !convenioNome.trim()) {
      toast.error('Informe o nome do convênio');
      return;
    }

    let finalContactId = contactId;

    // Create new contact if needed
    if (isCreatingNewContact) {
      const newContactResult = await createContact({
        nome: newContact.nome.trim(),
        telefone: newContact.telefone.trim(),
        email: newContact.email.trim() || null,
        origem: newContact.origem || 'manual',
      });
      
      if (!newContactResult.success || !newContactResult.contactId) {
        toast.error(newContactResult.error || 'Erro ao criar cliente');
        return;
      }
      finalContactId = newContactResult.contactId;
    }

    // Build items for API
    const saleItems: CreateSaleItem[] = validItems.map(item => ({
      productId: item.productId,
      quantidade: item.quantidade,
      valorUnitario: parseFloat(item.valorUnitario),
    }));

    // Create sale (may be async in backend mode)
    const result = await createSale({
      contactId: finalContactId,
      items: saleItems,
      metodoPagamento: metodoPagamento as PaymentMethod,
      responsavelId: user?.id || 'user-admin-1',
      convenioNome: metodoPagamento === 'convenio' ? convenioNome : undefined,
      skipValidation: isCreatingNewContact,
    });

    if (result.success) {
      const contactName = isCreatingNewContact ? newContact.nome : getContactById(finalContactId)?.nome || 'Cliente';
      toast.success(`Venda registrada para ${contactName}!`);
      handleClose();
    } else {
      toast.error(result.error || 'Erro ao criar venda');
    }
  };

  const handleClose = () => {
    setOpen(false);
    resetForm();
    onClose?.();
  };

  const resetForm = () => {
    setContactId('');
    setMetodoPagamento('');
    setConvenioNome('');
    setItems([{ id: `item-${Date.now()}`, productId: '', quantidade: 1, valorUnitario: '' }]);
    setNewContact({ nome: '', telefone: '', email: '', origem: 'manual' });
    setValidation(null);
    setIsCreatingNewContact(false);
  };

  // All contacts are eligible for sales
  const eligibleContacts = contacts;

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  // Get pre-selected contact name for display
  const preSelectedContact = preSelectedContactId
    ? contacts.find((c) => c.id === preSelectedContactId)
    : null;

  // Check if any item has value different from default
  const hasValueDifferentFromDefault = useMemo(() => {
    return items.some(item => {
      const product = products.find(p => p.id === item.productId);
      if (!product || !item.valorUnitario) return false;
      return parseFloat(item.valorUnitario) !== product.valor_padrao;
    });
  }, [items, products]);

  // Determine if form is valid
  const isFormValid = useMemo(() => {
    // Check contact
    if (isCreatingNewContact) {
      if (!newContact.nome.trim() || !newContact.telefone.trim()) return false;
    } else if (!preSelectedContactId && !contactId) {
      return false;
    } else if (!preSelectedContactId && !isCreatingNewContact && !validation?.allowed) {
      return false;
    } else if (preSelectedContactId && !validation?.allowed) {
      return false;
    }

    // Check items
    const hasValidItem = items.some(item => 
      item.productId && parseFloat(item.valorUnitario) > 0
    );
    if (!hasValidItem) return false;

    // Check payment method
    if (!metodoPagamento) return false;

    // Check convenio name if needed
    if (metodoPagamento === 'convenio' && !convenioNome.trim()) return false;

    return true;
  }, [isCreatingNewContact, newContact, preSelectedContactId, contactId, validation, items, metodoPagamento, convenioNome]);

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          handleClose();
        } else {
          setOpen(true);
        }
      }}
    >
      {trigger ? (
        <DialogTrigger asChild>{trigger}</DialogTrigger>
      ) : (
        <DialogTrigger asChild>
          <Button className="gap-2">
            <Plus className="w-4 h-4" />
            Nova Venda
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>Registrar Nova Venda</DialogTitle>
          <DialogDescription>
            Adicione produtos e serviços para registrar uma venda.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {/* Contact Selection */}
          <div className="space-y-2">
            <Label htmlFor="contact">Cliente *</Label>
            {preSelectedContactId && preSelectedContact ? (
              <div className="p-3 rounded-lg bg-muted/50 border border-border">
                <p className="font-medium">{preSelectedContact.nome}</p>
                <p className="text-sm text-muted-foreground">{preSelectedContact.telefone}</p>
              </div>
            ) : (
              <Select 
                value={isCreatingNewContact ? 'new' : contactId} 
                onValueChange={handleContactChange}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o cliente" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="new">
                    <div className="flex items-center gap-2">
                      <UserPlus className="w-4 h-4 text-primary" />
                      <span className="font-medium">Cliente novo</span>
                    </div>
                  </SelectItem>
                  {eligibleContacts.length === 0 ? (
                    <SelectItem value="none" disabled>
                      Nenhum contato cadastrado
                    </SelectItem>
                  ) : (
                    eligibleContacts.map((contact) => {
                      const stage = getContactFunnelStage(contact.id);
                      return (
                        <SelectItem key={contact.id} value={contact.id}>
                          <div className="flex items-center gap-2">
                            <span>{contact.nome}</span>
                            <span className="text-xs text-muted-foreground">— {stage}</span>
                          </div>
                        </SelectItem>
                      );
                    })
                  )}
                </SelectContent>
              </Select>
            )}

            {/* Validation feedback for existing contact */}
            {!isCreatingNewContact && !preSelectedContactId && validation && contactId && (
              <Alert
                variant={validation.allowed ? 'default' : 'destructive'}
                className="mt-2"
              >
                {validation.allowed ? (
                  <CheckCircle className="h-4 w-4" />
                ) : (
                  <AlertCircle className="h-4 w-4" />
                )}
                <AlertDescription>
                  {validation.allowed
                    ? 'Lead elegível para venda'
                    : validation.reason}
                </AlertDescription>
              </Alert>
            )}
          </div>

          {/* New Contact Form */}
          {isCreatingNewContact && !preSelectedContactId && (
            <div className="space-y-3 p-4 bg-muted/50 rounded-lg border border-border">
              <p className="text-sm font-medium text-muted-foreground">Dados do novo cliente</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="nome" className="text-xs">Nome *</Label>
                  <Input
                    id="nome"
                    value={newContact.nome}
                    onChange={(e) => setNewContact((prev) => ({ ...prev, nome: e.target.value }))}
                    placeholder="Nome completo"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="telefone" className="text-xs">Telefone *</Label>
                  <Input
                    id="telefone"
                    value={newContact.telefone}
                    onChange={(e) => setNewContact((prev) => ({ ...prev, telefone: e.target.value }))}
                    placeholder="+55 11 99999-9999"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="email" className="text-xs">Email (opcional)</Label>
                  <Input
                    id="email"
                    type="email"
                    value={newContact.email}
                    onChange={(e) => setNewContact((prev) => ({ ...prev, email: e.target.value }))}
                    placeholder="email@exemplo.com"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="origem" className="text-xs">Origem</Label>
                  <Select
                    value={newContact.origem}
                    onValueChange={(v) => setNewContact((prev) => ({ ...prev, origem: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="manual">Manual</SelectItem>
                      <SelectItem value="whatsapp">WhatsApp</SelectItem>
                      <SelectItem value="instagram">Instagram</SelectItem>
                      <SelectItem value="site">Site</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          )}

          <Separator />

          {/* Products/Items Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Label className="flex items-center gap-2">
                <Package className="w-4 h-4" />
                Produtos / Procedimentos *
              </Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddItem}
                className="gap-1"
              >
                <Plus className="w-3 h-3" />
                Adicionar Item
              </Button>
            </div>

            <div className="space-y-3">
              {items.map((item, index) => {
                const product = products.find(p => p.id === item.productId);
                const valorDiffers = product && item.valorUnitario && 
                  parseFloat(item.valorUnitario) !== product.valor_padrao;
                
                return (
                  <Card key={item.id} className="border-border">
                    <CardContent className="p-3 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          Item {index + 1}
                        </span>
                        {items.length > 1 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive hover:text-destructive"
                            onClick={() => handleRemoveItem(item.id)}
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="sm:col-span-2 space-y-1">
                          <Label className="text-xs">Produto</Label>
                          <Select 
                            value={item.productId} 
                            onValueChange={(v) => handleItemChange(item.id, 'productId', v)}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Selecione" />
                            </SelectTrigger>
                            <SelectContent>
                              {products.length === 0 ? (
                                <SelectItem value="none" disabled>
                                  Nenhum produto cadastrado
                                </SelectItem>
                              ) : (
                                products.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    <div className="flex items-center justify-between gap-4 w-full">
                                      <span>{p.nome}</span>
                                      <span className="text-xs text-muted-foreground">
                                        {formatCurrency(p.valor_padrao)}
                                      </span>
                                    </div>
                                  </SelectItem>
                                ))
                              )}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-xs">Qtd.</Label>
                          <Input
                            type="number"
                            min="1"
                            value={item.quantidade}
                            onChange={(e) => handleItemChange(item.id, 'quantidade', parseInt(e.target.value) || 1)}
                            className="text-center"
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs">Valor Unitário</Label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                              R$
                            </span>
                            <Input
                              type="number"
                              step="0.01"
                              min="0"
                              value={item.valorUnitario}
                              onChange={(e) => handleItemChange(item.id, 'valorUnitario', e.target.value)}
                              className="pl-10"
                              placeholder="0,00"
                            />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Subtotal</Label>
                          <div className="h-9 px-3 flex items-center rounded-md border border-input bg-muted/50 text-sm font-medium">
                            {formatCurrency((parseFloat(item.valorUnitario) || 0) * item.quantidade)}
                          </div>
                        </div>
                      </div>

                      {valorDiffers && (
                        <Alert className="py-2 bg-warning/10 border-warning/20">
                          <AlertTriangle className="h-3 w-3 text-warning" />
                          <AlertDescription className="text-xs">
                            Valor diferente do padrão ({formatCurrency(product.valor_padrao)})
                          </AlertDescription>
                        </Alert>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Total */}
            <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg border border-border">
              <span className="font-medium">Total da Venda</span>
              <span className="text-xl font-bold text-primary">
                {formatCurrency(valorTotal)}
              </span>
            </div>
          </div>

          <Separator />

          {/* Payment Method */}
          <div className="space-y-2">
            <Label htmlFor="paymentMethod">Método de Pagamento *</Label>
            <Select
              value={metodoPagamento}
              onValueChange={(v) => {
                setMetodoPagamento(v as PaymentMethod);
                if (v !== 'convenio') setConvenioNome('');
              }}
              disabled={availablePaymentMethods.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder={availablePaymentMethods.length === 0 ? 'Selecione um produto primeiro' : 'Selecione'} />
              </SelectTrigger>
              <SelectContent>
                {availablePaymentMethods.map((method) => (
                  <SelectItem key={method} value={method}>
                    {method === 'pix' && 'PIX'}
                    {method === 'debito' && 'Débito'}
                    {method === 'credito' && 'Crédito'}
                    {method === 'boleto' && 'Boleto'}
                    {method === 'dinheiro' && 'Dinheiro'}
                    {method === 'convenio' && 'Convênio'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Convenio Name (if convenio selected) */}
          {metodoPagamento === 'convenio' && (
            <div className="space-y-2">
              <Label htmlFor="convenioNome">Nome do Convênio *</Label>
              {availableConvenios.length > 0 ? (
                <Select
                  value={convenioNome}
                  onValueChange={setConvenioNome}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Selecione o convênio" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableConvenios.map((convenio) => (
                      <SelectItem key={convenio} value={convenio}>
                        {convenio}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="convenioNome"
                  value={convenioNome}
                  onChange={(e) => setConvenioNome(e.target.value)}
                  placeholder="Ex: Unimed, Bradesco Saúde..."
                />
              )}
            </div>
          )}

          {/* Status info */}
          <Alert className="bg-muted/50">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription className="text-sm">
              A venda será criada com status <strong>PENDENTE</strong>. 
              Altere para <strong>PAGA</strong> quando o pagamento for confirmado.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter className="flex-shrink-0 flex-col sm:flex-row gap-3">
          <Button variant="outline" onClick={handleClose} className="w-full sm:w-auto">
            Cancelar
          </Button>
          <Button onClick={handleSubmit} disabled={!isFormValid} className="w-full sm:w-auto">
            Registrar Venda
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
