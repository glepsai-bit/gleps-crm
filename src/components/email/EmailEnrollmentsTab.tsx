import { useState, useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Users, Loader2, UserMinus, UserPlus, Search, Upload, FileSpreadsheet, X } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { emailService, type EmailEnrollment, type EmailCadence } from '@/services/email.service';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { supabase } from '@/integrations/supabase/client';
import * as XLSX from 'xlsx';

const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  active: { label: 'Ativo', variant: 'default' },
  paused: { label: 'Pausado', variant: 'secondary' },
  completed: { label: 'Concluído', variant: 'outline' },
  unsubscribed: { label: 'Removido', variant: 'destructive' },
  bounced: { label: 'Bounce', variant: 'destructive' },
};

interface ContactOption {
  id: string;
  nome: string | null;
  email: string | null;
}

interface SpreadsheetContact {
  nome: string;
  email: string;
  valid: boolean;
}

export default function EmailEnrollmentsTab() {
  const [enrollments, setEnrollments] = useState<EmailEnrollment[]>([]);
  const [cadences, setCadences] = useState<EmailCadence[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterCadence, setFilterCadence] = useState<string>('all');
  const [unenrollTarget, setUnenrollTarget] = useState<EmailEnrollment | null>(null);

  // Enroll dialog
  const [showEnrollDialog, setShowEnrollDialog] = useState(false);
  const [enrollCadenceId, setEnrollCadenceId] = useState<string>('');
  const [enrollTab, setEnrollTab] = useState<string>('manual');

  // Manual tab
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contactSearch, setContactSearch] = useState('');
  const [selectedContactIds, setSelectedContactIds] = useState<string[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [creatingContact, setCreatingContact] = useState(false);

  // Spreadsheet tab
  const [spreadsheetContacts, setSpreadsheetContacts] = useState<SpreadsheetContact[]>([]);
  const [spreadsheetFileName, setSpreadsheetFileName] = useState<string>('');
  const [importingSpreadsheet, setImportingSpreadsheet] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isValidEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [enrollData, cadenceData] = await Promise.all([
        emailService.listEnrollments(),
        emailService.listCadences(),
      ]);
      setEnrollments(enrollData);
      setCadences(cadenceData);
    } catch (err) {
      console.error('Erro ao carregar inscrições:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadContacts = async (search?: string) => {
    setLoadingContacts(true);
    try {
      if (useBackend) {
        const res = await apiClient.get<any>(API_ENDPOINTS.CONTACTS.LIST, {
          params: { search: search || '', limit: 50 },
        });
        const data = res?.data ?? res;
        const list = Array.isArray(data) ? data : (data?.contacts || data?.data || []);
        setContacts(list.filter((c: any) => c.email).map((c: any) => ({
          id: c.id,
          nome: c.nome || c.name || null,
          email: c.email || null,
        })));
      } else {
        let query = supabase.from('contacts').select('id, nome, email').not('email', 'is', null).limit(50);
        if (search) {
          query = query.or(`nome.ilike.%${search}%,email.ilike.%${search}%`);
        }
        const { data } = await query;
        setContacts((data || []).map(c => ({ id: c.id, nome: c.nome, email: c.email })));
      }
    } catch (err) {
      console.error('Erro ao carregar contatos:', err);
    } finally {
      setLoadingContacts(false);
    }
  };

  const handleOpenEnrollDialog = () => {
    setShowEnrollDialog(true);
    setEnrollCadenceId(cadences.length > 0 ? cadences[0].id : '');
    setSelectedContactIds([]);
    setContactSearch('');
    setEnrollTab('manual');
    setSpreadsheetContacts([]);
    setSpreadsheetFileName('');
    loadContacts();
  };

  const handleSearchContacts = () => {
    loadContacts(contactSearch);
  };

  const handleCreateContactByEmail = async () => {
    const email = contactSearch.trim().toLowerCase();
    if (!isValidEmail(email)) {
      toast.error('Digite um e-mail válido');
      return;
    }
    setCreatingContact(true);
    try {
      if (useBackend) {
        // Search for existing contact by email via backend
        const searchRes = await apiClient.get<any>(API_ENDPOINTS.CONTACTS.LIST, {
          params: { search: email, limit: 5 },
        });
        const searchData = searchRes?.data ?? searchRes;
        const list = Array.isArray(searchData) ? searchData : (searchData?.contacts || searchData?.data || []);
        const existing = list.find((c: any) => c.email?.toLowerCase() === email);

        if (existing) {
          setContacts([{ id: existing.id, nome: existing.nome || existing.name || null, email: existing.email }]);
          setSelectedContactIds([existing.id]);
          toast.info('Contato já existe, selecionado automaticamente.');
        } else {
          const createRes = await apiClient.post<any>(API_ENDPOINTS.CONTACTS.CREATE, {
            nome: email.split('@')[0],
            email,
            origem: 'outro',
          });
          const newContact = createRes?.data ?? createRes;
          setContacts([{ id: newContact.id, nome: newContact.nome || newContact.name || null, email: newContact.email }]);
          setSelectedContactIds([newContact.id]);
          toast.success('Contato criado e selecionado!');
        }
      } else {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Não autenticado');
        const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).single();
        if (!profile?.account_id) throw new Error('Conta não encontrada');

        const { data: existing } = await supabase
          .from('contacts')
          .select('id, nome, email')
          .eq('account_id', profile.account_id)
          .eq('email', email)
          .maybeSingle();

        if (existing) {
          setContacts([{ id: existing.id, nome: existing.nome, email: existing.email }]);
          setSelectedContactIds([existing.id]);
          toast.info('Contato já existe, selecionado automaticamente.');
        } else {
          const { data: newContact, error } = await supabase
            .from('contacts')
            .insert({ account_id: profile.account_id, nome: email.split('@')[0], email })
            .select('id, nome, email')
            .single();
          if (error) throw error;
          setContacts([{ id: newContact.id, nome: newContact.nome, email: newContact.email }]);
          setSelectedContactIds([newContact.id]);
          toast.success('Contato criado e selecionado!');
        }
      }
    } catch (err: any) {
      console.error('Erro ao criar contato:', err);
      toast.error(err?.message || 'Erro ao criar contato');
    } finally {
      setCreatingContact(false);
    }
  };

  const toggleContact = (id: string) => {
    setSelectedContactIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  // ==================== MANUAL ENROLL ====================

  const handleEnroll = async () => {
    if (!enrollCadenceId || selectedContactIds.length === 0) return;
    setEnrolling(true);
    try {
      await emailService.enroll(enrollCadenceId, selectedContactIds);
      toast.success(`${selectedContactIds.length} contato(s) inscrito(s) com sucesso!`);
      setShowEnrollDialog(false);
      await loadData();
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao inscrever contatos');
    } finally {
      setEnrolling(false);
    }
  };

  // ==================== SPREADSHEET IMPORT ====================

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const validTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
    ];
    const ext = file.name.split('.').pop()?.toLowerCase();
    if (!validTypes.includes(file.type) && !['xlsx', 'xls', 'csv'].includes(ext || '')) {
      toast.error('Formato inválido. Use .xlsx, .xls ou .csv');
      return;
    }

    setSpreadsheetFileName(file.name);
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = new Uint8Array(evt.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

        if (rows.length === 0) {
          toast.error('Planilha vazia');
          return;
        }

        // Auto-detect column names
        const keys = Object.keys(rows[0]);
        const emailCol = keys.find(k => /email|e-mail|e_mail/i.test(k)) || keys.find(k => {
          const sample = String(rows[0][k]);
          return isValidEmail(sample);
        });
        const nameCol = keys.find(k => /nome|name|contato|contact/i.test(k));

        if (!emailCol) {
          toast.error('Coluna de e-mail não encontrada. Certifique-se que há uma coluna chamada "email".');
          return;
        }

        const parsed: SpreadsheetContact[] = rows.map(row => {
          const email = String(row[emailCol] || '').trim().toLowerCase();
          const nome = nameCol ? String(row[nameCol] || '').trim() : '';
          return { nome, email, valid: isValidEmail(email) };
        }).filter(c => c.email.length > 0);

        setSpreadsheetContacts(parsed);
        toast.success(`${parsed.length} contato(s) encontrado(s) na planilha`);
      } catch (err) {
        console.error('Erro ao ler planilha:', err);
        toast.error('Erro ao ler a planilha');
      }
    };
    reader.readAsArrayBuffer(file);
    // Reset input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSpreadsheetEnroll = async () => {
    if (!enrollCadenceId) return;
    const validContacts = spreadsheetContacts.filter(c => c.valid);
    if (validContacts.length === 0) {
      toast.error('Nenhum contato com e-mail válido');
      return;
    }

    setImportingSpreadsheet(true);
    try {
      const contactIds: string[] = [];

      if (useBackend) {
        // Backend mode: use API calls
        for (const sc of validContacts) {
          try {
            const searchRes = await apiClient.get<any>(API_ENDPOINTS.CONTACTS.LIST, {
              params: { search: sc.email, limit: 5 },
            });
            const searchData = searchRes?.data ?? searchRes;
            const list = Array.isArray(searchData) ? searchData : (searchData?.contacts || searchData?.data || []);
            const existing = list.find((c: any) => c.email?.toLowerCase() === sc.email);

            if (existing) {
              contactIds.push(existing.id);
            } else {
              const createRes = await apiClient.post<any>(API_ENDPOINTS.CONTACTS.CREATE, {
                nome: sc.nome || sc.email.split('@')[0],
                email: sc.email,
                origem: 'outro',
              });
              const newContact = createRes?.data ?? createRes;
              if (newContact?.id) contactIds.push(newContact.id);
            }
          } catch (err) {
            console.error(`Erro ao criar contato ${sc.email}:`, err);
          }
        }
      } else {
        // Cloud mode: use Supabase directly
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error('Não autenticado');
        const { data: profile } = await supabase.from('profiles').select('account_id').eq('user_id', user.id).single();
        if (!profile?.account_id) throw new Error('Conta não encontrada');

        for (const sc of validContacts) {
          const { data: existing } = await supabase
            .from('contacts')
            .select('id')
            .eq('account_id', profile.account_id)
            .eq('email', sc.email)
            .limit(1)
            .maybeSingle();

          if (existing) {
            contactIds.push(existing.id);
          } else {
            const { data: newContact, error } = await supabase
              .from('contacts')
              .insert({
                account_id: profile.account_id,
                nome: sc.nome || sc.email.split('@')[0],
                email: sc.email,
              })
              .select('id')
              .single();

            if (error) {
              console.error(`Erro ao criar contato ${sc.email}:`, error.message);
              continue;
            }
            if (newContact) contactIds.push(newContact.id);
          }
        }
      }

      if (contactIds.length === 0) {
        toast.error('Nenhum contato pôde ser criado/encontrado');
        return;
      }

      await emailService.enroll(enrollCadenceId, contactIds);
      toast.success(`${contactIds.length} contato(s) inscrito(s) via planilha!`);
      setShowEnrollDialog(false);
      await loadData();
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao importar planilha');
    } finally {
      setImportingSpreadsheet(false);
    }
  };

  const handleUnenroll = async () => {
    if (!unenrollTarget) return;
    try {
      await emailService.unenroll(unenrollTarget.cadence_id, [unenrollTarget.contact_id]);
      setEnrollments(prev =>
        prev.map(e => e.id === unenrollTarget.id ? { ...e, status: 'unsubscribed' } : e)
      );
      setUnenrollTarget(null);
      toast.success('Contato removido da cadência!');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao remover inscrição');
    }
  };

  const filtered = filterCadence === 'all'
    ? enrollments
    : enrollments.filter(e => e.cadence_id === filterCadence);

  const cadenceMap = new Map(cadences.map(c => [c.id, c.name]));
  const validSpreadsheetCount = spreadsheetContacts.filter(c => c.valid).length;
  const invalidSpreadsheetCount = spreadsheetContacts.filter(c => !c.valid).length;

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Gerencie os leads inscritos em cadências de e-mail</p>
        <div className="flex items-center gap-2">
          <Select value={filterCadence} onValueChange={setFilterCadence}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Filtrar por cadência" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todas as cadências</SelectItem>
              {cadences.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" onClick={handleOpenEnrollDialog} disabled={cadences.length === 0}>
            <UserPlus className="w-4 h-4 mr-1" /> Inscrever
          </Button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card className="card-gradient border-border/50">
          <CardContent className="py-12 text-center">
            <Users className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="font-medium text-muted-foreground">Nenhuma inscrição encontrada</p>
            <p className="text-sm text-muted-foreground mt-1">
              Clique em "Inscrever" para adicionar contatos a uma cadência.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-12 gap-2 px-3 py-2 text-xs font-medium text-muted-foreground uppercase">
            <div className="col-span-3">Contato</div>
            <div className="col-span-3">Cadência</div>
            <div className="col-span-2">Status</div>
            <div className="col-span-2">Etapa</div>
            <div className="col-span-2 text-right">Ações</div>
          </div>

          {filtered.map(enrollment => {
            const status = statusLabels[enrollment.status] || { label: enrollment.status, variant: 'secondary' as const };
            return (
              <Card key={enrollment.id} className="card-gradient border-border/50">
                <CardContent className="p-3">
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-3">
                      <p className="text-sm font-medium truncate">
                        {enrollment.contact?.nome || 'Sem nome'}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">
                        {enrollment.contact?.email || '—'}
                      </p>
                    </div>
                    <div className="col-span-3">
                      <p className="text-sm truncate">
                        {cadenceMap.get(enrollment.cadence_id) || 'Cadência'}
                      </p>
                    </div>
                    <div className="col-span-2">
                      <Badge variant={status.variant} className="text-[10px]">
                        {status.label}
                      </Badge>
                    </div>
                    <div className="col-span-2">
                      <p className="text-sm">Step {enrollment.current_step}</p>
                      {enrollment.next_send_at && (
                        <p className="text-[10px] text-muted-foreground">
                          Próx: {new Date(enrollment.next_send_at).toLocaleDateString('pt-BR')}
                        </p>
                      )}
                    </div>
                    <div className="col-span-2 flex justify-end gap-1">
                      {enrollment.status === 'active' && (
                        <Button
                          variant="ghost" size="sm" className="h-7 w-7 p-0"
                          title="Remover da cadência"
                          onClick={() => setUnenrollTarget(enrollment)}
                        >
                          <UserMinus className="w-3 h-3 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Enroll Dialog */}
      <Dialog open={showEnrollDialog} onOpenChange={setShowEnrollDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Inscrever Contatos em Cadência</DialogTitle>
            <DialogDescription>Selecione contatos manualmente ou importe via planilha.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Cadência</label>
              <Select value={enrollCadenceId} onValueChange={setEnrollCadenceId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione uma cadência" />
                </SelectTrigger>
                <SelectContent>
                  {cadences.filter(c => c.active).map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Tabs value={enrollTab} onValueChange={setEnrollTab}>
              <TabsList className="w-full">
                <TabsTrigger value="manual" className="flex-1">
                  <UserPlus className="w-3.5 h-3.5 mr-1.5" />
                  Manual
                </TabsTrigger>
                <TabsTrigger value="spreadsheet" className="flex-1">
                  <FileSpreadsheet className="w-3.5 h-3.5 mr-1.5" />
                  Planilha
                </TabsTrigger>
              </TabsList>

              {/* MANUAL TAB */}
              <TabsContent value="manual" className="space-y-3 mt-3">
                <div>
                  <label className="text-sm font-medium">Buscar contatos (com e-mail)</label>
                  <div className="flex gap-2 mt-1">
                    <Input
                      placeholder="Nome ou e-mail..."
                      value={contactSearch}
                      onChange={(e) => setContactSearch(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearchContacts()}
                    />
                    <Button variant="outline" size="sm" onClick={handleSearchContacts}>
                      <Search className="w-4 h-4" />
                    </Button>
                  </div>
                </div>

                <div className="border rounded-lg max-h-[200px] overflow-y-auto">
                  {loadingContacts ? (
                    <div className="flex justify-center py-6">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : contacts.length === 0 ? (
                    <div className="text-center py-6 space-y-2">
                      <p className="text-sm text-muted-foreground">
                        Nenhum contato com e-mail encontrado
                      </p>
                      {contactSearch.trim() && isValidEmail(contactSearch.trim()) && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={handleCreateContactByEmail}
                          disabled={creatingContact}
                        >
                          {creatingContact ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5 mr-1.5" />}
                          Criar contato com "{contactSearch.trim()}"
                        </Button>
                      )}
                    </div>
                  ) : (
                    contacts.map(contact => (
                      <label
                        key={contact.id}
                        className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer border-b last:border-b-0"
                      >
                        <Checkbox
                          checked={selectedContactIds.includes(contact.id)}
                          onCheckedChange={() => toggleContact(contact.id)}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{contact.nome || 'Sem nome'}</p>
                          <p className="text-xs text-muted-foreground truncate">{contact.email}</p>
                        </div>
                      </label>
                    ))
                  )}
                </div>

                {selectedContactIds.length > 0 && (
                  <p className="text-sm text-muted-foreground">
                    {selectedContactIds.length} contato(s) selecionado(s)
                  </p>
                )}

                <Button
                  className="w-full"
                  onClick={handleEnroll}
                  disabled={enrolling || !enrollCadenceId || selectedContactIds.length === 0}
                >
                  {enrolling ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <UserPlus className="w-4 h-4 mr-2" />}
                  Inscrever {selectedContactIds.length > 0 ? `(${selectedContactIds.length})` : ''}
                </Button>
              </TabsContent>

              {/* SPREADSHEET TAB */}
              <TabsContent value="spreadsheet" className="space-y-3 mt-3">
                <div className="border-2 border-dashed border-border rounded-lg p-6 text-center">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={handleFileUpload}
                  />
                  {spreadsheetFileName ? (
                    <div className="space-y-2">
                      <FileSpreadsheet className="w-8 h-8 mx-auto text-primary" />
                      <div className="flex items-center justify-center gap-2">
                        <p className="text-sm font-medium">{spreadsheetFileName}</p>
                        <Button
                          variant="ghost" size="sm" className="h-6 w-6 p-0"
                          onClick={() => {
                            setSpreadsheetContacts([]);
                            setSpreadsheetFileName('');
                          }}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                      <div className="flex justify-center gap-3 text-xs">
                        <span className="text-green-500">{validSpreadsheetCount} válido(s)</span>
                        {invalidSpreadsheetCount > 0 && (
                          <span className="text-destructive">{invalidSpreadsheetCount} inválido(s)</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <Upload className="w-8 h-8 mx-auto text-muted-foreground" />
                      <p className="text-sm text-muted-foreground">
                        Arraste ou clique para enviar
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Formatos: .xlsx, .xls, .csv — com coluna "email" (e opcionalmente "nome")
                      </p>
                      <Button
                        variant="outline" size="sm"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        Selecionar arquivo
                      </Button>
                    </div>
                  )}
                </div>

                {spreadsheetContacts.length > 0 && (
                  <div className="border rounded-lg max-h-[150px] overflow-y-auto">
                    <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground uppercase border-b bg-muted/30 grid grid-cols-12">
                      <div className="col-span-5">Nome</div>
                      <div className="col-span-5">E-mail</div>
                      <div className="col-span-2 text-center">Status</div>
                    </div>
                    {spreadsheetContacts.slice(0, 50).map((sc, idx) => (
                      <div key={idx} className="px-3 py-1.5 text-sm border-b last:border-b-0 grid grid-cols-12 items-center">
                        <div className="col-span-5 truncate">{sc.nome || '—'}</div>
                        <div className="col-span-5 truncate text-muted-foreground">{sc.email}</div>
                        <div className="col-span-2 text-center">
                          {sc.valid ? (
                            <Badge variant="outline" className="text-[10px] text-green-500 border-green-500/30">OK</Badge>
                          ) : (
                            <Badge variant="destructive" className="text-[10px]">Inválido</Badge>
                          )}
                        </div>
                      </div>
                    ))}
                    {spreadsheetContacts.length > 50 && (
                      <p className="text-xs text-muted-foreground text-center py-2">
                        ... e mais {spreadsheetContacts.length - 50} contato(s)
                      </p>
                    )}
                  </div>
                )}

                <Button
                  className="w-full"
                  onClick={handleSpreadsheetEnroll}
                  disabled={importingSpreadsheet || !enrollCadenceId || validSpreadsheetCount === 0}
                >
                  {importingSpreadsheet ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 mr-2" />
                  )}
                  Importar e Inscrever ({validSpreadsheetCount})
                </Button>
              </TabsContent>
            </Tabs>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unenroll Confirmation */}
      <AlertDialog open={!!unenrollTarget} onOpenChange={(open) => !open && setUnenrollTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover inscrição</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja remover <strong>{unenrollTarget?.contact?.nome || 'este contato'}</strong> da cadência?
              Os e-mails pendentes não serão enviados.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleUnenroll}>Remover</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
