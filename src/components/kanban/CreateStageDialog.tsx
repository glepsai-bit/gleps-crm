import { useState, useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Plus, Palette, Info } from 'lucide-react';
import { toast } from 'sonner';
import { tagsCloudService } from '@/services/tags.cloud.service';
import { tagsBackendService } from '@/services/tags.backend.service';
import { useBackend } from '@/config/backend.config';

const PRESET_COLORS = [
  '#0EA5E9', // Sky blue
  '#8B5CF6', // Purple
  '#F59E0B', // Amber
  '#22C55E', // Green
  '#EF4444', // Red
  '#EC4899', // Pink
  '#06B6D4', // Cyan
  '#F97316', // Orange
  '#6366F1', // Indigo
  '#14B8A6', // Teal
];

// Convert name to Chatwoot-compatible slug (snake_case)
const toSlug = (name: string): string => {
  return name
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // Remove accents
    .replace(/\s+/g, '_') // Replace spaces with underscores
    .replace(/[^a-z0-9_]/g, ''); // Remove special characters
};

interface CreateStageDialogProps {
  trigger?: React.ReactNode;
  onStageCreated?: () => void;
}

export function CreateStageDialog({ trigger, onStageCreated }: CreateStageDialogProps) {
  const { user, account } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const accountId = user?.account_id || account?.id;

  // Generate slug preview
  const slug = useMemo(() => toSlug(name), [name]);
  const isValidSlug = slug.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!slug) {
      toast.error('Nome da etapa deve conter letras ou números');
      return;
    }

    if (!accountId) {
      toast.error('Conta não encontrada');
      return;
    }

    setIsSubmitting(true);

    try {
      const service = useBackend ? tagsBackendService : tagsCloudService;
      
      // Get or create default funnel
      let funnel = await service.getDefaultFunnel(accountId);
      
      if (!funnel) {
        // Create a default funnel if it doesn't exist
        funnel = await service.createDefaultFunnel(accountId);
      }

      if (!funnel) {
        toast.error('Erro ao obter funil');
        setIsSubmitting(false);
        return;
      }

      // Create the stage tag
      await service.createStageTag({
        accountId,
        funnelId: funnel.id,
        name: name.trim(),
        color,
      });

      toast.success(`Etapa "${name}" criada! Ela também aparecerá no Chatwoot como etiqueta.`);
      setName('');
      setColor(PRESET_COLORS[0]);
      setOpen(false);
      onStageCreated?.();
    } catch (error: any) {
      console.error('Error creating stage:', error);
      toast.error(error.message || 'Erro ao criar etapa');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) {
      setName('');
      setColor(PRESET_COLORS[0]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm" className="gap-2">
            <Plus className="w-4 h-4" />
            Nova Etapa
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Criar Nova Etapa</DialogTitle>
          <DialogDescription>
            A etapa será criada no Kanban e sincronizada automaticamente como etiqueta no Chatwoot.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6 overflow-y-auto flex-1 px-1 py-1 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
          {/* Name Input */}
          <div className="space-y-2">
            <Label htmlFor="stage-name">Nome da Etapa</Label>
            <Input
              id="stage-name"
              placeholder="Ex: Orçamento Enviado"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
            
            {/* Slug Preview */}
            {name && (
              <div className="flex items-start gap-2 p-2 rounded-md bg-muted/50 border">
                <Info className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" />
                <div className="text-xs text-muted-foreground">
                  <span>Label no Chatwoot: </span>
                  <code className={`px-1 py-0.5 rounded ${isValidSlug ? 'bg-primary/10 text-primary font-medium' : 'bg-destructive/10 text-destructive'}`}>
                    {slug || '(inválido)'}
                  </code>
                </div>
              </div>
            )}
          </div>

          {/* Color Picker */}
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Palette className="w-4 h-4" />
              Cor da Etapa
            </Label>
            <div className="flex flex-wrap gap-2">
              {PRESET_COLORS.map((presetColor) => (
                <button
                  key={presetColor}
                  type="button"
                  onClick={() => setColor(presetColor)}
                  className={`w-8 h-8 rounded-full border-2 transition-all ${
                    color === presetColor
                      ? 'border-foreground scale-110 ring-2 ring-offset-2 ring-offset-background'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: presetColor }}
                  title={presetColor}
                />
              ))}
            </div>

            {/* Custom Color Input */}
            <div className="flex items-center gap-2 mt-2">
              <Input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-12 h-8 p-0 border-0 cursor-pointer"
              />
              <span className="text-sm text-muted-foreground">Cor personalizada</span>
            </div>
          </div>

          {/* Preview */}
          <div className="p-4 rounded-lg border bg-muted/30">
            <p className="text-xs text-muted-foreground mb-2">Prévia:</p>
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: color }}
              />
              <span className="font-medium text-sm">{name || 'Nome da Etapa'}</span>
            </div>
          </div>

          <DialogFooter className="gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={isSubmitting || !isValidSlug}>
              {isSubmitting ? 'Criando...' : 'Criar Etapa'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
