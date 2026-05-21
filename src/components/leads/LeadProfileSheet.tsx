import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useFinance } from '@/contexts/FinanceContext';
import { Contact, Sale } from '@/types/crm';
import { mockFunnelStages } from '@/data/mockData';
import { CreateSaleDialog } from '@/components/finance/CreateSaleDialog';
import { RefundConfirmationDialog } from '@/components/finance/RefundConfirmationDialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Phone,
  Mail,
  Calendar,
  MessageSquare,
  DollarSign,
  User,
  Clock,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
  Send,
  ExternalLink,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';

interface LeadProfileSheetProps {
  contact: Contact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LeadProfileSheet({ contact, open, onOpenChange }: LeadProfileSheetProps) {
  const { user, account } = useAuth();
  const { 
    getContactSales, 
    getContactNotes, 
    getContactFunnelStage,
    getContactFunnelStageOrder,
    addLeadNote,
    getProductById,
    markAsPaid,
    refundSale,
  } = useFinance();

  const [newNote, setNewNote] = useState('');
  const [showSaleDialog, setShowSaleDialog] = useState(false);
  const [refundDialog, setRefundDialog] = useState<{ open: boolean; sale: Sale | null }>({
    open: false,
    sale: null,
  });

  if (!contact) return null;

  const sales = getContactSales(contact.id);
  const notes = getContactNotes(contact.id);
  const funnelStage = getContactFunnelStage(contact.id);
  const stageOrder = getContactFunnelStageOrder(contact.id);
  const canSell = stageOrder >= 3;

  const stage = mockFunnelStages.find((s) => s.nome === funnelStage);

  const getInitials = (name: string | null) => {
    if (!name) return '??';
    return name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  const getOriginLabel = (origem: string | null) => {
    switch (origem) {
      case 'whatsapp': return 'WhatsApp';
      case 'instagram': return 'Instagram';
      case 'site': return 'Site';
      default: return 'Manual';
    }
  };

  const getStatusBadge = (status: Sale['status']) => {
    switch (status) {
      case 'paid':
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20 gap-1"><CheckCircle className="w-3 h-3" />Paga</Badge>;
      case 'pending':
        return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20 gap-1"><AlertCircle className="w-3 h-3" />Pendente</Badge>;
      case 'refunded':
        return <Badge className="bg-red-500/10 text-red-500 border-red-500/20 gap-1"><XCircle className="w-3 h-3" />Estornada</Badge>;
      default:
        return <Badge variant="secondary">{status}</Badge>;
    }
  };

  const handleAddNote = () => {
    if (!newNote.trim()) return;
    
    addLeadNote(
      contact.id,
      newNote.trim(),
      user?.id || 'unknown',
      user?.nome || 'Usuário'
    );
    setNewNote('');
    toast.success('Anotação adicionada!');
  };

  const handleOpenChatwoot = () => {
    const baseUrl = account?.chatwoot_base_url?.replace(/\/$/, '');
    const accountId = account?.chatwoot_account_id;
    const conversationId = contact.chatwoot_conversation_id;

    if (!baseUrl || !accountId) {
      toast.error('Chatwoot não configurado para esta conta');
      return;
    }

    if (!conversationId) {
      toast.warning('Este lead não possui conversa vinculada no Chatwoot');
      return;
    }

    const url = `${baseUrl}/app/accounts/${accountId}/conversations/${conversationId}`;
    window.open(url, '_blank');
  };

  const handleMarkAsPaid = (saleId: string) => {
    markAsPaid(saleId);
    toast.success('Venda marcada como paga!');
  };

  const handleRefundConfirm = async (reason: string, password: string) => {
    if (!refundDialog.sale) return;
    await refundSale(refundDialog.sale.id, reason, password);
    setRefundDialog({ open: false, sale: null });
  };

  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent className="w-full sm:max-w-xl overflow-hidden flex flex-col">
          <SheetHeader className="pb-4">
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                <AvatarFallback className="bg-primary/10 text-primary text-xl">
                  {getInitials(contact.nome)}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1">
                <SheetTitle className="text-xl">{contact.nome || 'Sem nome'}</SheetTitle>
                <SheetDescription className="flex items-center gap-2 mt-1">
                  {stage && (
                    <Badge
                      variant="outline"
                      style={{
                        borderColor: stage.cor || '#0EA5E9',
                        color: stage.cor || '#0EA5E9',
                      }}
                    >
                      {stage.nome}
                    </Badge>
                  )}
                  <Badge variant="secondary">{getOriginLabel(contact.origem)}</Badge>
                </SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <ScrollArea className="flex-1 -mx-6 px-6">
            <div className="space-y-6 pb-6">
              {/* Contact Info */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <User className="w-4 h-4" />
                    Informações de Contato
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  {contact.telefone && (
                    <div className="flex items-center gap-3 text-sm">
                      <Phone className="w-4 h-4 text-muted-foreground" />
                      <span>{contact.telefone}</span>
                    </div>
                  )}
                  {contact.email && (
                    <div className="flex items-center gap-3 text-sm">
                      <Mail className="w-4 h-4 text-muted-foreground" />
                      <span>{contact.email}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Calendar className="w-4 h-4" />
                    <span>Criado em {format(new Date(contact.created_at), "dd 'de' MMMM 'de' yyyy", { locale: ptBR })}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Actions */}
              <div className="flex gap-2">
                <Button 
                  variant="outline" 
                  className="flex-1 gap-2"
                  onClick={handleOpenChatwoot}
                >
                  <ExternalLink className="w-4 h-4" />
                  Abrir Chatwoot
                </Button>
                {canSell && (
                  <Button 
                    className="flex-1 gap-2"
                    onClick={() => setShowSaleDialog(true)}
                  >
                    <DollarSign className="w-4 h-4" />
                    Nova Venda
                  </Button>
                )}
              </div>

              <Separator />

              {/* Sales History */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <DollarSign className="w-4 h-4" />
                    Histórico de Vendas ({sales.length})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {sales.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">
                      Nenhuma venda registrada
                    </p>
                  ) : (
                    <div className="space-y-3">
                      {sales.map((sale) => {
                        const product = getProductById(sale.product_id);
                        return (
                          <div 
                            key={sale.id} 
                            className="p-3 rounded-lg border bg-muted/30 space-y-2"
                          >
                            <div className="flex items-start justify-between">
                              <div>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-sm">
                                    {product?.nome || 'Produto'}
                                  </span>
                                  {sale.is_recurring && (
                                    <Badge variant="outline" className="text-xs gap-1">
                                      <RefreshCw className="w-3 h-3" />
                                      Recorrente
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">
                                  {format(new Date(sale.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                                </p>
                              </div>
                              <div className="text-right">
                                <p className="font-semibold">
                                  {new Intl.NumberFormat('pt-BR', {
                                    style: 'currency',
                                    currency: 'BRL',
                                  }).format(sale.valor)}
                                </p>
                                {getStatusBadge(sale.status)}
                              </div>
                            </div>
                            
                            {/* Admin actions on sales */}
                            {isAdmin && sale.status === 'pending' && (
                              <div className="flex gap-2 pt-2 border-t">
                                <Button 
                                  size="sm" 
                                  variant="outline"
                                  className="flex-1 text-green-600 hover:text-green-700"
                                  onClick={() => handleMarkAsPaid(sale.id)}
                                >
                                  <CheckCircle className="w-3 h-3 mr-1" />
                                  Marcar Paga
                                </Button>
                                <Button 
                                  size="sm" 
                                  variant="outline"
                                  className="flex-1 text-red-600 hover:text-red-700"
                                  onClick={() => setRefundDialog({ open: true, sale })}
                                >
                                  <XCircle className="w-3 h-3 mr-1" />
                                  Estornar
                                </Button>
                              </div>
                            )}
                            {isAdmin && sale.status === 'paid' && (
                              <div className="flex gap-2 pt-2 border-t">
                                <Button 
                                  size="sm" 
                                  variant="outline"
                                  className="flex-1 text-red-600 hover:text-red-700"
                                  onClick={() => setRefundDialog({ open: true, sale })}
                                >
                                  <XCircle className="w-3 h-3 mr-1" />
                                  Estornar
                                </Button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Separator />

              {/* Notes */}
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium flex items-center gap-2">
                    <MessageSquare className="w-4 h-4" />
                    Anotações ({notes.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {/* Add new note */}
                  <div className="space-y-2">
                    <Textarea
                      placeholder="Adicionar anotação sobre o lead..."
                      value={newNote}
                      onChange={(e) => setNewNote(e.target.value)}
                      rows={3}
                    />
                    <Button 
                      size="sm" 
                      onClick={handleAddNote}
                      disabled={!newNote.trim()}
                      className="gap-2"
                    >
                      <Send className="w-4 h-4" />
                      Adicionar Anotação
                    </Button>
                  </div>

                  {/* Notes list */}
                  {notes.length > 0 && (
                    <div className="space-y-3 pt-4 border-t">
                      {notes.map((note) => (
                        <div 
                          key={note.id} 
                          className="p-3 rounded-lg border bg-muted/30"
                        >
                          <p className="text-sm whitespace-pre-wrap">{note.content}</p>
                          <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                            <User className="w-3 h-3" />
                            <span>{note.author_name}</span>
                            <span>•</span>
                            <Clock className="w-3 h-3" />
                            <span>
                              {format(new Date(note.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* Sale Dialog */}
      {showSaleDialog && (
        <CreateSaleDialog
          preSelectedContactId={contact.id}
          onClose={() => setShowSaleDialog(false)}
        />
      )}

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
