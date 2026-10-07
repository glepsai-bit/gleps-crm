import { Skeleton } from '@/components/ui/skeleton';
import type { ListaAquecimento } from '@/services/aquecimento.backend.service';
import { emQuantoTempo, horaDaJanela } from './aquecimentoFormat';

interface Props {
  data: ListaAquecimento | undefined;
  carregando: boolean;
}

function Fato({ rotulo, children, ultimo }: { rotulo: string; children: React.ReactNode; ultimo?: boolean }) {
  return (
    <div className={`px-5 py-4 ${ultimo ? '' : 'sm:border-r'} border-border`}>
      <div className="text-xs font-medium text-muted-foreground">{rotulo}</div>
      <div className="mt-1.5 text-base font-semibold text-foreground">{children}</div>
    </div>
  );
}

export function FaixaSituacao({ data, carregando }: Props) {
  if (carregando && !data) return <Skeleton className="h-[74px] w-full rounded-xl" />;
  const numeros = data?.numeros ?? [];
  const conta = (s: string) => numeros.filter((n) => n.status === s).length;
  const aquecendo = conta('aquecendo') + conta('aguardando_parceiro');
  const agora = data?.agora;

  return (
    <section aria-label="Situação" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 rounded-xl border bg-card">
      <Fato rotulo="Números">
        <span className="tabular-nums">{numeros.length}</span> no total{' '}
        <span className="font-medium text-muted-foreground">
          · {aquecendo} aquecendo · {conta('pronto')} {conta('pronto') === 1 ? 'pronto' : 'prontos'} · {conta('pausado')} {conta('pausado') === 1 ? 'pausado' : 'pausados'}
        </span>
      </Fato>
      <Fato rotulo="Próxima conversa">
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
          {agora ? emQuantoTempo(agora.proximaRodadaEm) : '—'}
        </span>
      </Fato>
      <Fato rotulo="Horário de hoje">
        {agora ? `${horaDaJanela(agora.janela.inicio)}–${horaDaJanela(agora.janela.fim)}` : '—'}{' '}
        {agora && <span className="font-medium text-muted-foreground">· {agora.janela.fuso}</span>}
      </Fato>
      <Fato rotulo="Trocadas hoje" ultimo>
        <span className="tabular-nums">{agora?.trocadasHoje ?? 0}</span> mensagens{' '}
        <span className="font-medium text-muted-foreground">
          · {agora?.falhasHoje ?? 0} {agora?.falhasHoje === 1 ? 'falha' : 'falhas'}
        </span>
      </Fato>
    </section>
  );
}
