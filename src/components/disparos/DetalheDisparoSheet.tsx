import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { disparosService, type StatusEnvio } from '@/services/disparos.backend.service';
import { CHIP_STATUS_DISPARO, CHIP_STATUS_ENVIO, fusoDaConta, formatarDataHora, formatarTelefone } from './disparosFormat';
import { cn } from '@/lib/utils';

interface Props {
  disparoId: string | null;
  onClose: () => void;
}

const FILTROS: { valor: StatusEnvio | 'todos'; rotulo: string }[] = [
  { valor: 'todos', rotulo: 'Todos os status' },
  { valor: 'pendente', rotulo: 'Na fila' },
  { valor: 'enviada', rotulo: 'Enviadas' },
  { valor: 'respondeu', rotulo: 'Responderam' },
  { valor: 'falhou', rotulo: 'Falharam' },
  { valor: 'pulado_optout', rotulo: 'Pediram para sair' },
  { valor: 'pulado_invalido', rotulo: 'Número inválido' },
  { valor: 'pulado_duplicado', rotulo: 'Repetidos' },
];

export function DetalheDisparoSheet({ disparoId, onClose }: Props) {
  const { account } = useAuth();
  const fuso = fusoDaConta(account);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [pagina, setPagina] = useState(1);
  const [filtro, setFiltro] = useState<StatusEnvio | 'todos'>('todos');

  useEffect(() => {
    setPagina(1);
    setFiltro('todos');
  }, [disparoId]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['disparos', 'detalhe', disparoId, pagina, filtro],
    enabled: !!disparoId,
    queryFn: () => disparosService.detalhe(disparoId!, pagina, filtro),
    refetchInterval: (q) => (q.state.data?.disparo.status === 'enviando' ? 15_000 : false),
  });

  const acao = useMutation({
    mutationFn: (qual: 'pausar' | 'retomar' | 'cancelar') => disparosService[qual](disparoId!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['disparos'] }),
    onError: (e: Error) => toast({ title: 'Não foi possível concluir', description: e?.message, variant: 'destructive' }),
  });

  const d = data?.disparo;
  const feitas = d ? d.enviadas + d.falhas : 0;

  return (
    <Sheet open={!!disparoId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader className="text-left">
          <SheetTitle>{d?.nome ?? 'Disparo'}</SheetTitle>
          <SheetDescription>Cada contato da lista, o status e o motivo quando algo falhou.</SheetDescription>
        </SheetHeader>

        {isLoading && <Skeleton className="mt-6 h-40 w-full" />}
        {isError && <p className="mt-6 text-sm text-destructive">Não foi possível carregar este disparo.</p>}

        {d && (
          <div className="mt-5 space-y-5">
            <div className="space-y-3 rounded-xl border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={cn('inline-flex h-[22px] items-center rounded-full px-2.5 text-[11.5px] font-semibold', CHIP_STATUS_DISPARO[d.status].classe)}>
                  {CHIP_STATUS_DISPARO[d.status].rotulo}
                </span>
                <div className="flex gap-2">
                  {d.status === 'enviando' && <Button size="sm" variant="outline" disabled={acao.isPending} onClick={() => acao.mutate('pausar')}>Pausar</Button>}
                  {d.status === 'pausado' && <Button size="sm" variant="outline" disabled={acao.isPending} onClick={() => acao.mutate('retomar')}>Retomar</Button>}
                  {['enviando', 'pausado', 'agendado'].includes(d.status) && (
                    <Button size="sm" variant="ghost" disabled={acao.isPending} onClick={() => acao.mutate('cancelar')}>Cancelar</Button>
                  )}
                </div>
              </div>
              {d.pausadoMotivo && d.status === 'pausado' && <p className="text-sm text-warning">{d.pausadoMotivo}</p>}
              <div className="flex items-center gap-3">
                <Progress value={d.total > 0 ? (feitas / d.total) * 100 : 0} className="h-1.5 flex-1" aria-label="Progresso" />
                <span className="text-[12.5px] font-semibold tabular-nums">{feitas} de {d.total}</span>
              </div>
              <div className="flex flex-wrap gap-4 text-[12.5px] text-muted-foreground">
                <span><b className="tabular-nums text-foreground">{d.enviadas}</b> enviadas</span>
                <span><b className="tabular-nums text-warning">{d.falhas}</b> {d.falhas === 1 ? 'falha' : 'falhas'}</span>
                <span><b className="tabular-nums text-success">{d.respondidas}</b> {d.respondidas === 1 ? 'respondeu' : 'responderam'}</span>
                <span><b className="tabular-nums text-foreground">{d.optout}</b> pediram para sair</span>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3">
              <Select value={filtro} onValueChange={(v) => { setFiltro(v as StatusEnvio | 'todos'); setPagina(1); }}>
                <SelectTrigger className="w-56" aria-label="Filtrar por status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FILTROS.map((f) => <SelectItem key={f.valor} value={f.valor}>{f.rotulo}</SelectItem>)}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground tabular-nums">{data.totalEnvios} contatos</span>
            </div>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contato</TableHead>
                    <TableHead>Número</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Horário</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.envios.length === 0 && (
                    <TableRow><TableCell colSpan={4} className="py-8 text-center text-sm text-muted-foreground">Nenhum contato neste filtro.</TableCell></TableRow>
                  )}
                  {data.envios.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>
                        <div className="font-medium">{e.nome ?? '—'}</div>
                        <div className="text-xs tabular-nums text-muted-foreground">{formatarTelefone(e.telefone)}</div>
                      </TableCell>
                      <TableCell className="text-sm">{e.inboxNome ?? '—'}</TableCell>
                      <TableCell>
                        <span className={cn('inline-flex h-[22px] items-center rounded-full px-2.5 text-[11.5px] font-semibold', CHIP_STATUS_ENVIO[e.status]?.classe)}>
                          {CHIP_STATUS_ENVIO[e.status]?.rotulo ?? e.status}
                        </span>
                        {e.erro && <div className="mt-1 max-w-[220px] text-xs text-warning">{e.erro}</div>}
                      </TableCell>
                      <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                        {formatarDataHora(e.respondidoEm ?? e.enviadoEm ?? e.naoAntesDe, fuso)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {data.totalPaginas > 1 && (
              <div className="flex items-center justify-between">
                <Button size="sm" variant="outline" disabled={pagina <= 1} onClick={() => setPagina((p) => p - 1)}>Anterior</Button>
                <span className="text-xs text-muted-foreground tabular-nums">Página {pagina} de {data.totalPaginas}</span>
                <Button size="sm" variant="outline" disabled={pagina >= data.totalPaginas} onClick={() => setPagina((p) => p + 1)}>Próxima</Button>
              </div>
            )}
          </div>
        )}
        {acao.isPending && <Loader2 className="mt-4 h-4 w-4 animate-spin" aria-hidden="true" />}
      </SheetContent>
    </Sheet>
  );
}
