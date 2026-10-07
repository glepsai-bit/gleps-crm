import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from 'recharts';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import type { DiaHistorico, NumeroAquecimento } from '@/services/aquecimento.backend.service';
import { formatarTelefone } from './aquecimentoFormat';

interface Props {
  numero: NumeroAquecimento | null;
  dados: DiaHistorico[] | undefined;
  carregando: boolean;
  onClose: () => void;
}

export function HistoricoSheet({ numero, dados, carregando, onClose }: Props) {
  const pontos = (dados ?? []).map((d) => ({
    data: d.date.slice(5).split('-').reverse().join('/'),
    planejado: d.planned,
    enviado: d.actual,
    falhas: d.failed,
  }));
  return (
    <Sheet open={!!numero} onOpenChange={(v) => { if (!v) onClose(); }}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{numero?.inboxNome}</SheetTitle>
          <SheetDescription className="tabular-nums">{numero ? formatarTelefone(numero.telefone) : ''} · últimos 30 dias</SheetDescription>
        </SheetHeader>
        <div className="mt-5 flex flex-col gap-3">
          <div className="flex gap-4 text-[12.5px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-muted-foreground/40" />Planejado</span>
            <span className="flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-sm bg-primary" />Enviado</span>
            <span className="flex items-center gap-1.5"><i className="h-[3px] w-2.5 rounded bg-destructive" />Falhas</span>
          </div>
          {carregando ? (
            <Skeleton className="h-[260px] w-full" />
          ) : pontos.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">Ainda não há histórico. O primeiro dia fecha à meia-noite.</p>
          ) : (
            <div role="img" aria-label="Mensagens planejadas, enviadas e falhas por dia">
              <ChartContainer
                config={{
                  planejado: { label: 'Planejado', color: 'hsl(var(--muted-foreground))' },
                  enviado: { label: 'Enviado', color: 'hsl(var(--primary))' },
                  falhas: { label: 'Falhas', color: 'hsl(var(--destructive))' },
                }}
                className="h-[260px] w-full"
              >
                <ComposedChart data={pontos} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="data" axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={24} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
                  <YAxis axisLine={false} tickLine={false} allowDecimals={false} width={32} tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 11 }} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="planejado" name="Planejado" fill="hsl(var(--muted-foreground))" fillOpacity={0.35} radius={[3, 3, 0, 0]} />
                  <Bar dataKey="enviado" name="Enviado" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
                  <Line type="monotone" dataKey="falhas" name="Falhas" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ChartContainer>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
