import { useState, useCallback, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ExtractionSearchForm } from '@/components/extracao/ExtractionSearchForm';
import { ExtractionResultsTable } from '@/components/extracao/ExtractionResultsTable';
import { SaveAudienceDialog } from '@/components/extracao/SaveAudienceDialog';
import { SavedAudiencesTab } from '@/components/extracao/SavedAudiencesTab';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { Download, Send, Search, Zap, Save, Users, Calendar, BarChart2, X as XIcon, Pause, Play, Eye, MapPin } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { useToast } from '@/hooks/use-toast';
import type { ExtractedLead, ApiUsage } from '@/components/extracao/types';

export default function AdminExtracaoPage() {
  const { account } = useAuth();
  const { toast } = useToast();
  const [leads, setLeads] = useState<ExtractedLead[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const [dispararAposSalvar, setDispararAposSalvar] = useState(false);
  const [saveAudienceOpen, setSaveAudienceOpen] = useState(false);
   const [usage, setUsage] = useState<ApiUsage | null>(null);
   
   const fetchUsage = useCallback(async () => {
     if (!account?.id) return;

    try {
      if (useBackend) {
        // Production: Express backend (VPS)
        const res = await apiClient.get<{ success: boolean; used: number; limit: number }>(
          API_ENDPOINTS.PROSPECTING.USAGE
        );
        setUsage({ used: res.used ?? 0, limit: res.limit ?? 500 });
      } else {
        // Lovable Cloud (Supabase) fallback
        const { data: usedCount, error: usageError } = await supabase.rpc(
          'get_monthly_extraction_usage',
          { p_account_id: account.id }
        );
        if (usageError) throw usageError;

        const { data: accountData, error: accountError } = await supabase
          .from('accounts')
          .select('monthly_extraction_limit')
          .eq('id', account.id)
          .single();
        if (accountError) throw accountError;

        setUsage({
          used: usedCount || 0,
          limit: accountData.monthly_extraction_limit || 500,
        });
      }
    } catch (err) {
      console.error('Error fetching extraction usage:', err);
    }
  }, [account?.id]);
 
   useEffect(() => {
     fetchUsage();
   }, [fetchUsage]);
  // BUG-FE Regressão E2E-1: Tabs precisa ser controlado + sincronizado com a
  // URL via ?tab=... pra evitar reset da aba durante invalidate de queries
  // (Pausar/Retomar/Cancelar na aba Agendadas estava jogando o usuário de
  // volta pra Disparos porque a aba não persistia entre remounts).
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') ?? 'extracao';
  const [activeTab, setActiveTab] = useState<string>(initialTab);
  const [extractionMeta, setExtractionMeta] = useState<{ keyword: string; location: string }>({ keyword: '', location: '' });

  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && t !== activeTab) setActiveTab(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

   const handleSearchResults = useCallback(
     (results: ExtractedLead[], apiUsage?: ApiUsage, meta?: { keyword: string; location: string }) => {
       setLeads(results);
       setSelectedIds(new Set(results.map((l) => l.id)));
       // If API usage is returned from the function call, use it, otherwise refresh
       if (apiUsage) {
         setUsage(apiUsage);
       } else {
         fetchUsage();
       }
       if (meta) setExtractionMeta(meta);
     },
     [fetchUsage]
   );

  const handleToggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (selectedIds.size === leads.length) setSelectedIds(new Set());
    else setSelectedIds(new Set(leads.map((l) => l.id)));
  }, [leads, selectedIds.size]);

  const handleRemoveLead = useCallback((id: string) => {
    setLeads((prev) => prev.filter((l) => l.id !== id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleExportExcel = useCallback(() => {
    if (leads.length === 0) return;
    const headers = ['Nome', 'Cidade', 'Endereço', 'Telefone', 'Site', 'Avaliação', 'Total Avaliações'];
    const rows = leads.map((l) => [
      l.nome, l.cidade, l.endereco, l.telefone, l.site || '',
      l.avaliacao?.toString() || '', l.total_avaliacoes?.toString() || '',
    ]);
    const csv = [headers.join(';'), ...rows.map((r) => r.join(';'))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `prospeccao-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: 'Exportação concluída', description: `${leads.length} leads exportados.` });
  }, [leads, toast]);

  // "Disparar" salva a seleção como público e leva ao Novo disparo com ele escolhido:
  // o motor único trabalha sempre sobre uma lista guardada.
  const handleDispararSalvo = useCallback((audienceId: string) => {
    navigate(`/admin/disparos?publico=${audienceId}`);
  }, [navigate]);

   const selectedLeads = leads.filter((l) => selectedIds.has(l.id));
   const usagePercent = usage ? Math.min((usage.used / usage.limit) * 100, 100) : 0;
   const isLimitReached = usage ? usage.used >= usage.limit : false;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Prospecção</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Extraia leads do Google Maps, guarde em públicos e dispare pela tela Disparos
          </p>
        </div>
        {usage && (
          <Card className="w-full sm:w-64">
            <CardContent className="py-3 px-4">
              <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                <span>Uso mensal da API</span>
                <span className="font-medium text-foreground">{usage.used}/{usage.limit}</span>
              </div>
              <Progress value={usagePercent} className="h-2" />
            </CardContent>
          </Card>
        )}
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} activationMode="manual" className="space-y-4">
        <TabsList className="w-full max-w-md sm:grid sm:grid-cols-2">
          <TabsTrigger value="extracao" className="gap-1 text-xs sm:text-sm">
            <Search className="w-4 h-4" /> Extração
          </TabsTrigger>
          <TabsTrigger value="publicos" className="gap-1 text-xs sm:text-sm">
            <Users className="w-4 h-4" /> Públicos
          </TabsTrigger>
        </TabsList>

         <TabsContent value="extracao" className="space-y-4">
           <ExtractionSearchForm
             accountId={account?.id || ''}
             onResults={handleSearchResults}
             isLoading={isLoading}
             setIsLoading={setIsLoading}
             isLimitReached={isLimitReached}
           />
          {leads.length === 0 && !isLoading && (
            <Card>
              <CardContent className="p-0">
                <EmptyState
                  icon={<MapPin className="w-10 h-10" />}
                  title="Faca uma busca para extrair leads"
                  description="Informe a palavra-chave e a localizacao acima para extrair leads do Google Maps. Os resultados aparecerao aqui prontos para selecao e disparo."
                />
              </CardContent>
            </Card>
          )}
          {leads.length > 0 && (
            <>
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary">{leads.length} leads encontrados</Badge>
                  {selectedLeads.length > 0 && (
                    <Badge variant="outline">{selectedLeads.length} selecionados</Badge>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <Button variant="outline" size="sm" onClick={handleExportExcel}>
                    <Download className="w-4 h-4 mr-2" /> Exportar CSV
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSaveAudienceOpen(true)}
                    disabled={selectedLeads.length === 0}
                  >
                    <Save className="w-4 h-4 mr-2" /> Salvar como público ({selectedLeads.length})
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => { setDispararAposSalvar(true); setSaveAudienceOpen(true); }}
                    disabled={selectedLeads.length === 0}
                  >
                    <Send className="w-4 h-4 mr-2" /> Disparar ({selectedLeads.length})
                  </Button>
                </div>
              </div>
              <ExtractionResultsTable
                leads={leads}
                selectedIds={selectedIds}
                onToggleSelect={handleToggleSelect}
                onSelectAll={handleSelectAll}
                onRemove={handleRemoveLead}
              />
            </>
          )}
        </TabsContent>

        <TabsContent value="publicos" className="space-y-4">
          <SavedAudiencesTab />
        </TabsContent>
      </Tabs>

      <SaveAudienceDialog
        open={saveAudienceOpen}
        onOpenChange={(o) => { setSaveAudienceOpen(o); if (!o) setDispararAposSalvar(false); }}
        modoDisparar={dispararAposSalvar}
        onSavedWithId={handleDispararSalvo}
        leads={selectedLeads}
        keyword={extractionMeta.keyword}
        location={extractionMeta.location}
      />
    </div>
  );
}
