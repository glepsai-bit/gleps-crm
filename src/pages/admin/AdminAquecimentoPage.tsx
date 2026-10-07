import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useToast } from '@/hooks/use-toast';
import { aquecimentoBackendService, type NumeroAquecimento } from '@/services/aquecimento.backend.service';
import { FaixaSituacao } from '@/components/aquecimento/FaixaSituacao';
import { AvisoInfra } from '@/components/aquecimento/AvisoInfra';
import { TabelaNumeros } from '@/components/aquecimento/TabelaNumeros';
import { ComoFunciona } from '@/components/aquecimento/ComoFunciona';
import { GraficoRampa } from '@/components/aquecimento/GraficoRampa';
import { AquecerNumeroDialog } from '@/components/aquecimento/AquecerNumeroDialog';
import { HistoricoSheet } from '@/components/aquecimento/HistoricoSheet';

const CHAVE = ['aquecimento'] as const;
const REFETCH_MS = 30_000;

function mensagemDoErro(e: unknown, padrao: string): string {
  return e instanceof Error && e.message ? e.message : padrao;
}

export default function AdminAquecimentoPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dialogAberto, setDialogAberto] = useState(false);
  const [aRemover, setARemover] = useState<NumeroAquecimento | null>(null);
  const [historicoDe, setHistoricoDe] = useState<NumeroAquecimento | null>(null);
  const [ocupadoId, setOcupadoId] = useState<string | null>(null);

  const lista = useQuery({ queryKey: CHAVE, queryFn: aquecimentoBackendService.listar, refetchInterval: REFETCH_MS });
  const disponiveis = useQuery({
    queryKey: [...CHAVE, 'inboxes-disponiveis'],
    queryFn: aquecimentoBackendService.inboxesDisponiveis,
    enabled: dialogAberto,
  });
  const historico = useQuery({
    queryKey: [...CHAVE, 'historico', historicoDe?.id],
    queryFn: () => aquecimentoBackendService.historico(historicoDe!.id),
    enabled: !!historicoDe,
  });

  const numeros = lista.data?.numeros ?? [];

  const adicionar = useMutation({
    mutationFn: (inboxId: string) => aquecimentoBackendService.adicionar(inboxId),
    onSuccess: () => {
      toast({ title: 'Número em aquecimento', description: 'Ele começa a conversar assim que houver outro número aquecendo.' });
      setDialogAberto(false);
      qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: (e) => toast({ title: 'Não foi possível aquecer o número', description: mensagemDoErro(e, 'Tente novamente.'), variant: 'destructive' }),
  });

  const acao = useMutation({
    mutationFn: async ({ tipo, n }: { tipo: 'pausar' | 'retomar' | 'remover'; n: NumeroAquecimento }) => {
      setOcupadoId(n.id);
      await aquecimentoBackendService[tipo](n.id);
      return tipo;
    },
    onSuccess: (tipo) => {
      toast({ title: tipo === 'pausar' ? 'Número pausado' : tipo === 'retomar' ? 'Número retomado' : 'Número fora do aquecimento' });
      qc.invalidateQueries({ queryKey: CHAVE });
    },
    onError: (e) => toast({ title: 'Não foi possível concluir', description: mensagemDoErro(e, 'Tente novamente.'), variant: 'destructive' }),
    onSettled: () => { setOcupadoId(null); setARemover(null); },
  });

  return (
    <div className="flex flex-col gap-5 p-4 md:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-[720px]">
          <h1 className="text-2xl font-bold tracking-tight text-foreground">Aquecimento</h1>
          <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground">
            Seus números conversam entre si todos os dias para ganhar reputação antes de disparar.
          </p>
        </div>
        <Button onClick={() => setDialogAberto(true)}><Plus className="h-4 w-4" />Aquecer um número</Button>
      </header>

      <FaixaSituacao data={lista.data} carregando={lista.isLoading} />
      <AvisoInfra infraPausaAte={lista.data?.agora.infraPausaAte} />

      <TabelaNumeros
        numeros={numeros}
        carregando={lista.isLoading}
        ocupadoId={ocupadoId}
        onAdicionar={() => setDialogAberto(true)}
        onAbrir={setHistoricoDe}
        onPausar={(n) => acao.mutate({ tipo: 'pausar', n })}
        onRetomar={(n) => acao.mutate({ tipo: 'retomar', n })}
        onRemover={setARemover}
      />

      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ComoFunciona />
        <GraficoRampa />
      </section>

      <AquecerNumeroDialog
        open={dialogAberto}
        onOpenChange={setDialogAberto}
        inboxes={disponiveis.data ?? []}
        jaAquecendo={numeros.length}
        enviando={adicionar.isPending}
        onConfirmar={(id) => adicionar.mutate(id)}
      />

      <HistoricoSheet numero={historicoDe} dados={historico.data} carregando={historico.isLoading} onClose={() => setHistoricoDe(null)} />

      <AlertDialog open={!!aRemover} onOpenChange={(v) => { if (!v) setARemover(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tirar {aRemover?.inboxNome} do aquecimento?</AlertDialogTitle>
            <AlertDialogDescription>
              O número para de conversar com os outros e perde o progresso de {aquecimentoDias(aRemover)}. Se voltar, começa do dia 1.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={() => aRemover && acao.mutate({ tipo: 'remover', n: aRemover })}>Tirar do aquecimento</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function aquecimentoDias(n: NumeroAquecimento | null): string {
  if (!n) return 'aquecimento';
  return n.status === 'pronto' ? '30 dias' : `${n.dia} ${n.dia === 1 ? 'dia' : 'dias'}`;
}
