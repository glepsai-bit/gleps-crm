 import { useState, useCallback, useEffect } from 'react';
 import { supabase } from '@/integrations/supabase/client';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { useAuth } from '@/contexts/AuthContext';
import { ExtractionSearchForm } from '@/components/extracao/ExtractionSearchForm';
import { ExtractionResultsTable } from '@/components/extracao/ExtractionResultsTable';
import { DispatchDialog } from '@/components/extracao/DispatchDialog';
import { DispatchMonitor } from '@/components/extracao/DispatchMonitor';
import { SaveAudienceDialog } from '@/components/extracao/SaveAudienceDialog';
import { SavedAudiencesTab } from '@/components/extracao/SavedAudiencesTab';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Download, Send, Search, Zap, Save, Users } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { ExtractedLead, ApiUsage } from '@/components/extracao/types';

export default function AdminExtracaoPage() {
  const { account } = useAuth();
  const { toast } = useToast();
  const [leads, setLeads] = useState<ExtractedLead[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [dispatchOpen, setDispatchOpen] = useState(false);
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
  const [activeTab, setActiveTab] = useState('extracao');
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [extractionMeta, setExtractionMeta] = useState<{ keyword: string; location: string }>({ keyword: '', location: '' });

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

  const handleDispatchStarted = useCallback((batchId: string) => {
    setActiveBatchId(batchId);
    setActiveTab('disparos');
  }, []);

   const selectedLeads = leads.filter((l) => selectedIds.has(l.id));
   const usagePercent = usage ? Math.min((usage.used / usage.limit) * 100, 100) : 0;
   const isLimitReached = usage ? usage.used >= usage.limit : false;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Prospecção</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Extraia leads do Google Maps e dispare mensagens via WhatsApp
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

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 max-w-xl">
          <TabsTrigger value="extracao" className="gap-2">
            <Search className="w-4 h-4" /> Extração
          </TabsTrigger>
          <TabsTrigger value="publicos" className="gap-2">
            <Users className="w-4 h-4" /> Públicos
          </TabsTrigger>
          <TabsTrigger value="disparos" className="gap-2">
            <Zap className="w-4 h-4" /> Disparos
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
                    onClick={() => setDispatchOpen(true)}
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
          <SavedAudiencesTab
            accountId={account?.id || ''}
            onDispatchStarted={handleDispatchStarted}
          />
        </TabsContent>

        <TabsContent value="disparos" className="space-y-4">
          <DispatchMonitor accountId={account?.id || ''} activeBatchId={activeBatchId} />
        </TabsContent>
      </Tabs>

      <DispatchDialog
        open={dispatchOpen}
        onOpenChange={setDispatchOpen}
        leads={selectedLeads}
        accountId={account?.id || ''}
        onDispatchStarted={handleDispatchStarted}
      />

      <SaveAudienceDialog
        open={saveAudienceOpen}
        onOpenChange={setSaveAudienceOpen}
        leads={selectedLeads}
        keyword={extractionMeta.keyword}
        location={extractionMeta.location}
      />
    </div>
  );
}
