import { useState, useEffect, useCallback, useContext } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  Plus, Edit2, Trash2, Loader2, Users, Upload, UserPlus, Search, X
} from 'lucide-react';
import { AuthContext } from '@/contexts/AuthContext';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

function friendlyEmailError(err: any, fallback: string): string {
  const status = err?.status ?? err?.response?.status;
  const code = err?.code ?? err?.response?.data?.error?.code;
  if (status === 429 || code === 'RATE_LIMIT_EXCEEDED') {
    return 'O servidor recebeu muitas requisições simultâneas. Aguarde alguns segundos e tente novamente.';
  }
  if (status === 401 || status === 403) {
    return 'Sessão expirada ou sem permissão. Faça login novamente.';
  }
  return err?.message || fallback;
}

interface Audience {
  id: string;
  account_id?: string;
  accountId?: string;
  name: string;
  description: string | null;
  created_at?: string;
  createdAt?: string;
  contact_count?: number;
}

interface Contact {
  id: string;
  nome: string | null;
  email: string | null;
  telefone: string | null;
}

// ==================== API LAYER ====================

const audienceApi = {
  async list(accountId: string): Promise<Audience[]> {
    if (useBackend) {
      const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.AUDIENCES);
      const data = res?.data ?? res;
      return (Array.isArray(data) ? data : []).map(normalizeAudience);
    }
    // Cloud mode - dynamic import to avoid pulling supabase in backend mode
    const { supabase } = await import('@/integrations/supabase/client');
    const { data, error } = await supabase
      .from('email_audiences')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false });
    if (error) throw error;
    const enriched = await Promise.all((data || []).map(async (a: any) => {
      const { count } = await supabase
        .from('email_audience_contacts')
        .select('*', { count: 'exact', head: true })
        .eq('audience_id', a.id);
      return { ...a, contact_count: count || 0 };
    }));
    return enriched.map(normalizeAudience);
  },

  async create(accountId: string, form: { name: string; description: string }): Promise<Audience> {
    if (useBackend) {
      const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.AUDIENCES, form);
      const data = res?.data ?? res;
      return normalizeAudience({ ...data, contact_count: data?.contact_count ?? 0 });
    }
    const { supabase } = await import('@/integrations/supabase/client');
    const { data, error } = await supabase
      .from('email_audiences')
      .insert({ account_id: accountId, name: form.name, description: form.description || null })
      .select('*')
      .single();
    if (error) throw error;
    return normalizeAudience({ ...data, contact_count: 0 });
  },

  async update(id: string, form: { name: string; description: string }): Promise<Audience> {
    if (useBackend) {
      const res = await apiClient.put<any>(API_ENDPOINTS.EMAIL.AUDIENCE(id), { name: form.name, description: form.description || null });
      const data = res?.data ?? res;
      return normalizeAudience(data);
    }
    const { supabase } = await import('@/integrations/supabase/client');
    const { data, error } = await supabase
      .from('email_audiences')
      .update({ name: form.name, description: form.description || null })
      .eq('id', id)
      .select('*')
      .single();
    if (error) throw error;
    return normalizeAudience(data);
  },

  async delete(id: string): Promise<void> {
    if (useBackend) {
      await apiClient.delete(API_ENDPOINTS.EMAIL.AUDIENCE(id));
      return;
    }
    const { supabase } = await import('@/integrations/supabase/client');
    const { error } = await supabase.from('email_audiences').delete().eq('id', id);
    if (error) throw error;
  },

  async listContacts(audienceId: string): Promise<Contact[]> {
    if (useBackend) {
      const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.AUDIENCE_CONTACTS(audienceId));
      const data = res?.data ?? res;
      return Array.isArray(data) ? data : [];
    }
    const { supabase } = await import('@/integrations/supabase/client');
    const { data, error } = await supabase
      .from('email_audience_contacts')
      .select('contact_id, contacts:contact_id(id, nome, email, telefone)')
      .eq('audience_id', audienceId);
    if (error) throw error;
    return (data || []).map((r: any) => r.contacts).filter(Boolean);
  },

  async addContacts(audienceId: string, contactIds: string[]): Promise<void> {
    if (useBackend) {
      await apiClient.post(API_ENDPOINTS.EMAIL.AUDIENCE_CONTACTS(audienceId), { contactIds });
      return;
    }
    const { supabase } = await import('@/integrations/supabase/client');
    const inserts = contactIds.map(contactId => ({ audience_id: audienceId, contact_id: contactId }));
    const { error } = await supabase.from('email_audience_contacts').insert(inserts);
    if (error) throw error;
  },

  async removeContact(audienceId: string, contactId: string): Promise<void> {
    if (useBackend) {
      await apiClient.delete(API_ENDPOINTS.EMAIL.AUDIENCE_REMOVE_CONTACT(audienceId, contactId));
      return;
    }
    const { supabase } = await import('@/integrations/supabase/client');
    const { error } = await supabase
      .from('email_audience_contacts')
      .delete()
      .eq('audience_id', audienceId)
      .eq('contact_id', contactId);
    if (error) throw error;
  },

  async importCsv(audienceId: string, accountId: string, rows: { nome: string; email: string }[]): Promise<number> {
    if (useBackend) {
      const res = await apiClient.post<any>(API_ENDPOINTS.EMAIL.AUDIENCE_IMPORT(audienceId), { rows });
      const data = res?.data ?? res;
      return data?.added || 0;
    }
    const { supabase } = await import('@/integrations/supabase/client');
    let added = 0;
    for (const row of rows) {
      let { data: existing } = await supabase
        .from('contacts')
        .select('id')
        .eq('account_id', accountId)
        .ilike('email', row.email)
        .maybeSingle();
      let contactId: string;
      if (existing) {
        contactId = existing.id;
      } else {
        const { data: created, error } = await supabase
          .from('contacts')
          .insert({ account_id: accountId, nome: row.nome || null, email: row.email })
          .select('id')
          .single();
        if (error) continue;
        contactId = created.id;
      }
      const { error: linkErr } = await supabase
        .from('email_audience_contacts')
        .upsert({ audience_id: audienceId, contact_id: contactId }, { onConflict: 'audience_id,contact_id' });
      if (!linkErr) added++;
    }
    return added;
  },

  async searchContacts(accountId: string, query: string, excludeIds: string[]): Promise<Contact[]> {
    if (useBackend) {
      const res = await apiClient.get<any>('/api/contacts', { params: { search: query, limit: 20 } });
      const data = res?.data ?? res;
      const list = Array.isArray(data) ? data : (data?.data || []);
      return list.filter((c: any) => !excludeIds.includes(c.id));
    }
    const { supabase } = await import('@/integrations/supabase/client');
    const { data } = await supabase
      .from('contacts')
      .select('id, nome, email, telefone')
      .eq('account_id', accountId)
      .or(`nome.ilike.%${query}%,email.ilike.%${query}%,telefone.ilike.%${query}%`)
      .limit(20);
    const existingIds = new Set(excludeIds);
    return (data || []).filter((c: any) => !existingIds.has(c.id));
  },

  async createContactByEmail(accountId: string, email: string, nome?: string): Promise<Contact> {
    const cleanEmail = email.trim().toLowerCase();
    const finalName = (nome && nome.trim()) || cleanEmail.split('@')[0];
    if (useBackend) {
      // Try to find existing contact first to avoid duplicates
      const search = await apiClient.get<any>('/api/contacts', { params: { search: cleanEmail, limit: 5 } });
      const searchData = search?.data ?? search;
      const list = Array.isArray(searchData) ? searchData : (searchData?.data || []);
      const existing = list.find((c: any) => (c.email || '').toLowerCase() === cleanEmail);
      if (existing) return existing;
      const res = await apiClient.post<any>(API_ENDPOINTS.CONTACTS.CREATE, { nome: finalName, email: cleanEmail });
      const data = res?.data ?? res;
      return data;
    }
    const { supabase } = await import('@/integrations/supabase/client');
    const { data: existing } = await supabase
      .from('contacts')
      .select('id, nome, email, telefone')
      .eq('account_id', accountId)
      .ilike('email', cleanEmail)
      .maybeSingle();
    if (existing) return existing as Contact;
    const { data, error } = await supabase
      .from('contacts')
      .insert({ account_id: accountId, nome: finalName, email: cleanEmail })
      .select('id, nome, email, telefone')
      .single();
    if (error) throw error;
    return data as Contact;
  },
};

