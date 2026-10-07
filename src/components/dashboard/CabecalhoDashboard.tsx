import { useState } from 'react';
import { DateRange } from 'react-day-picker';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarComponent } from '@/components/ui/calendar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatHa } from './dashboardFormat';

export type PeriodoOpcao = '7d' | '30d' | 'custom';

interface Opcao {
  id: string;
  nome: string;
}

interface CabecalhoDashboardProps {
  periodo: PeriodoOpcao;
  onPeriodo: (p: PeriodoOpcao) => void;
  intervalo: DateRange;
  onIntervalo: (r: DateRange) => void;
  /** Intervalo efetivo (já resolvido) para o subtítulo. */
  de: Date;
  ate: Date;
  atualizadoHaSegundos: number | null;
  inboxId: string;
  onInbox: (v: string) => void;
  inboxes: Opcao[];
  teamId: string;
  onTeam: (v: string) => void;
  times: Opcao[];
  agentId: string;
  onAgent: (v: string) => void;
  agentes: Opcao[];
}

const PERIODOS: { valor: PeriodoOpcao; rotulo: string }[] = [
  { valor: '7d', rotulo: '7 dias' },
  { valor: '30d', rotulo: '30 dias' },
  { valor: 'custom', rotulo: 'Personalizado' },
];

export function CabecalhoDashboard(p: CabecalhoDashboardProps) {
  const [calAberto, setCalAberto] = useState(false);

  const nomePeriodo = p.periodo === '7d' ? 'Últimos 7 dias' : p.periodo === '30d' ? 'Últimos 30 dias' : 'Período personalizado';
  const faixa = `${format(p.de, 'd MMM', { locale: ptBR })} a ${format(p.ate, 'd MMM', { locale: ptBR })}`;

  const botao = (valor: PeriodoOpcao, rotulo: string) => (
    <button
      key={valor}
      type="button"
      aria-pressed={p.periodo === valor}
      onClick={() => {
        p.onPeriodo(valor);
        if (valor === 'custom') setCalAberto(true);
      }}
      className={cn(
        'h-[30px] rounded-md px-3 text-[13px] text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        p.periodo === valor && 'bg-muted font-medium text-foreground',
      )}
    >
      {rotulo}
    </button>
  );

  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Dashboard</h1>
        <p className="mt-1.5 text-[13.5px] text-muted-foreground">
          {nomePeriodo} · {faixa}
          {p.atualizadoHaSegundos !== null && <> · atualizado há {formatHa(p.atualizadoHaSegundos)}</>}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Popover open={calAberto} onOpenChange={setCalAberto}>
          <div role="group" aria-label="Período" className="inline-flex rounded-lg border bg-card p-[3px]">
            {PERIODOS.map((o) =>
              o.valor === 'custom' ? (
                <PopoverTrigger asChild key={o.valor}>
                  {botao(o.valor, o.rotulo)}
                </PopoverTrigger>
              ) : (
                botao(o.valor, o.rotulo)
              ),
            )}
          </div>
          <PopoverContent className="w-auto p-0" align="end">
            <CalendarComponent
              initialFocus
              mode="range"
              defaultMonth={p.intervalo?.from}
              selected={p.intervalo}
              onSelect={(r) => {
                if (r) p.onIntervalo(r);
              }}
              numberOfMonths={2}
              locale={ptBR}
            />
          </PopoverContent>
        </Popover>

        <FiltroSelect valor={p.inboxId} onChange={p.onInbox} todos="Todos os inboxes" opcoes={p.inboxes} rotulo="Filtrar por inbox" />
        <FiltroSelect valor={p.teamId} onChange={p.onTeam} todos="Todos os times" opcoes={p.times} rotulo="Filtrar por time" />
        <FiltroSelect valor={p.agentId} onChange={p.onAgent} todos="Todos os agentes" opcoes={p.agentes} rotulo="Filtrar por agente" />
      </div>
    </header>
  );
}

function FiltroSelect({ valor, onChange, todos, opcoes, rotulo }: { valor: string; onChange: (v: string) => void; todos: string; opcoes: Opcao[]; rotulo: string }) {
  return (
    <Select value={valor} onValueChange={onChange}>
      <SelectTrigger aria-label={rotulo} className="h-9 w-[165px] text-[13px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{todos}</SelectItem>
        {opcoes.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.nome}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
