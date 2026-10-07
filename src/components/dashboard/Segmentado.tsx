import { cn } from '@/lib/utils';

interface Opcao<T extends string> {
  valor: T;
  rotulo: string;
}

interface SegmentadoProps<T extends string> {
  rotuloGrupo: string;
  opcoes: Opcao<T>[];
  valor: T;
  onChange: (v: T) => void;
  compacto?: boolean;
}

/** Seletor segmentado com botões reais e aria-pressed. */
export function Segmentado<T extends string>({ rotuloGrupo, opcoes, valor, onChange, compacto }: SegmentadoProps<T>) {
  return (
    <div role="group" aria-label={rotuloGrupo} className={cn('inline-flex rounded-lg border bg-card', compacto ? 'p-0.5' : 'p-[3px]')}>
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          aria-pressed={valor === o.valor}
          onClick={() => onChange(o.valor)}
          className={cn(
            'rounded-md text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            compacto ? 'h-[26px] px-2.5 text-xs' : 'h-[30px] px-3 text-[13px]',
            valor === o.valor && 'bg-muted text-foreground font-medium',
          )}
        >
          {o.rotulo}
        </button>
      ))}
    </div>
  );
}
