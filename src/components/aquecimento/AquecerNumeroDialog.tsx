import { useEffect, useState } from 'react';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { InboxDisponivel } from '@/services/aquecimento.backend.service';
import { formatarTelefone, iniciais } from './aquecimentoFormat';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  inboxes: InboxDisponivel[];
  /** quantos números já aquecem na conta (só para a nota) */
  jaAquecendo: number;
  enviando: boolean;
  onConfirmar: (inboxId: string) => void;
}

function conectada(i: InboxDisponivel): boolean {
  if (i.conectada !== undefined) return i.conectada;
  return i.status === undefined || i.status === 'open';
}

export function AquecerNumeroDialog({ open, onOpenChange, inboxes, jaAquecendo, enviando, onConfirmar }: Props) {
  const [escolhida, setEscolhida] = useState<string>('');
  useEffect(() => { if (!open) setEscolhida(''); }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Aquecer um número</DialogTitle>
          <DialogDescription>
            Ele vai conversar com os outros números em aquecimento desta conta, todos os dias, por 30 dias.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="flex flex-col gap-2 border-0 p-0 m-0">
          <legend className="mb-2 text-[12.5px] font-semibold text-foreground">Qual número?</legend>
          {inboxes.length === 0 && (
            <p className="rounded-lg border border-dashed p-4 text-center text-[13px] text-muted-foreground">
              Nenhum número conectado disponível. Conecte um WhatsApp em Configurações › Inboxes primeiro.
            </p>
          )}
          {inboxes.map((i) => {
            const ok = conectada(i);
            const marcado = escolhida === i.id;
            return (
              <label
                key={i.id}
                className={cn(
                  'flex items-center gap-3 rounded-[10px] border bg-card px-3.5 py-3',
                  ok ? 'cursor-pointer' : 'cursor-not-allowed opacity-55',
                  marcado && 'border-primary bg-primary/5',
                )}
              >
                <input
                  type="radio"
                  name="numero"
                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                  disabled={!ok}
                  checked={marcado}
                  onChange={() => setEscolhida(i.id)}
                />
                <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-[11.5px] font-semibold text-foreground/80">{iniciais(i.nome)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-semibold text-foreground">{i.nome}</span>
                  <span className="block text-xs text-muted-foreground tabular-nums">
                    {ok ? (i.telefone ? `${formatarTelefone(i.telefone)} · número vem da conexão` : 'número vem da conexão') : 'desconectado — conecte em Inboxes primeiro'}
                  </span>
                </span>
                <span className={cn('inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold', ok ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning')}>
                  {ok ? 'conectado' : 'sem conexão'}
                </span>
              </label>
            );
          })}
        </fieldset>

        <div className="flex items-start gap-2.5 rounded-[10px] bg-muted px-3.5 py-3 text-[12.5px] leading-relaxed text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span>
            Começa com <b className="text-foreground tabular-nums">10</b> mensagens por dia e chega a <b className="text-foreground tabular-nums">200</b> no dia 22.{' '}
            {jaAquecendo === 0
              ? 'Ainda não há outro número aquecendo — ele só começa a conversar quando houver um segundo.'
              : jaAquecendo === 1
                ? 'Hoje já há 1 número aquecendo, então ele tem com quem conversar.'
                : `Hoje já há ${jaAquecendo} números aquecendo, então ele tem com quem conversar.`}{' '}
            Pausa sozinho se os envios falharem.
          </span>
        </div>

        <DialogFooter className="border-t pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={enviando}>Cancelar</Button>
          <Button onClick={() => onConfirmar(escolhida)} disabled={!escolhida || enviando}>
            {enviando ? 'Começando…' : 'Começar a aquecer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
