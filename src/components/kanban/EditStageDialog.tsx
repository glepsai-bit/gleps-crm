import { useEffect, useState } from 'react';
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
} from '@/components/ui/dialog';
import { Lock } from 'lucide-react';

const CORES = [
  '#0EA5E9',
  '#8B5CF6',
  '#F59E0B',
  '#22C55E',
  '#EF4444',
  '#EC4899',
  '#06B6D4',
  '#F97316',
  '#6366F1',
  '#14B8A6',
];

interface EditStageDialogProps {
  /** Etapa sendo editada; null mantém o diálogo fechado. */
  etapa: { id: string; name: string; color: string; papel?: 'fechamento' | 'perda' | null } | null;
  onOpenChange: (open: boolean) => void;
  onSalvar: (id: string, dados: { name: string; color: string }) => Promise<void>;
}

/**
 * Renomear e colorir uma etapa. Vale também para as fixas (Fechado/Perdido):
 * o que elas não permitem é apagar e reordenar — o nome é livre.
 */
export function EditStageDialog({ etapa, onOpenChange, onSalvar }: EditStageDialogProps) {
  const [nome, setNome] = useState('');
  const [cor, setCor] = useState(CORES[0]);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    if (etapa) {
      setNome(etapa.name);
      setCor(etapa.color);
    }
  }, [etapa]);

  const valido = nome.trim().length > 0;

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!etapa || !valido) return;
    setSalvando(true);
    try {
      await onSalvar(etapa.id, { name: nome.trim(), color: cor });
      onOpenChange(false);
    } catch {
      // quem chamou já mostrou o erro
    } finally {
      setSalvando(false);
    }
  };

  return (
    <Dialog open={!!etapa} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar etapa</DialogTitle>
          <DialogDescription>
            {etapa?.papel ? (
              <span className="inline-flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5" />
                Etapa fixa do funil: você pode mudar o nome e a cor, mas ela não é apagada.
              </span>
            ) : (
              'Mude o nome ou a cor da etapa.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={salvar} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="editar-etapa-nome">Nome da etapa</Label>
            <Input
              id="editar-etapa-nome"
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label>Cor da etapa</Label>
            <div className="flex flex-wrap gap-2">
              {CORES.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`Cor ${c}`}
                  onClick={() => setCor(c)}
                  className={`w-8 h-8 rounded-full border-2 transition-all ${
                    cor === c
                      ? 'border-foreground scale-110 ring-2 ring-offset-2 ring-offset-background'
                      : 'border-transparent hover:scale-105'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
            </div>
            <div className="flex items-center gap-2">
              <Input
                type="color"
                value={cor}
                onChange={(e) => setCor(e.target.value)}
                className="w-12 h-8 p-0 border-0 cursor-pointer"
              />
              <span className="text-sm text-muted-foreground">Cor personalizada</span>
            </div>
          </div>
          <DialogFooter className="gap-3">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!valido || salvando}>
              {salvando ? 'Salvando...' : 'Salvar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
