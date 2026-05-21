import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Loader2, Save } from 'lucide-react';
import { useBackend } from '@/config/backend.config';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/contexts/AuthContext';
import type { ExtractedLead } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leads: ExtractedLead[];
  keyword?: string;
  location?: string;
  /** Origem opcional para descrição padrão (ex: "CSV: arquivo.csv", "CRM — Etapa X") */
  defaultDescription?: string;
  onSaved?: () => void;
}

export function SaveAudienceDialog({
  open, onOpenChange, leads, keyword, location, defaultDescription, onSaved,
}: Props) {
  const { toast } = useToast();
  const { account, user } = useAuth();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!name.trim()) {
      toast({ title: 'Informe um nome para o público', variant: 'destructive' });
      return;
    }
    if (leads.length === 0) {
      toast({ title: 'Selecione ao menos 1 lead para salvar', variant: 'destructive' });
      return;
    }

    setSaving(true);
    try {
      const finalDesc = description.trim() || defaultDescription || undefined;
      const payload = {
        name: name.trim(),
        description: finalDesc,
        keyword,
        location,
        leads: leads.map((l) => ({
          name: l.nome,
          phone: l.telefone || null,
          address: l.endereco || null,
          rating: l.avaliacao ?? null,
          website: l.site || null,
          category: l.cidade || null,
          rawData: l,
        })),
      };

      if (useBackend) {
        await apiClient.post(API_ENDPOINTS.PROSPECTING.AUDIENCES, payload);
      } else {
        const accountId = account?.id;
        if (!accountId) throw new Error('Conta não identificada');

        const { data: aud, error: audErr } = await supabase
          .from('prospecting_audiences' as any)
          .insert({
            account_id: accountId,
            name: payload.name,
            description: finalDesc || null,
            keyword: keyword || null,
            location: location || null,
            total_leads: leads.length,
            created_by: user?.id || null,
          })
          .select('id')
          .single();
        if (audErr) throw audErr;

        const audienceId = (aud as any).id;
        const rows = payload.leads.map((l) => ({
          audience_id: audienceId,
          name: l.name,
          phone: l.phone,
          address: l.address,
          rating: l.rating,
          website: l.website,
          category: l.category,
          raw_data: l.rawData,
        }));
        const { error: leadErr } = await supabase
          .from('prospecting_audience_leads' as any)
          .insert(rows);
        if (leadErr) throw leadErr;
      }

      toast({
        title: 'Público salvo!',
        description: `${leads.length} leads salvos em "${name.trim()}".`,
      });
      setName('');
      setDescription('');
      onOpenChange(false);
      onSaved?.();
    } catch (err: any) {
      console.error('Save audience error:', err);
      toast({
        title: 'Erro ao salvar público',
        description: err?.message || 'Tente novamente',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Salvar como público</DialogTitle>
          <DialogDescription>
            Salve estes {leads.length} leads para reutilizar depois sem gastar nova requisição da API.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label htmlFor="audience-name">Nome do público *</Label>
            <Input
              id="audience-name"
              placeholder="Ex: Clínicas Médicas - Rio de Janeiro"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="audience-desc">Descrição (opcional)</Label>
            <Textarea
              id="audience-desc"
              placeholder={defaultDescription || 'Notas sobre este público...'}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>

          {(keyword || location || defaultDescription) && (
            <div className="text-xs text-muted-foreground space-y-0.5 rounded-md border bg-muted/30 p-3">
              {keyword && <div><strong>Nicho:</strong> {keyword}</div>}
              {location && <div><strong>Localização:</strong> {location}</div>}
              {defaultDescription && !keyword && !location && (
                <div><strong>Origem:</strong> {defaultDescription}</div>
              )}
              <div><strong>Total de leads:</strong> {leads.length}</div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Salvando...</>
            ) : (
              <><Save className="w-4 h-4 mr-2" /> Salvar público</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
