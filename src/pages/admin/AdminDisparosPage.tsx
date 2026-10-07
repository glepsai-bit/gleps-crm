import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { tagsBackendService } from '@/services/tags.backend.service';
import { whatsappConsentsBackendService } from '@/services/whatsapp-consents.backend.service';
import { disparosService, type DisparoResumo } from '@/services/disparos.backend.service';
import { NumerosHoje } from '@/components/disparos/NumerosHoje';
import { DisparoCard } from '@/components/disparos/DisparoCard';
import { MensagensSalvas } from '@/components/disparos/MensagensSalvas';
import { NovoDisparoDialog } from '@/components/disparos/NovoDisparoDialog';
import { DetalheDisparoSheet } from '@/components/disparos/DetalheDisparoSheet';
import {
  FUSO_PADRAO,
  fusoDaConta,
  descreverLista,
  formatarDia,
  nomesDosNumeros,
  percentual,
} from '@/components/disparos/disparosFormat';

const REGRAS: { texto: React.ReactNode; alerta?: boolean }[] = [
  { texto: <>Envia só das <b>08h às 20h</b>, no horário da conta. O que sobra continua no dia seguinte.</> },
  { texto: <><b>20 a 60 segundos</b> entre mensagens, sempre variando.</> },
  { texto: <>Respeita o <b>limite diário do número</b>, que vem do aquecimento.</> },
  { texto: <>Quem respondeu <b>SAIR</b> nunca mais recebe. Duplicados e números inválidos ficam de fora.</> },
  { texto: <><b>5 falhas seguidas</b>: pausa o disparo e avisa aqui e no sino.</>, alerta: true },
];

