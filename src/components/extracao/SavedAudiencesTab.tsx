import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Send, Trash2, Users, Loader2, Inbox, Upload, UserPlus } from 'lucide-react';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { DispatchDialog } from './DispatchDialog';
import { CsvImportDialog } from './CsvImportDialog';
import { CrmContactsPickerDialog } from './CrmContactsPickerDialog';
import type { ExtractedLead } from './types';

interface Audience {
  id: string;
  name: string;
  description?: string | null;
  keyword?: string | null;
  location?: string | null;
  total_leads: number;
  created_at: string;
}

interface Props {
  accountId: string;
  onDispatchStarted?: (batchId: string) => void;
}

export function SavedAudiencesTab({ accountId, onDispatchStarted }: Props) {
  const { toast } = useToast();
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingLeads, setLoadingLeads] = useState<string | null>(null);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchLeads, setDispatchLeads] = useState<ExtractedLead[]>([]);
  const [csvOpen, setCsvOpen] = useState(false);
  const [crmOpen, setCrmOpen] = useState(false);

  const openDispatchWith = (leads: ExtractedLead[]) => {
    setDispatchLeads(leads);
    setCsvOpen(false);
    setCrmOpen(false);
    setDispatchOpen(true);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let data: Audience[];
      if (useBackend) {
        const res = await apiClient.get<any>(API_ENDPOINTS.PROSPECTING.AUDIENCES);
        data = (res as any).data || res;
      } else {
        const { data: rows, error } = await supabase
          .from('prospecting_audiences' as any)
          .select('id, name, description, keyword, location, total_leads, created_at')
          .order('created_at', { ascending: false });
        if (error) throw error;
        data = (rows as any) || [];
      }
      setAudiences(data || []);
    } catch (err: any) {
      console.error('Load audiences error:', err);
      toast({ title: 'Erro ao carregar públicos', description: err?.message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDispatch = async (audience: Audience) => {
    setLoadingLeads(audience.id);
    try {
      let leads: any[];
      if (useBackend) {
        const res = await apiClient.get<any>(API_ENDPOINTS.PROSPECTING.AUDIENCE(audience.id));
        const payload = (res as any).data || res;
        leads = payload.leads || [];
      } else {
        const { data: rows, error } = await supabase
          .from('prospecting_audience_leads' as any)
          .select('*')
          .eq('audience_id', audience.id);
        if (error) throw error;
        leads = (rows as any) || [];
      }

      const extracted: ExtractedLead[] = leads
        .filter((l: any) => l.phone)
        .map((l: any, idx: number) => ({
          id: l.id || `${audience.id}-${idx}`,
          nome: l.name,
          cidade: l.category || '',
          endereco: l.address || '',
          telefone: l.phone,
          site: l.website,
          avaliacao: l.rating != null ? Number(l.rating) : null,
        }));

      if (extracted.length === 0) {
        toast({
          title: 'Sem leads válidos',
          description: 'Nenhum lead deste público possui telefone.',
          variant: 'destructive',
        });
        return;
      }

      setDispatchLeads(extracted);
      setDispatchOpen(true);
    } catch (err: any) {
      console.error('Load leads error:', err);
      toast({ title: 'Erro ao carregar leads', description: err?.message, variant: 'destructive' });
    } finally {
      setLoadingLeads(null);
    }
  };

  const handleDelete = async (audience: Audience) => {
    try {
      if (useBackend) {
        await apiClient.delete(API_ENDPOINTS.PROSPECTING.AUDIENCE(audience.id));
      } else {
        const { error } = await supabase
          .from('prospecting_audiences' as any)
          .delete()
          .eq('id', audience.id);
        if (error) throw error;
      }
      toast({ title: 'Público excluído' });
      setAudiences((prev) => prev.filter((a) => a.id !== audience.id));
    } catch (err: any) {
      toast({ title: 'Erro ao excluir', description: err?.message, variant: 'destructive' });
    }
  };

  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        <button
          type="button"
          onClick={() => setCsvOpen(true)}
          className="flex items-start gap-3 p-4 border rounded-lg hover:border-primary hover:bg-muted/30 transition text-left"
        >
          <div className="p-2 rounded-md bg-primary/10 text-primary">
            <Upload className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="font-medium text-sm">Importar planilha (CSV)</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Envie uma lista de contatos para disparar mensagens
            </p>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setCrmOpen(true)}
          className="flex items-start gap-3 p-4 border rounded-lg hover:border-primary hover:bg-muted/30 transition text-left"
        >
          <div className="p-2 rounded-md bg-primary/10 text-primary">
            <UserPlus className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <p className="font-medium text-sm">Selecionar contatos do CRM</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Dispare para contatos já cadastrados no sistema
            </p>
          </div>
        </button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg flex items-center gap-2">
              <Users className="w-5 h-5" />
              Públicos salvos
            </CardTitle>
            <Badge variant="secondary">{audiences.length} público(s)</Badge>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Carregando...
            </div>
          ) : audiences.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <Inbox className="w-10 h-10 mb-3 opacity-50" />
              <p className="text-sm">Nenhum público salvo ainda</p>
              <p className="text-xs mt-1">
                Faça uma extração e clique em "Salvar como público" para reutilizar os leads.
              </p>
            </div>
          ) : (
            <div className="overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nome</TableHead>
                    <TableHead>Origem</TableHead>
                    <TableHead className="text-center">Leads</TableHead>
                    <TableHead>Criado em</TableHead>
                    <TableHead className="w-32 text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {audiences.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div>
                          <span className="font-medium">{a.name}</span>
                          {a.description && (
                            <p className="text-xs text-muted-foreground truncate max-w-[260px]">
                              {a.description}
                            </p>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {a.keyword || '—'}
                        {a.location && <span> · {a.location}</span>}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="outline">{a.total_leads}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(a.created_at).toLocaleDateString('pt-BR')}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDispatch(a)}
                            disabled={loadingLeads === a.id}
                          >
                            {loadingLeads === a.id ? (
                              <Loader2 className="w-4 h-4 animate-spin" />
                            ) : (
                              <><Send className="w-4 h-4 mr-1" /> Disparar</>
                            )}
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <Trash2 className="w-4 h-4 text-destructive" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Excluir público?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Tem certeza que deseja excluir "{a.name}"? Os {a.total_leads} leads salvos serão removidos.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                <AlertDialogAction onClick={() => handleDelete(a)}>
                                  Excluir
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <DispatchDialog
        open={dispatchOpen}
        onOpenChange={setDispatchOpen}
        leads={dispatchLeads}
        accountId={accountId}
        onDispatchStarted={(batchId) => {
          setDispatchOpen(false);
          onDispatchStarted?.(batchId);
        }}
      />

      <CsvImportDialog
        open={csvOpen}
        onOpenChange={setCsvOpen}
        onConfirm={openDispatchWith}
        onSaved={load}
      />

      <CrmContactsPickerDialog
        open={crmOpen}
        onOpenChange={setCrmOpen}
        onConfirm={openDispatchWith}
        onSaved={load}
      />
    </>
  );
}
