import { AlertTriangle } from 'lucide-react';
import { horaCurta, infraPausaAtiva } from './aquecimentoFormat';

/** Só aparece com data futura: a conversa espera, e isso não conta como falha dos números. */
export function AvisoInfra({ infraPausaAte }: { infraPausaAte: string | null | undefined }) {
  if (!infraPausaAtiva(infraPausaAte)) return null;
  return (
    <section role="status" className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-[13px] text-warning">
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span>
        A Evolution não respondeu. A conversa está pausada até {horaCurta(infraPausaAte)} e volta sozinha — isso <b>não</b> conta como falha dos seus números.
      </span>
    </section>
  );
}
