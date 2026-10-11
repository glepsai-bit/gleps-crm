import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { salesService } from '@/services/sales.service';
import { useAuth } from '@/contexts/AuthContext';
import { useFinance } from '@/contexts/FinanceContext';
import { Contact } from '@/types/crm';
import { mockFunnelStages } from '@/data/mockData';
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
  CheckCircle,
  XCircle,
  AlertCircle,
  Send,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { toast } from 'sonner';

/** Forma tolerante do que `GET /contacts/:id/sales` devolve. */
interface VendaHistorico {
  id: string;
  status?: string;
  valor?: number | string | null;
  total?: number | string | null;
  createdAt?: string | null;
  paidAt?: string | null;
  items?: Array<{
    nome?: string | null;
    product?: { nome?: string | null } | null;
    produto?: { nome?: string | null } | null;
  }>;
}

interface LeadProfileSheetProps {
  contact: Contact | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LeadProfileSheet({ contact, open, onOpenChange }: LeadProfileSheetProps) {
  const { user } = useAuth();
  const {
    getContactNotes,
    getContactFunnelStage,
    addLeadNote,
  } = useFinance();

  const [newNote, setNewNote] = useState('');

  // Histórico somente leitura (a venda nasce no fechamento do Kanban).
  const { data: vendasRaw } = useQuery({
    queryKey: ['contact-sales', contact?.id],
    queryFn: () => salesService.getByContact(contact!.id),
    enabled: Boolean(contact?.id) && open,
    staleTime: 30_000,
  });
  const sales: VendaHistorico[] = Array.isArray(vendasRaw) ? (vendasRaw as unknown as VendaHistorico[]) : [];

  if (!contact) return null;

  const notes = getContactNotes(contact.id);
  const funnelStage = getContactFunnelStage(contact.id);

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

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'paid':
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20 gap-1"><CheckCircle className="w-3 h-3" />Paga</Badge>;
      case 'pending':
        return <Badge className="bg-yellow-500/10 text-yellow-500 border-yellow-500/20 gap-1"><AlertCircle className="w-3 h-3" />Pendente</Badge>;
      case 'refunded':
        return <Badge className="bg-red-500/10 text-red-500 border-red-500/20 gap-1"><XCircle className="w-3 h-3" />Estornada</Badge>;
      case 'cancelled':
        return <Badge className="bg-muted text-muted-foreground border-border gap-1"><XCircle className="w-3 h-3" />Cancelada</Badge>;
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
                <SheetDescription asChild>
                  <div className="flex items-center gap-2 mt-1">
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
                </div>
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
                        const nomes = (sale.items ?? [])
                          .map((i) => i.product?.nome ?? i.produto?.nome ?? i.nome)
                          .filter(Boolean) as string[];
                        const servico = nomes.length > 0 ? nomes.join(', ') : 'Venda';
                        const data = sale.paidAt ?? sale.createdAt;
                        const valor = Number(sale.valor ?? sale.total ?? 0);
                        return (
                          <div key={sale.id} className="p-3 rounded-lg border bg-muted/30">
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <span className="font-medium text-sm break-words">{servico}</span>
                                {data && !Number.isNaN(new Date(data).getTime()) && (
                                  <p className="text-xs text-muted-foreground mt-1">
                                    {format(new Date(data), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                                  </p>
                                )}
                              </div>
                              <div className="text-right shrink-0">
                                <p className="font-semibold">
                                  {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor)}
                                </p>
                                {getStatusBadge(sale.status ?? 'pending')}
                              </div>
                            </div>
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

    </>
  );
}