export default function AdminDisparosPage() {
  const { account } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const accountId = account?.id ?? '';
  const fuso = fusoDaConta(account);

  const [dialogoAberto, setDialogoAberto] = useState(false);
  const [publicoInicial, setPublicoInicial] = useState<string | null>(null);
  const [textoInicial, setTextoInicial] = useState<string | null>(null);
  const [editando, setEditando] = useState<DisparoResumo | null>(null);
  const [verId, setVerId] = useState<string | null>(null);
  const [aCancelar, setACancelar] = useState<DisparoResumo | null>(null);

  // A Extração leva para cá com ?publico=<id>: abre o diálogo já com o público escolhido.
  useEffect(() => {
    const publico = params.get('publico');
    if (!publico) return;
    setPublicoInicial(publico);
    setTextoInicial(null);
    setEditando(null);
    setDialogoAberto(true);
    setParams((p) => { const n = new URLSearchParams(p); n.delete('publico'); return n; }, { replace: true });
  }, [params, setParams]);

  const { data: lista, isLoading, isError } = useQuery({
    queryKey: ['disparos', 'lista'],
    queryFn: () => disparosService.listar(),
    refetchInterval: (q) => (q.state.data?.emAndamento.some((d) => d.status === 'enviando') ? 15_000 : false),
  });
  const { data: numerosResp, isLoading: carregandoNumeros } = useQuery({
    queryKey: ['disparos', 'numeros'],
    queryFn: () => disparosService.numeros(),
    refetchInterval: 60_000,
  });
  const numeros = numerosResp?.numeros ?? [];

  // Só pergunta o total de opt-outs à parte quando /numeros não trouxe.
  const { data: optoutsLista } = useQuery({
    queryKey: ['disparos', 'optouts'],
    enabled: numerosResp !== undefined && numerosResp.optouts === null,
    queryFn: () => whatsappConsentsBackendService.listOptedOut('all'),
  });
  const optouts = numerosResp?.optouts ?? (optoutsLista ? optoutsLista.length : null);

  // Nomes para escrever "Para Público X / Leads na etapa Y" nos cards.
  const { data: publicos = [] } = useQuery({
    queryKey: ['disparos', 'publicos'],
    queryFn: async (): Promise<{ id: string; name: string }[]> => {
      const res = await apiClient.get<{ id: string; name: string }[] | { data: { id: string; name: string }[] }>(API_ENDPOINTS.PROSPECTING.AUDIENCES);
      const l = Array.isArray(res) ? res : res?.data;
      return Array.isArray(l) ? l : [];
    },
  });
  const { data: todasTags = [] } = useQuery({
    queryKey: ['disparos', 'tags', accountId],
    enabled: !!accountId,
    queryFn: () => tagsBackendService.listAllTags(accountId),
  });
  const nomes = useMemo(() => ({
    publicos: Object.fromEntries(publicos.map((p) => [p.id, p.name])),
    etapas: Object.fromEntries(todasTags.filter((t) => t.type === 'stage').map((t) => [t.id, t.name])),
    tags: Object.fromEntries(todasTags.map((t) => [t.id, t.name])),
  }), [publicos, todasTags]);

  const acao = useMutation({
    mutationFn: ({ id, qual }: { id: string; qual: 'pausar' | 'retomar' | 'cancelar' }) => disparosService[qual](id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['disparos', 'lista'] }),
    onError: (e: Error) => toast({ title: 'Não foi possível concluir', description: e?.message, variant: 'destructive' }),
  });

  const reenviar = useMutation({
    mutationFn: (id: string) => disparosService.reenviarNaoRespondidos(id),
    onSuccess: (novo) => {
      toast({ title: 'Reenvio criado', description: novo.nome });
      qc.invalidateQueries({ queryKey: ['disparos', 'lista'] });
    },
    onError: (e: Error) => toast({ title: 'Não foi possível reenviar', description: e?.message, variant: 'destructive' }),
  });

  const abrirNovo = (opcoes?: { texto?: string }) => {
    setEditando(null);
    setPublicoInicial(null);
    setTextoInicial(opcoes?.texto ?? null);
    setDialogoAberto(true);
  };

  const emAndamento = lista?.emAndamento ?? [];
  const concluidos = lista?.concluidos ?? [];

  return (
    <div className="flex flex-col gap-5 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-[720px]">
          <h1 className="text-[26px] font-bold tracking-tight">Disparos</h1>
          <p className="mt-1.5 text-[13.5px] leading-normal text-muted-foreground">
            Mande uma mensagem para uma lista, pelo seu número, no ritmo certo para não ser bloqueado.
          </p>
        </div>
        <Button onClick={() => abrirNovo()}><Plus className="mr-2 h-4 w-4" />Novo disparo</Button>
      </header>

      <NumerosHoje numeros={numeros} carregando={carregandoNumeros} optouts={optouts} />

      <section className="grid grid-cols-1 items-start gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <div className="flex flex-col gap-3.5 rounded-xl border bg-card p-5">
            <h2 className="text-[15px] font-semibold">Em andamento e agendados</h2>
            {isLoading && <Skeleton className="h-32 w-full" />}
            {isError && <p className="text-sm text-destructive">Não foi possível carregar os disparos.</p>}
            {!isLoading && !isError && emAndamento.length === 0 && (
              <p className="text-[13px] text-muted-foreground">Nenhum disparo em andamento. Clique em "Novo disparo" para começar.</p>
            )}
            {emAndamento.map((d) => (
              <DisparoCard
                key={d.id}
                disparo={d}
                fuso={fuso}
                paraQuem={descreverLista(d, nomes)}
                numeros={nomesDosNumeros(d, numeros)}
                ocupado={acao.isPending}
                onPausar={() => acao.mutate({ id: d.id, qual: 'pausar' })}
                onRetomar={() => acao.mutate({ id: d.id, qual: 'retomar' })}
                onCancelar={() => setACancelar(d)}
                onEditar={() => { setEditando(d); setPublicoInicial(null); setTextoInicial(null); setDialogoAberto(true); }}
                onVer={() => setVerId(d.id)}
              />
            ))}
          </div>

          <div className="flex flex-col gap-3.5 rounded-xl border bg-card p-5">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-[15px] font-semibold">Concluídos</h2>
              <span className="text-[12.5px] text-muted-foreground">últimos 30 dias</span>
            </div>
            {!isLoading && concluidos.length === 0 && <p className="text-[13px] text-muted-foreground">Quando um disparo terminar, ele aparece aqui.</p>}
            {concluidos.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-[13.5px]">
                  <thead>
                    <tr className="text-left text-[11.5px] font-medium uppercase tracking-wider text-muted-foreground">
                      <th className="px-2.5 pb-2.5 font-medium">Disparo</th>
                      <th className="px-2.5 pb-2.5 font-medium">Para</th>
                      <th className="px-2.5 pb-2.5 text-right font-medium">Enviadas</th>
                      <th className="px-2.5 pb-2.5 text-right font-medium">Falhas</th>
                      <th className="px-2.5 pb-2.5 text-right font-medium">Responderam</th>
                      <th className="px-2.5 pb-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {concluidos.map((d) => (
                      <tr key={d.id} className="border-t align-middle">
                        <td className="px-2.5 py-3">
                          <div className="font-semibold">{d.nome}</div>
                          <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                            {formatarDia(d.concluidoEm ?? d.iniciadoEm, fuso)} · {nomesDosNumeros(d, numeros)}
                            {d.status === 'cancelado' && ' · cancelado'}
                          </div>
                        </td>
                        <td className="px-2.5 py-3">
                          <div>{descreverLista(d, nomes)}</div>
                          <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">{d.total} contatos</div>
                        </td>
                        <td className="px-2.5 py-3 text-right font-semibold tabular-nums">{d.enviadas}</td>
                        <td className="px-2.5 py-3 text-right tabular-nums">{d.falhas}</td>
                        <td className="px-2.5 py-3 text-right font-semibold tabular-nums text-success">
                          {d.respondidas} <span className="font-medium text-muted-foreground">· {percentual(d.respondidas, d.enviadas)}%</span>
                        </td>
                        <td className="whitespace-nowrap px-2.5 py-3 text-right text-[12.5px]">
                          <button type="button" className="text-primary hover:underline" onClick={() => setVerId(d.id)} aria-label={`Ver ${d.nome}`}>Ver</button>
                          {d.enviadas > d.respondidas && d.status === 'concluido' && (
                            <>
                              <span className="mx-1.5 text-border">·</span>
                              <button type="button" className="text-primary hover:underline disabled:opacity-50" disabled={reenviar.isPending} onClick={() => reenviar.mutate(d.id)}>
                                Reenviar a quem não respondeu
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <MensagensSalvas onUsar={(texto) => abrirNovo({ texto })} />
          <div className="flex flex-col gap-3 rounded-xl border bg-card p-5">
            <h2 className="text-[15px] font-semibold">O sistema cuida sozinho</h2>
            <ul className="flex flex-col gap-2.5 text-[13px] leading-snug">
              {REGRAS.map((r, i) => (
                <li key={i} className="flex gap-2.5">
                  <span aria-hidden="true" className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${r.alerta ? 'bg-warning' : 'bg-success'}`} />
                  <span>{r.texto}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <NovoDisparoDialog
        open={dialogoAberto}
        onOpenChange={setDialogoAberto}
        publicoInicial={publicoInicial}
        textoInicial={textoInicial}
        editando={editando}
      />
      <DetalheDisparoSheet disparoId={verId} onClose={() => setVerId(null)} />

      <AlertDialog open={!!aCancelar} onOpenChange={(o) => !o && setACancelar(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancelar "{aCancelar?.nome}"?</AlertDialogTitle>
            <AlertDialogDescription>As mensagens que ainda não saíram não serão enviadas. As que já foram continuam valendo.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Voltar</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (aCancelar) acao.mutate({ id: aCancelar.id, qual: 'cancelar' }); setACancelar(null); }}>
              Cancelar disparo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
