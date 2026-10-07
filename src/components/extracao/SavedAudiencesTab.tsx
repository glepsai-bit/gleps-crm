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
import { Send, Trash2, Users, Loader2, Inbox } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

interface Audience {
  id: string;
  name: string;
  description?: string | null;
  keyword?: string | null;
  location?: string | null;
  total_leads: number;
  totalLeads?: number; // backend Express devolve camelCase
  created_at: string;
  createdAt?: string; // backend Express devolve camelCase
}

export function SavedAudiencesTab() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [loading, setLoading] = useState(true);

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

  // O disparo em si vive na tela Disparos; aqui só se escolhe o público.
  const handleDispatch = (audience: Audience) => navigate(`/admin/disparos?publico=${audience.id}`);

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
                        <Badge variant="outline">{a.totalLeads ?? a.total_leads ?? 0}</Badge>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {new Date(a.createdAt ?? a.created_at).toLocaleDateString('pt-BR')}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDispatch(a)}
                          >
                            <Send className="w-4 h-4 mr-1" /> Disparar
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
                                  Tem certeza que deseja excluir "{a.name}"? Os {a.totalLeads ?? a.total_leads ?? 0} leads salvos serão removidos.
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

    </>
  );
}
