import type { ReactNode } from 'react';
import { Line, LineChart } from 'recharts';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { Variacao } from './dashboardFormat';

interface IndicadorProps {
  label: string;
  /** Valor já formatado. null = sem dado ("—"). */
  valor: ReactNode;
  carregando?: boolean;
  /** Série para o sparkline; omitido = sem sparkline. */
  serie?: number[];
  /** Token CSS de cor do sparkline, ex.: 'var(--primary)'. */
  corSerie?: string;
  variacao?: Variacao | null;
  /** Mostrado quando não há variação. */
  subtitulo?: ReactNode;
  /** Linha extra mostrada sempre, abaixo da variação/subtítulo. */
  detalhe?: ReactNode;
  rotuloGrafico?: string;
  onClick?: () => void;
}

const TOM: Record<Variacao['tom'], string> = {
  melhora: 'text-success',
  piora: 'text-warning',
  neutro: 'text-foreground',
};

export function Indicador({
  label,
  valor,
  carregando,
  serie,
  corSerie = 'var(--primary)',
  variacao,
  subtitulo,
  detalhe,
  rotuloGrafico,
  onClick,
}: IndicadorProps) {
  const dados = (serie ?? []).map((v, i) => ({ i, v }));
  const temSerie = dados.length > 1;

  const conteudo = (
    <>
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="flex items-end justify-between gap-2">
        {carregando ? (
          <Skeleton className="h-7 w-16" />
        ) : (
          <div className="text-[28px] font-bold leading-none tabular-nums text-foreground">{valor}</div>
        )}
        {temSerie && !carregando && (
          <div role="img" aria-label={rotuloGrafico ?? `Evolução diária: ${label}`} className="shrink-0">
            <LineChart width={80} height={28} data={dados} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <Line
                type="monotone"
                dataKey="v"
                stroke={`hsl(${corSerie})`}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </div>
        )}
      </div>
      <div className="text-xs text-muted-foreground min-h-4">
        {carregando ? (
          <Skeleton className="h-3 w-24" />
        ) : variacao ? (
          <>
            <span className={cn('font-semibold', TOM[variacao.tom])}>{variacao.destaque}</span> {variacao.resto}
          </>
        ) : (
          subtitulo
        )}
        {!carregando && detalhe && <div>{detalhe}</div>}
      </div>
    </>
  );

  const base = 'rounded-xl border bg-card p-4 flex flex-col gap-2.5 text-left min-w-0';

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(base, 'transition-colors hover:border-primary/50 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
      >
        {conteudo}
      </button>
    );
  }
  return <div className={base}>{conteudo}</div>;
}