function normalizeAudience(a: any): Audience {
  return {
    id: a.id,
    account_id: a.account_id ?? a.accountId,
    name: a.name,
    description: a.description,
    created_at: a.created_at ?? a.createdAt,
    contact_count: a.contact_count ?? a._count?.contacts ?? 0,
  };
}

// ==================== COMPONENT ====================

export default function EmailAudiencesTab() {
  const auth = useContext(AuthContext);
  const accountId = auth?.account?.id || auth?.user?.account_id || '';
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedAudience, setSelectedAudience] = useState<Audience | null>(null);
  const [audienceContacts, setAudienceContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(false);

  // Dialogs
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingAudience, setEditingAudience] = useState<Audience | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showAddContactsDialog, setShowAddContactsDialog] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);

  // Form
  const [form, setForm] = useState({ name: '', description: '' });

  // Contact search
  const [contactSearch, setContactSearch] = useState('');
  const [searchResults, setSearchResults] = useState<Contact[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(new Set());

  // CSV import
  const [csvData, setCsvData] = useState<{ nome: string; email: string }[]>([]);
  const [importLoading, setImportLoading] = useState(false);

  const loadAudiences = useCallback(async () => {
    setLoading(true);
    try {
      const data = await audienceApi.list(accountId);
      setAudiences(data);
      if (data.length > 0 && !selectedAudience) {
        setSelectedAudience(data[0]);
      }
    } catch (err: any) {
      console.error('loadAudiences error:', err);
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  const loadAudienceContacts = useCallback(async (audienceId: string) => {
    setLoadingContacts(true);
    try {
      const data = await audienceApi.listContacts(audienceId);
      setAudienceContacts(data);
    } catch (err: any) {
      console.error('loadAudienceContacts error:', err);
    } finally {
      setLoadingContacts(false);
    }
  }, []);

  useEffect(() => { loadAudiences(); }, [loadAudiences]);
  useEffect(() => {
    if (selectedAudience) loadAudienceContacts(selectedAudience.id);
  }, [selectedAudience, loadAudienceContacts]);

  // CRUD
  const handleSave = async () => {
    try {
      if (editingAudience) {
        const updated = await audienceApi.update(editingAudience.id, form);
        // Optimistic local update — no full refetch (which would fan out into
        // dozens of GETs and could trip the rate limiter).
        setAudiences(prev => prev.map(a => a.id === editingAudience.id
          ? { ...a, ...updated, contact_count: a.contact_count }
          : a));
        if (selectedAudience?.id === editingAudience.id) {
          setSelectedAudience(prev => prev ? { ...prev, ...updated, contact_count: prev.contact_count } : prev);
        }
        toast.success('Público atualizado!');
      } else {
        const created = await audienceApi.create(accountId, form);
        const next = { ...created, contact_count: created.contact_count ?? 0 };
        setAudiences(prev => [next, ...prev]);
        // Auto-select if it's the first one
        setSelectedAudience(prev => prev ?? next);
        toast.success('Público criado!');
      }
      setShowCreateDialog(false);
      setEditingAudience(null);
      setForm({ name: '', description: '' });
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao salvar público'));
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await audienceApi.delete(deleteId);
      toast.success('Público excluído!');
      if (selectedAudience?.id === deleteId) setSelectedAudience(null);
      setAudiences(prev => prev.filter(a => a.id !== deleteId));
      setDeleteId(null);
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao excluir público'));
    }
  };

  // Search contacts
  const handleSearchContacts = async (query: string) => {
    setContactSearch(query);
    if (query.length < 2) { setSearchResults([]); return; }
    setSearchLoading(true);
    try {
      const excludeIds = audienceContacts.map(c => c.id);
      const results = await audienceApi.searchContacts(accountId, query, excludeIds);
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleAddContacts = async () => {
    if (!selectedAudience || selectedContactIds.size === 0) return;
    try {
      await audienceApi.addContacts(selectedAudience.id, Array.from(selectedContactIds));
      toast.success(`${selectedContactIds.size} contato(s) adicionado(s)!`);
      setShowAddContactsDialog(false);
      setSelectedContactIds(new Set());
      setContactSearch('');
      setSearchResults([]);
      loadAudienceContacts(selectedAudience.id);
      loadAudiences();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao adicionar contatos'));
    }
  };

  const handleQuickAddByEmail = async () => {
    if (!selectedAudience) return;
    const email = contactSearch.trim().toLowerCase();
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!isEmail) {
      toast.error('Digite um e-mail válido');
      return;
    }
    try {
      const contact = await audienceApi.createContactByEmail(accountId, email);
      // Avoid re-adding if already in audience
      if (audienceContacts.some(c => c.id === contact.id)) {
        toast.info('Este contato já está no público');
        return;
      }
      await audienceApi.addContacts(selectedAudience.id, [contact.id]);
      toast.success(`${email} adicionado ao público!`);
      setShowAddContactsDialog(false);
      setSelectedContactIds(new Set());
      setContactSearch('');
      setSearchResults([]);
      loadAudienceContacts(selectedAudience.id);
      loadAudiences();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao adicionar e-mail'));
    }
  };

  const handleRemoveContact = async (contactId: string) => {
    if (!selectedAudience) return;
    try {
      await audienceApi.removeContact(selectedAudience.id, contactId);
      toast.success('Contato removido do público!');
      loadAudienceContacts(selectedAudience.id);
      loadAudiences();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro'));
    }
  };

  // CSV Import
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target?.result as string;
      const lines = text.split('\n').filter(l => l.trim());
      if (lines.length < 2) { toast.error('CSV vazio ou inválido'); return; }
      const header = lines[0].toLowerCase().split(/[,;]/);
      const nomeIdx = header.findIndex(h => h.trim().includes('nome') || h.trim().includes('name'));
      const emailIdx = header.findIndex(h => h.trim().includes('email') || h.trim().includes('mail'));
      if (emailIdx === -1) { toast.error('Coluna "email" não encontrada no CSV'); return; }
      const rows = lines.slice(1).map(line => {
        const cols = line.split(/[,;]/);
        return { nome: nomeIdx >= 0 ? cols[nomeIdx]?.trim() || '' : '', email: cols[emailIdx]?.trim() || '' };
      }).filter(r => r.email);
      setCsvData(rows);
      toast.info(`${rows.length} contatos encontrados no arquivo`);
    };
    reader.readAsText(file);
  };

  const handleImportCsv = async () => {
    if (!selectedAudience || csvData.length === 0) return;
    setImportLoading(true);
    try {
      const added = await audienceApi.importCsv(selectedAudience.id, accountId, csvData);
      toast.success(`${added} contatos importados ao público!`);
      setShowImportDialog(false);
      setCsvData([]);
      loadAudienceContacts(selectedAudience.id);
      loadAudiences();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro na importação'));
    } finally {
      setImportLoading(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Users className="w-5 h-5 text-primary" />
          <h3 className="text-lg font-semibold">Públicos</h3>
          <span className="text-sm text-muted-foreground">{audiences.length} público(s)</span>
        </div>
        <Button size="sm" onClick={() => { setEditingAudience(null); setForm({ name: '', description: '' }); setShowCreateDialog(true); }}>
          <Plus className="w-4 h-4 mr-1" /> Novo Público
        </Button>
      </div>

      <div className="grid lg:grid-cols-[300px_1fr] gap-6">
        {/* Audience list */}
        <div className="space-y-2">
          {audiences.length === 0 ? (
            <Card className="card-gradient border-border/50">
              <CardContent className="py-8 text-center text-muted-foreground">
                <Users className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm">Nenhum público criado</p>
                <p className="text-xs mt-1">Crie um público para agrupar contatos.</p>
              </CardContent>
            </Card>
          ) : (
            audiences.map(a => (
              <button
                key={a.id}
                className={`w-full text-left p-3 rounded-lg border transition-all ${
                  selectedAudience?.id === a.id
                    ? 'border-primary bg-primary/5'
                    : 'border-border/50 hover:bg-muted/30'
                }`}
                onClick={() => setSelectedAudience(a)}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm truncate">{a.name}</span>
                  <Badge variant="secondary" className="text-[10px] ml-2 flex-shrink-0">
                    {a.contact_count || 0} contatos
                  </Badge>
                </div>
                {a.description && <p className="text-xs text-muted-foreground mt-0.5 truncate">{a.description}</p>}
              </button>
            ))
          )}
        </div>

        {/* Audience detail */}
        {selectedAudience ? (
          <div className="space-y-4">
            <Card className="card-gradient border-border/50">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base">{selectedAudience.name}</CardTitle>
                    {selectedAudience.description && (
                      <p className="text-sm text-muted-foreground mt-0.5">{selectedAudience.description}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => setShowImportDialog(true)}>
                      <Upload className="w-4 h-4 mr-1" /> Importar CSV
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => {
                      setShowAddContactsDialog(true);
                      setSelectedContactIds(new Set());
                      setContactSearch('');
                      setSearchResults([]);
                    }}>
                      <UserPlus className="w-4 h-4 mr-1" /> Adicionar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => {
                      setEditingAudience(selectedAudience);
                      setForm({ name: selectedAudience.name, description: selectedAudience.description || '' });
                      setShowCreateDialog(true);
                    }}>
                      <Edit2 className="w-4 h-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleteId(selectedAudience.id)}>
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {loadingContacts ? (
                  <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
                ) : audienceContacts.length === 0 ? (
                  <div className="text-center py-6 text-muted-foreground">
                    <Users className="w-8 h-8 mx-auto mb-2 opacity-50" />
                    <p className="text-sm">Nenhum contato neste público</p>
                    <p className="text-xs">Importe um CSV ou adicione contatos manualmente.</p>
                  </div>
                ) : (
                  <div className="space-y-1 max-h-[400px] overflow-y-auto">
                    {audienceContacts.map(c => (
                      <div key={c.id} className="flex items-center justify-between p-2 rounded hover:bg-muted/30 text-sm">
                        <div className="flex-1 min-w-0">
                          <span className="font-medium">{c.nome || 'Sem nome'}</span>
                          {c.email && <span className="text-muted-foreground ml-2 text-xs">{c.email}</span>}
                        </div>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleRemoveContact(c.id)}>
                          <X className="w-3 h-3 text-muted-foreground" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        ) : (
          <Card className="card-gradient border-border/50">
            <CardContent className="py-12 text-center text-muted-foreground">
              <p className="text-sm">Selecione um público para ver seus contatos</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Create/Edit Audience Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingAudience ? 'Editar Público' : 'Novo Público'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Nome</label>
              <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Ex: Leads Clínicas SP" />
            </div>
            <div>
              <label className="text-sm font-medium">Descrição</label>
              <Textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="Descreva este público..." rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={!form.name.trim()}>{editingAudience ? 'Salvar' : 'Criar'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Contacts Dialog */}
      <Dialog open={showAddContactsDialog} onOpenChange={setShowAddContactsDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Adicionar Contatos ao Público</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                value={contactSearch}
                onChange={e => handleSearchContacts(e.target.value)}
                placeholder="Buscar por nome, e-mail ou telefone (ou digite um e-mail novo)..."
                className="pl-9"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactSearch.trim())) {
                    e.preventDefault();
                    handleQuickAddByEmail();
                  }
                }}
              />
            </div>
            <div className="max-h-[300px] overflow-y-auto space-y-1">
              {searchLoading && <div className="flex justify-center py-4"><Loader2 className="w-4 h-4 animate-spin" /></div>}
              {!searchLoading && searchResults.length === 0 && contactSearch.length >= 2 && (
                <div className="text-center py-4 space-y-3">
                  <p className="text-sm text-muted-foreground">Nenhum contato encontrado</p>
                  {/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactSearch.trim()) && (
                    <Button size="sm" variant="outline" onClick={handleQuickAddByEmail}>
                      <UserPlus className="w-4 h-4 mr-1" />
                      Adicionar &quot;{contactSearch.trim()}&quot; como novo contato
                    </Button>
                  )}
                </div>
              )}
              {!searchLoading && searchResults.length === 0 && contactSearch.length < 2 && (
                <p className="text-center text-xs text-muted-foreground py-4">
                  Digite pelo menos 2 caracteres para buscar, ou um e-mail completo para adicionar diretamente.
                </p>
              )}
              {searchResults.map(c => (
                <label key={c.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted/30 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedContactIds.has(c.id)}
                    onChange={e => {
                      const next = new Set(selectedContactIds);
                      e.target.checked ? next.add(c.id) : next.delete(c.id);
                      setSelectedContactIds(next);
                    }}
                    className="rounded"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{c.nome || 'Sem nome'}</span>
                    {c.email && <span className="text-xs text-muted-foreground ml-2">{c.email}</span>}
                  </div>
                </label>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddContactsDialog(false)}>Cancelar</Button>
            {searchResults.length === 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactSearch.trim()) ? (
              <Button onClick={handleQuickAddByEmail}>
                <UserPlus className="w-4 h-4 mr-1" /> Adicionar e-mail
              </Button>
            ) : (
            <Button onClick={handleAddContacts} disabled={selectedContactIds.size === 0}>
              Adicionar {selectedContactIds.size > 0 ? `(${selectedContactIds.size})` : ''}
            </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import CSV Dialog */}
      <Dialog open={showImportDialog} onOpenChange={setShowImportDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Importar Contatos via CSV</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              O arquivo deve ter pelo menos a coluna <strong>email</strong>. A coluna <strong>nome</strong> é opcional.
            </p>
            <Input type="file" accept=".csv,.txt" onChange={handleFileUpload} />
            {csvData.length > 0 && (
              <div className="rounded border p-3 bg-muted/30">
                <p className="text-sm font-medium mb-2">{csvData.length} contatos encontrados</p>
                <div className="max-h-[150px] overflow-y-auto space-y-1 text-xs">
                  {csvData.slice(0, 10).map((r, i) => (
                    <div key={i} className="flex gap-3">
                      <span className="text-muted-foreground w-24 truncate">{r.nome || '—'}</span>
                      <span>{r.email}</span>
                    </div>
                  ))}
                  {csvData.length > 10 && <p className="text-muted-foreground">+{csvData.length - 10} mais...</p>}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setShowImportDialog(false); setCsvData([]); }}>Cancelar</Button>
            <Button onClick={handleImportCsv} disabled={csvData.length === 0 || importLoading}>
              {importLoading ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Upload className="w-4 h-4 mr-1" />}
              Importar {csvData.length > 0 ? `(${csvData.length})` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={open => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir público?</AlertDialogTitle>
            <AlertDialogDescription>Os contatos não serão excluídos, apenas removidos deste público.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
