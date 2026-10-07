import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { FechamentoMetrics } from '@/services/chat-metrics.backend.service';
import { formatMoeda, formatNumero, formatPct, pct } from './dashboardFormat';

interface FunilFechamentoProps {
  fechamento: FechamentoMetrics;
  carregando?: boolean;
}

interface Etapa {
  rotulo: string;
  valor: number | undefined;
  sub: React.ReactNode;
  borda: string;
  destaqueSub?: string;
}

export function FunilFechamento({ fechamento: f, carregando }: FunilFechamentoProps) {
  const base = f.novosContatos;
  const dosNovos = (n: number | undefined) =>
    n === undefined ? null : <><b className="font-semibold text-foreground/80">{formatPct(pct(n, base))}</b> dos novos</>;

  const etapas: Etapa[] = [
    { rotulo: 'Contatos novos', valor: base, sub: '100%', borda: 'border-t-primary' },
    { rotulo: 'Atendidos', valor: f.atendidos, sub: dosNovos(f.atendidos), borda: 'border-t-primary/75' },
    { rotulo: 'Reunião marcada', valor: f.comReuniao, sub: dosNovos(f.comReuniao), borda: 'border-t-primary/50' },
    {
      rotulo: 'Fechados',
      valor: f.conversoes,
      sub: (
        <>
          <b className="font-semibold text-warning">{formatPct(f.taxaConversao)}</b> atendimento → venda
        </>
      ),
      borda: 'border-t-warning',
    },
  ];

  const ticket = f.ticketMedio !== undefined ? f.ticketMedio : f.vendasComValor > 0 ? f.receita / f.vendasComValor : null;
  const semValor = f.semValor ?? 0;

  return (
    <section aria-label="Do primeiro contato ao fechamento" className="rounded-xl border bg-card p-5 flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground">Do primeiro contato ao fechamento</h2>
          <p className="text-[12.5px] text-muted-foreground mt-1">Contatos criados no período e até onde chegaram</p>
        </div>
        <Link to="/admin/kanban" className="text-[13px] font-medium text-primary hover:underline">
          Abrir o Kanban →
        </Link>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-stretch">
        <div className="lg:col-span-2 grid grid-cols-2 md:grid-cols-4 gap-2">
          {etapas.map((e) => (
            <div key={e.rotulo} className={cn('rounded-[10px] bg-muted/50 px-4 py-3.5 border-t-[3px]', e.borda)}>
              <div className="text-xs font-medium text-muted-foreground">{e.rotulo}</div>
              {carregando ? (
                <Skeleton className="h-7 w-12 mt-2" />
              ) : (
                <div className="text-[26px] font-bold tabular-nums text-foreground mt-2">{e.valor === undefined ? '—' : formatNumero(e.valor)}</div>
              )}
              <div className="text-xs text-muted-foreground mt-1 min-h-4">{e.sub}</div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2 rounded-[10px] border border-success/30 bg-success/10 px-4 py-3.5 flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-success">Receita do período</div>
              <div className="text-[26px] font-bold tabular-nums text-foreground mt-1.5">{formatMoeda(f.receita)}</div>
            </div>
            <div className="text-right text-xs text-muted-foreground leading-relaxed">
              {formatNumero(f.vendasComValor)} {f.vendasComValor === 1 ? 'venda com valor' : 'vendas com valor'}
              {semValor > 0 && (
                <>
                  <br />
                  <Link to="/admin/kanban" className="text-warning hover:underline">
                    {semValor} sem valor informado →
                  </Link>
                </>
              )}
            </div>
          </div>
          <div className="rounded-[10px] bg-muted/50 px-4 py-3">
            <div className="text-xs font-medium text-muted-foreground">Ticket médio</div>
            <div className="text-xl font-bold tabular-nums text-foreground mt-1.5">{formatMoeda(ticket)}</div>
          </div>
          <div className="rounded-[10px] bg-muted/50 px-4 py-3">
            <div className="text-xs font-medium text-muted-foreground">Perdidos</div>
            <div className="text-xl font-bold tabular-nums text-foreground mt-1.5">
              {formatNumero(f.perdas)}{' '}
              <span className="text-xs font-medium text-muted-foreground">· {formatPct(pct(f.perdas, base))}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
