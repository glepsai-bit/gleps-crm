import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Search, MapPin, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { useToast } from '@/hooks/use-toast';
import type { ExtractedLead, ApiUsage } from './types';

 interface Props {
   accountId: string;
   onResults: (leads: ExtractedLead[], usage?: ApiUsage, meta?: { keyword: string; location: string }) => void;
   isLoading: boolean;
   setIsLoading: (v: boolean) => void;
   isLimitReached?: boolean;
 }
 
 export function ExtractionSearchForm({ 
   accountId, 
   onResults, 
   isLoading, 
   setIsLoading,
   isLimitReached 
 }: Props) {
  const [nicho, setNicho] = useState('');
  const [localizacao, setLocalizacao] = useState('');
  const { toast } = useToast();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nicho.trim() || !localizacao.trim()) {
      toast({ title: 'Preencha todos os campos', variant: 'destructive' });
      return;
    }

     if (isLimitReached) {
       toast({ 
         title: 'Limite atingido', 
         description: 'Você atingiu seu limite mensal de extrações. Entre em contato com o suporte para aumentar seu plano.',
         variant: 'destructive' 
       });
       return;
     }
 
     setIsLoading(true);
    try {
      let data: any;

      if (useBackend) {
        const response = await apiClient.post(API_ENDPOINTS.PROSPECTING.EXTRACT, {
          nicho: nicho.trim(),
          localizacao: localizacao.trim(),
        });
        data = (response as any).data || response;
      } else {
        const result = await supabase.functions.invoke('extract-leads', {
          body: { account_id: accountId, nicho: nicho.trim(), localizacao: localizacao.trim() },
        });
        if (result.error) throw result.error;
        data = result.data;
      }

      if (!data?.success || !Array.isArray(data.leads)) {
        throw new Error(data?.error || 'Nenhum resultado encontrado');
      }

      const leads: ExtractedLead[] = data.leads.map((l: any, i: number) => ({
        id: `lead-${Date.now()}-${i}`,
        nome: l.nome || '',
        cidade: l.cidade || '',
        endereco: l.endereco || '',
        telefone: l.telefone || '',
        site: l.site || '',
        avaliacao: l.avaliacao ?? null,
        total_avaliacoes: l.total_avaliacoes ?? null,
        foto: l.foto || '',
        status_negocio: l.status_negocio || '',
        place_id: l.place_id || '',
        google_maps_url: l.google_maps_url || '',
      }));

      onResults(leads, data.usage, { keyword: nicho.trim(), location: localizacao.trim() });
      toast({ title: `${leads.length} leads encontrados!` });
    } catch (err: any) {
      console.error('Extraction error:', err);
      toast({ title: 'Erro na extração', description: err.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Nicho (ex: padarias, dentistas...)"
              value={nicho}
              onChange={e => setNicho(e.target.value)}
              className="pl-10"
              disabled={isLoading}
            />
          </div>
          <div className="flex-1 relative">
            <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Localização (ex: João Pinheiro, MG)"
              value={localizacao}
              onChange={e => setLocalizacao(e.target.value)}
              className="pl-10"
              disabled={isLoading}
            />
          </div>
           <Button type="submit" disabled={isLoading || isLimitReached} className="min-w-[140px]">
             {isLimitReached ? (
               'Limite Atingido'
             ) : isLoading ? (
               <>
                 <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                 Buscando...
               </>
             ) : (
               <>
                 <Search className="w-4 h-4 mr-2" />
                 Buscar Leads
               </>
             )}
           </Button>
        </form>
      </CardContent>
    </Card>
  );
}
