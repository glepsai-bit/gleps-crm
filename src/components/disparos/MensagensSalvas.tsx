import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { createTemplate, deleteTemplate, listTemplates, type WhatsappTemplate } from '@/services/whatsapp-templates.backend.service';

interface Props {
  onUsar: (texto: string) => void;
}

/** Mensagens salvas = WhatsappTemplate; "Usar" abre o Novo disparo com o texto. */
export function MensagensSalvas({ onUsar }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [novaAberta, setNovaAberta] = useState(false);
  const [nome, setNome] = useState('');
  const [conteudo, setConteudo] = useState('');
  const [excluir, setExcluir] = useState<WhatsappTemplate | null>(null);

  const { data = [], isLoading } = useQuery({ queryKey: ['whatsapp-templates'], queryFn: listTemplates });

  const criar = useMutation({
    mutationFn: () => createTemplate({ name: nome.trim(), content: conteudo.trim(), category: 'custom' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['whatsapp-templates'] });
      setNovaAberta(false);
      setNome('');
      setConteudo('');
      toast({ title: 'Mensagem salva' });
    },
    onError: (e: Error) => toast({ title: 'Não foi possível salvar', description: e?.message, variant: 'destructive' }),
  });

  const apagar = useMutation({
    mutationFn: (id: string) => deleteTemplate(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['whatsapp-templates'] });
      setExcluir(null);
    },
    onError: (e: Error) => toast({ title: 'Não foi possível excluir', description: e?.message, variant: 'destructive' }),
  });

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-[15px] font-semibold">Mensagens salvas</h2>
        <button type="button" className="text-[12.5px] text-primary hover:underline" onClick={() => setNovaAberta(true)}>+ Nova</button>
      </div>

      {isLoading && <Skeleton className="h-12 w-full" />}
      {!isLoading && data.length === 0 && <p className="text-[13px] text-muted-foreground">Nenhuma mensagem salva ainda.</p>}
      <ul className="flex flex-col gap-2">
        {data.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold">{t.name}</div>
              <div className="truncate text-xs text-muted-foreground">{t.content}</div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs" onClick={() => onUsar(t.content)} aria-label={`Usar ${t.name}`}>Usar</Button>
              <Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`Excluir ${t.name}`} onClick={() => setExcluir(t)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Dialog open={novaAberta} onOpenChange={setNovaAberta}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Nova mensagem salva</DialogTitle>
            <DialogDescription>Use {'{{nome}}'}, {'{{primeiro_nome}}'} e {'{{empresa}}'} para personalizar.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2"><Label htmlFor="msg-nome">Nome</Label><Input id="msg-nome" value={nome} onChange={(e) => setNome(e.target.value)} /></div>
            <div className="space-y-2"><Label htmlFor="msg-conteudo">Texto</Label><Textarea id="msg-conteudo" rows={5} value={conteudo} onChange={(e) => setConteudo(e.target.value)} /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNovaAberta(false)}>Cancelar</Button>
            <Button disabled={!nome.trim() || !conteudo.trim() || criar.isPending} onClick={() => criar.mutate()}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!excluir} onOpenChange={(o) => !o && setExcluir(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir "{excluir?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>A mensagem some da lista. Disparos já criados não mudam.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => excluir && apagar.mutate(excluir.id)}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
