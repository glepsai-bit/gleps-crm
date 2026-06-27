import { useState, useMemo, useEffect } from 'react';
import { useAuth, useRoleAccess } from '@/contexts/AuthContext';
import { useFinance } from '@/contexts/FinanceContext';
import { CreateSaleDialog } from '@/components/finance/CreateSaleDialog';
import { LeadProfileSheet } from '@/components/leads/LeadProfileSheet';
import { CreateLeadDialog } from '@/components/kanban/CreateLeadDialog';
import { AgentFilter } from '@/components/dashboard/AgentFilter';
import { mockFunnelStages, mockUsers } from '@/data/mockData';
import { Contact, ContactOrigin } from '@/types/crm';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Plus,
  Search,
  MoreHorizontal,
  Edit,
  Trash2,
  Phone,
  Mail,
  DollarSign,
  Eye,
  Users,
  SearchX,
} from 'lucide-react';
import { safeFormatDateBR } from '@/utils/dateUtils';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useBackend } from '@/config/backend.config';
import type { Tag as CloudTag } from '@/services/tags.cloud.service';
import { tagsBackendService } from '@/services/tags.backend.service';
import { contactsCloudService } from '@/services/contacts.cloud.service';
import { contactsBackendService } from '@/services/contacts.backend.service';

export default function AdminLeadsPage() {
  const { account, user } = useAuth();
  const { isAdmin } = useRoleAccess();
  const { 
    contacts, 
    leadFunnelStates, 
    updateContact,
    getContactFunnelStageOrder,
    getContactSales,
    refetchContacts,
  } = useFinance();
  const accountId = account?.id || '';

  const [searchTerm, setSearchTerm] = useState('');
  const [originFilter, setOriginFilter] = useState<string>('all');
  const [selectedAgent, setSelectedAgent] = useState<string>('all');
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [saleContactId, setSaleContactId] = useState<string | null>(null);
  const [profileContact, setProfileContact] = useState<Contact | null>(null);
  const [deletingContact, setDeletingContact] = useState<Contact | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  
  // Kanban stages for CreateLeadDialog
  const [stages, setStages] = useState<CloudTag[]>([]);

  // Load stages
  useEffect(() => {
    if (!accountId) return;

    const loadData = async () => {
      if (useBackend) {
        // Backend: fetch stage tags via backend service
        try {
          const tags = await tagsBackendService.listStageTags(accountId);
          if (tags) setStages(tags as CloudTag[]);
        } catch (err) {
          console.error('Error loading stages via backend:', err);
        }
      } else {
        // Cloud: use Supabase directly
        const { data: funnelData } = await supabase
          .from('funnels')
          .select('id')
          .eq('account_id', accountId)
          .eq('is_default', true)
          .maybeSingle();

        if (funnelData?.id) {
          const { data: tagsData } = await supabase
            .from('tags')
            .select('*')
            .eq('funnel_id', funnelData.id)
            .eq('type', 'stage')
            .eq('ativo', true)
            .order('ordem', { ascending: true });

          if (tagsData) {
            setStages(tagsData as CloudTag[]);
          }
        }
      }
    };

    loadData();
  }, [accountId, account]);

  // Filter by agent if selected (based on sales association)
  const filteredContacts = useMemo(() => {
    return contacts.filter((contact) => {
      const matchesSearch =
        contact.nome?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        contact.telefone?.includes(searchTerm) ||
        contact.email?.toLowerCase().includes(searchTerm.toLowerCase());
      const matchesOrigin = originFilter === 'all' || contact.origem === originFilter;
      
      // Filter by agent - leads are associated via sales they handled
      let matchesAgent = true;
      if (selectedAgent !== 'all' && isAdmin) {
        const contactSales = getContactSales(contact.id);
        matchesAgent = contactSales.some(sale => sale.responsavel_id === selectedAgent);
      }
      
      return matchesSearch && matchesOrigin && matchesAgent;
    });
  }, [contacts, searchTerm, originFilter, selectedAgent, isAdmin, getContactSales]);

  const getStage = (contactId: string) => {
    const state = leadFunnelStates.find((lfs) => lfs.contact_id === contactId);
    if (!state?.funnel_stage_id) return null;
    return mockFunnelStages.find((s) => s.id === state.funnel_stage_id);
  };

  const getInitials = (name: string | null) => {
    if (!name) return '??';
    return name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  const getOriginBadge = (origem: string | null) => {
    switch (origem) {
      case 'whatsapp':
        return <Badge className="bg-green-500/10 text-green-500 border-green-500/20">WhatsApp</Badge>;
      case 'instagram':
        return <Badge className="bg-pink-500/10 text-pink-500 border-pink-500/20">Instagram</Badge>;
      case 'site':
        return <Badge className="bg-blue-500/10 text-blue-500 border-blue-500/20">Site</Badge>;
      default:
        return <Badge variant="secondary">Indicação</Badge>;
    }
  };

  // Check if lead is eligible for sale (ordem >= 3)
  const canCreateSaleForLead = (leadId: string) => {
    const stageOrder = getContactFunnelStageOrder(leadId);
    return stageOrder >= 3;
  };

  const handleLeadCreated = async () => {
    // Reload contacts list after creation
    await refetchContacts();
  };

  const hasActiveFilters =
    searchTerm.trim().length > 0 ||
    originFilter !== 'all' ||
    selectedAgent !== 'all';

  const handleClearFilters = () => {
    setSearchTerm('');
    setOriginFilter('all');
    setSelectedAgent('all');
  };

  const handleUpdate = () => {
    if (!editingContact) return;

    const result = updateContact(editingContact.id, {
      nome: editingContact.nome || undefined,
      telefone: editingContact.telefone || undefined,
      email: editingContact.email,
      origem: editingContact.origem || undefined,
    });

    if (result.success) {
      setEditingContact(null);
      toast.success('Lead atualizado com sucesso!');
    } else {
      toast.error(result.error || 'Erro ao atualizar lead');
    }
  };

  const handleRequestDelete = (contact: Contact) => {
    const contactSales = getContactSales(contact.id);
    if (contactSales.length > 0) {
      toast.error('Não é possível remover lead com vendas registradas');
      return;
    }
    setDeletingContact(contact);
  };

  const handleConfirmDelete = async () => {
    if (!deletingContact) return;
    const contactId = deletingContact.id;
    const nome = deletingContact.nome || 'Lead';

    setIsDeleting(true);
    try {
      const result = useBackend
        ? await contactsBackendService.deleteLead(contactId)
        : await contactsCloudService.deleteLead(contactId);

      if (!result.success) {
        // onError
        toast.error(result.error || 'Erro ao remover lead');
        return;
      }

      // onSuccess
      toast.success(`${nome} removido com sucesso!`);
      await refetchContacts();
    } catch (err) {
      // onError (rede/exceção inesperada)
      const message = err instanceof Error ? err.message : 'Erro inesperado ao remover lead';
      toast.error(message);
    } finally {
      // onSettled
      setIsDeleting(false);
      setDeletingContact(null);
    }
  };

  return (
    <div className="page-container">
      {/* Header */}
      <div className="page-header">
        <div className="min-w-0">
          <h1 className="title-responsive text-foreground">Leads</h1>
          <p className="text-responsive-sm text-muted-foreground">Gerencie todos os leads da conta</p>
        </div>
        {accountId && (
          <CreateLeadDialog
            accountId={accountId}
            stages={stages}
            onLeadCreated={handleLeadCreated}
            trigger={
              <Button className="bg-primary text-primary-foreground hover:bg-primary/90 gap-2 min-h-[40px] sm:min-h-0">
                <Plus className="w-4 h-4" />
                <span className="hidden xs:inline">Novo Lead</span>
                <span className="xs:hidden">Novo</span>
              </Button>
            }
          />
        )}
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="p-3 sm:p-4">
          <div className="filter-container">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por nome, telefone ou email..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9 min-h-[40px]"
              />
            </div>
            <Select value={originFilter} onValueChange={setOriginFilter}>
              <SelectTrigger className="w-full sm:w-[160px] min-h-[40px]">
                <SelectValue placeholder="Origem" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todas as origens</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="instagram">Instagram</SelectItem>
                <SelectItem value="site">Site</SelectItem>
                <SelectItem value="indicacao">Indicação</SelectItem>
              </SelectContent>
            </Select>
            
            {/* Agent Filter - Only for Admins */}
            {isAdmin && user?.role === 'admin' && (
              <AgentFilter value={selectedAgent} onChange={setSelectedAgent} />
            )}
          </div>
        </CardContent>
      </Card>

      {/* Empty state */}
      {filteredContacts.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            {hasActiveFilters ? (
              <EmptyState
                icon={<SearchX className="w-10 h-10" />}
                title="Nenhum lead corresponde aos filtros"
                description="Ajuste a busca, origem ou agente para ver mais resultados."
                action={
                  <Button variant="outline" size="sm" onClick={handleClearFilters}>
                    Limpar filtros
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={<Users className="w-10 h-10" />}
                title="Nenhum lead cadastrado"
                description="Comece adicionando o primeiro lead desta conta."
                action={
                  accountId ? (
                    <CreateLeadDialog
                      accountId={accountId}
                      stages={stages}
                      onLeadCreated={handleLeadCreated}
                      trigger={
                        <Button size="sm" className="gap-2">
                          <Plus className="w-4 h-4" />
                          Adicionar Lead
                        </Button>
                      }
                    />
                  ) : null
                }
              />
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Table (>=md) */}
          <Card className="hidden md:block">
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="min-w-[150px]">Lead</TableHead>
                      <TableHead className="min-w-[140px]">Contato</TableHead>
                      <TableHead className="min-w-[100px]">Origem</TableHead>
                      <TableHead className="min-w-[100px]">Etapa</TableHead>
                      <TableHead className="min-w-[100px]">Criado em</TableHead>
                      <TableHead className="text-right min-w-[80px]">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredContacts.map((contact) => {
                      const stage = getStage(contact.id);
                      const canSell = canCreateSaleForLead(contact.id);
                      return (
                        <TableRow key={contact.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <Avatar className="h-9 w-9">
                                <AvatarFallback className="bg-primary/10 text-primary text-sm">
                                  {getInitials(contact.nome)}
                                </AvatarFallback>
                              </Avatar>
                              <span className="font-medium">{contact.nome || 'Sem nome'}</span>
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-1">
                              {contact.telefone && (
                                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                                  <Phone className="w-3 h-3" />
                                  {contact.telefone}
                                </div>
                              )}
                              {contact.email && (
                                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                                  <Mail className="w-3 h-3" />
                                  {contact.email}
                                </div>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>{getOriginBadge(contact.origem)}</TableCell>
                          <TableCell>
                            {stage ? (
                              <Badge
                                variant="outline"
                                style={{
                                  borderColor: stage.cor || '#0EA5E9',
                                  color: stage.cor || '#0EA5E9',
                                }}
                              >
                                {stage.nome}
                              </Badge>
                            ) : (
                              <span className="text-muted-foreground text-sm">-</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {safeFormatDateBR(contact.created_at, 'dd/MM/yyyy')}
                          </TableCell>
                          <TableCell className="text-right">
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon">
                                  <MoreHorizontal className="w-4 h-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuLabel>Ações</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => setProfileContact(contact)}>
                                  <Eye className="w-4 h-4 mr-2" />
                                  Ver Ficha do Cliente
                                </DropdownMenuItem>
                                {canSell && (
                                  <DropdownMenuItem onClick={() => setSaleContactId(contact.id)}>
                                    <DollarSign className="w-4 h-4 mr-2" />
                                    Criar Venda
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem onClick={() => setEditingContact(contact)}>
                                  <Edit className="w-4 h-4 mr-2" />
                                  Editar
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => handleRequestDelete(contact)}
                                >
                                  <Trash2 className="w-4 h-4 mr-2" />
                                  Remover
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {/* Mobile cards (<md) */}
          <div className="md:hidden space-y-2">
            {filteredContacts.map((contact) => {
              const stage = getStage(contact.id);
              const canSell = canCreateSaleForLead(contact.id);
              return (
                <Card key={contact.id} className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar className="h-9 w-9 shrink-0">
                        <AvatarFallback className="bg-primary/10 text-primary text-sm">
                          {getInitials(contact.nome)}
                        </AvatarFallback>
                      </Avatar>
                      <span className="font-medium truncate">{contact.nome || 'Sem nome'}</span>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="shrink-0">
                          <MoreHorizontal className="w-4 h-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuLabel>Ações</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => setProfileContact(contact)}>
                          <Eye className="w-4 h-4 mr-2" />
                          Ver Ficha do Cliente
                        </DropdownMenuItem>
                        {canSell && (
                          <DropdownMenuItem onClick={() => setSaleContactId(contact.id)}>
                            <DollarSign className="w-4 h-4 mr-2" />
                            Criar Venda
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onClick={() => setEditingContact(contact)}>
                          <Edit className="w-4 h-4 mr-2" />
                          Editar
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => handleRequestDelete(contact)}
                        >
                          <Trash2 className="w-4 h-4 mr-2" />
                          Remover
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <div className="mt-3 space-y-1.5 text-sm">
                    {contact.telefone && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          <Phone className="w-3 h-3" />
                          Telefone
                        </span>
                        <span className="truncate">{contact.telefone}</span>
                      </div>
                    )}
                    {contact.email && (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground flex items-center gap-1.5">
                          <Mail className="w-3 h-3" />
                          Email
                        </span>
                        <span className="truncate">{contact.email}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Origem</span>
                      {getOriginBadge(contact.origem)}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Etapa</span>
                      {stage ? (
                        <Badge
                          variant="outline"
                          style={{
                            borderColor: stage.cor || '#0EA5E9',
                            color: stage.cor || '#0EA5E9',
                          }}
                        >
                          {stage.nome}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-muted-foreground">Criado em</span>
                      <span>{safeFormatDateBR(contact.created_at, 'dd/MM/yyyy')}</span>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      {/* Edit Dialog */}
      <Dialog open={!!editingContact} onOpenChange={() => setEditingContact(null)}>
        <DialogContent className="max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Editar Lead</DialogTitle>
            <DialogDescription>Atualize as informações do lead</DialogDescription>
          </DialogHeader>
          {editingContact && (
            <div className="space-y-4 py-4 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              <div className="space-y-2">
                <Label htmlFor="edit-nome">Nome</Label>
                <Input
                  id="edit-nome"
                  value={editingContact.nome || ''}
                  onChange={(e) =>
                    setEditingContact({ ...editingContact, nome: e.target.value })
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-telefone">Telefone</Label>
                  <Input
                    id="edit-telefone"
                    value={editingContact.telefone || ''}
                    onChange={(e) =>
                      setEditingContact({ ...editingContact, telefone: e.target.value })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-email">Email</Label>
                  <Input
                    id="edit-email"
                    type="email"
                    value={editingContact.email || ''}
                    onChange={(e) =>
                      setEditingContact({ ...editingContact, email: e.target.value })
                    }
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-origem">Origem</Label>
                <Select
                  value={editingContact.origem || 'indicacao'}
                  onValueChange={(v) =>
                    setEditingContact({ ...editingContact, origem: v as ContactOrigin })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="whatsapp">WhatsApp</SelectItem>
                    <SelectItem value="instagram">Instagram</SelectItem>
                    <SelectItem value="site">Site</SelectItem>
                    <SelectItem value="indicacao">Indicação</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <DialogFooter className="flex-shrink-0 gap-3">
            <Button variant="outline" onClick={() => setEditingContact(null)}>
              Cancelar
            </Button>
            <Button onClick={handleUpdate}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lead Profile Sheet */}
      <LeadProfileSheet
        contact={profileContact}
        open={!!profileContact}
        onOpenChange={(open) => !open && setProfileContact(null)}
      />

      {/* Sale Dialog (controlled externally) */}
      {saleContactId && (
        <CreateSaleDialog
          preSelectedContactId={saleContactId}
          onClose={() => setSaleContactId(null)}
        />
      )}

      {/* AlertDialog excluir lead */}
      <AlertDialog
        open={!!deletingContact}
        onOpenChange={(open) => {
          if (!open && !isDeleting) setDeletingContact(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir lead?</AlertDialogTitle>
            <AlertDialogDescription>
              Esta ação não pode ser desfeita. O lead{' '}
              <strong>{deletingContact?.nome || 'sem nome'}</strong> será removido
              permanentemente desta conta.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmDelete();
              }}
              disabled={isDeleting}
            >
              {isDeleting ? 'Excluindo...' : 'Excluir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
