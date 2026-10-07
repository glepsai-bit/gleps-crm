/**
 * AdminChatDashboardPage — Dashboard de atendimento (layout de 06/10/2026).
 *
 * Fonte: chatMetricsBackendService.getChatMetrics (uma chamada agrega tudo) +
 * live-attendance (snapshot "agora") + returning-leads (modal). Filtros
 * (período + inbox + time + agente) reenviam a query via TanStack Query.
 *
 * A página só orquestra estado/queries; cada bloco visual vive em
 * src/components/dashboard/. Campos novos do backend (anterior, reunioes,
 * transferidasParaHumano, origem, fechamento.*, esperandoHaMais5Min) são
 * opcionais: sem eles o bloco some ou mostra "—".
 *
 * Volume por dia (FIX BUG-3): o backend devolve `dailyVolume[]` (bucket UTC).
 * Mantemos o fallback (pagina listConversations e agrupa client-side) só para
 * deploys antigos sem o campo.
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/contexts/AuthContext';
import { chatSocket } from '@/services/socket.client';
import {
  chatMetricsBackendService,
  type ChatMetricsFilters,
  type ChatMetricsResult,
  type LiveAttendanceResult,
  type ReturningLeadsCountResult,
  type ReturningLeadsListResult,
} from '@/services/chat-metrics.backend.service';
import {
  conversationsBackendService,
  type Conversation,
  type ListConversationsFilters,
} from '@/services/conversations.backend.service';
import { inboxesBackendService } from '@/services/inboxes.backend.service';
import { teamsBackendService } from '@/services/teams.backend.service';
import { usersBackendService } from '@/services/users.backend.service';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Repeat, Loader2 } from 'lucide-react';
import { startOfDay, endOfDay, subDays, format, eachDayOfInterval, differenceInDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { DateRange } from 'react-day-picker';
import {
  CabecalhoDashboard,
  FaixaAgora,
  Indicador,
  ConversasPorDia,
  QuemResolveu,
  FunilFechamento,
  TabelaEquipe,
  Canais,
  type PeriodoOpcao,
} from '@/components/dashboard';
import {
  formatMin,
  formatNumero,
  formatPct,
  pct,
  variacaoContagem,
  variacaoTempo,
} from '@/components/dashboard/dashboardFormat';

export default function AdminChatDashboardPage() {
  const { account } = useAuth();
  const queryClient = useQueryClient();

  const [period, setPeriod] = useState<PeriodoOpcao>('30d');
  const [dateRange, setDateRange] = useState<DateRange>({
    from: subDays(new Date(), 30),
    to: new Date(),
  });
  const [inboxId, setInboxId] = useState<string>('all');
  const [teamId, setTeamId] = useState<string>('all');
  const [agentId, setAgentId] = useState<string>('all');

  // T-022 — drill-down "Retornos no período"
  const [returningModalOpen, setReturningModalOpen] = useState(false);

  // T-022 — filtro especial "somente humanos atendendo" (vem da faixa Agora).
  const [humanOnlyFilter, setHumanOnlyFilter] = useState(false);

  // Relógio leve para o "atualizado há Xs" do cabeçalho.
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // ---- Filtros derivados ----
  const effectiveRange = useMemo(() => {
    const today = new Date();
    if (period === '7d') return { from: subDays(today, 7), to: today };
    if (period === '30d') return { from: subDays(today, 30), to: today };
    return {
      from: dateRange.from ?? subDays(today, 30),
      to: dateRange.to ?? today,
    };
  }, [period, dateRange]);

  const filters: ChatMetricsFilters = useMemo(
    () => ({
      fromDate: startOfDay(effectiveRange.from).toISOString(),
      toDate: endOfDay(effectiveRange.to).toISOString(),
      inboxId: inboxId !== 'all' ? inboxId : undefined,
      teamId: teamId !== 'all' ? teamId : undefined,
      agentId: agentId !== 'all' ? agentId : undefined,
    }),
    [effectiveRange, inboxId, teamId, agentId]
  );

  // ---- Queries auxiliares para popular filtros ----
  const inboxesQuery = useQuery({
    queryKey: ['inboxes', account?.id],
    queryFn: () => inboxesBackendService.listInboxes(),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 60 * 5,
  });

  const teamsQuery = useQuery({
    queryKey: ['teams', account?.id],
    queryFn: () => teamsBackendService.listTeams(),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 60 * 5,
  });

  const usersQuery = useQuery({
    queryKey: ['users', account?.id],
    queryFn: () => usersBackendService.list(account?.id),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 60 * 5,
  });

  // ---- Query principal de métricas ----
  // refetchInterval 60s mantém o dashboard vivo sem depender de socket.
  const metricsQuery = useQuery<ChatMetricsResult>({
    queryKey: ['chat-metrics', filters],
    queryFn: () => chatMetricsBackendService.getChatMetrics(filters),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
    refetchOnWindowFocus: true,
  });

  const metrics = metricsQuery.data;
  const isLoading = metricsQuery.isLoading;

  // ---- T-022 — Retornos no período ----
  const returningLeadsQuery = useQuery<ReturningLeadsCountResult>({
    queryKey: ['chat-metrics', 'returning-leads', filters],
    queryFn: () => chatMetricsBackendService.getReturningLeadsCount(filters),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 30,
    refetchInterval: 1000 * 60,
  });

  // ---- T-022 — Atendimento ao vivo (IA / Humano / Em aberto) ----
  const liveAttendanceQuery = useQuery<LiveAttendanceResult>({
    queryKey: ['chat-metrics', 'live-attendance'],
    queryFn: () => chatMetricsBackendService.getLiveAttendance(),
    enabled: Boolean(account?.id),
    staleTime: 1000 * 5,
    refetchInterval: 1000 * 15,
    refetchOnWindowFocus: true,
  });

  // Socket conversation:updated invalida o snapshot ao vivo.
  useEffect(() => {
    if (!account?.id) return;
    const unsub = chatSocket.onConversationUpdated(() => {
      queryClient.invalidateQueries({
        queryKey: ['chat-metrics', 'live-attendance'],
      });
    });
    return () => {
      unsub();
    };
  }, [account?.id, queryClient]);

  // ---- T-022 — Lista paginada de leads retornados (modal) ----
  const returningListQuery = useQuery<ReturningLeadsListResult>({
    queryKey: ['chat-metrics', 'returning-leads', 'list', filters],
    queryFn: () => chatMetricsBackendService.getReturningLeadsList(filters, 1, 50),
    enabled: Boolean(account?.id) && returningModalOpen,
    staleTime: 1000 * 30,
  });

  // ---- Dados derivados ----
  const periodDays = useMemo(
    () => Math.max(differenceInDays(effectiveRange.to, effectiveRange.from) + 1, 1),
    [effectiveRange]
  );

  // FIX BUG-3: prioriza `dailyVolume` do backend; fallback só em deploy antigo.
  const hasBackendDaily = Boolean(metrics?.dailyVolume && metrics.dailyVolume.length > 0);

  const dailyConversationsQuery = useQuery<Conversation[]>({
    queryKey: [
      'chat-metrics',
      'daily-conversations',
      filters.inboxId ?? null,
      filters.teamId ?? null,
      filters.agentId ?? null,
      filters.fromDate ?? null,
      filters.toDate ?? null,
    ],
    queryFn: async () => {
      const baseFilters: ListConversationsFilters = {
        inboxId: filters.inboxId,
        teamId: filters.teamId,
        assigneeId: filters.agentId,
      };
      const PAGE = 200;
      const MAX_PAGES = 5;
      const collected: Conversation[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data, total } = await conversationsBackendService.listConversations({
          ...baseFilters,
          limit: PAGE,
          offset: page * PAGE,
        });
        collected.push(...data);
        if (collected.length >= total || data.length < PAGE) break;
      }
      return collected;
    },
    enabled: Boolean(account?.id) && metricsQuery.isFetched && !hasBackendDaily,
    staleTime: 1000 * 30,
  });

  const dailyVolumeData = useMemo(() => {
    const days = eachDayOfInterval({ start: effectiveRange.from, end: effectiveRange.to });

    if (hasBackendDaily && metrics?.dailyVolume) {
      const byKey = new Map(metrics.dailyVolume.map((b) => [b.date, b]));
      return days.map((d) => {
        const chave = format(d, 'yyyy-MM-dd');
        const bucket = byKey.get(chave);
        return {
          chave,
          date: format(d, 'dd/MM'),
          total: bucket?.total ?? 0,
          resolvidas: bucket?.resolved ?? 0,
        };
      });
    }

    // Fallback: agrupar conversations no cliente (deploy antigo do BE).
    const fromMs = startOfDay(effectiveRange.from).getTime();
    const toMs = endOfDay(effectiveRange.to).getTime();
    const buckets = new Map<string, { total: number; resolvidas: number }>();
    for (const d of days) buckets.set(format(d, 'yyyy-MM-dd'), { total: 0, resolvidas: 0 });

    for (const c of dailyConversationsQuery.data ?? []) {
      const createdMs = new Date(c.createdAt).getTime();
      if (createdMs < fromMs || createdMs > toMs) continue;
      const bucket = buckets.get(format(new Date(c.createdAt), 'yyyy-MM-dd'));
      if (!bucket) continue;
      bucket.total += 1;
      if (c.status === 'resolved') bucket.resolvidas += 1;
    }

    return days.map((d) => {
      const chave = format(d, 'yyyy-MM-dd');
      const bucket = buckets.get(chave)!;
      return { chave, date: format(d, 'dd/MM'), total: bucket.total, resolvidas: bucket.resolvidas };
    });
  }, [hasBackendDaily, metrics?.dailyVolume, dailyConversationsQuery.data, effectiveRange]);

  const isDailyLoading =
    metricsQuery.isLoading || (!hasBackendDaily && dailyConversationsQuery.isLoading);

  // Série diária de reuniões (preenche zeros nos dias sem evento).
  const reunioesSerie = useMemo(() => {
    const porDia = metrics?.reunioes?.porDia;
    if (!porDia) return undefined;
    const byKey = new Map(porDia.map((b) => [b.date, b.total]));
    return dailyVolumeData.map((d) => byKey.get(d.chave) ?? 0);
  }, [metrics?.reunioes?.porDia, dailyVolumeData]);

  // Rótulo "vs. N dias antes": presets falam 7/30 (a janela inclui o dia de hoje).
  const diasRotulo = period === '7d' ? 7 : period === '30d' ? 30 : periodDays;

  const atualizadoHa = metricsQuery.dataUpdatedAt
    ? Math.max(0, (agora - metricsQuery.dataUpdatedAt) / 1000)
    : null;

  const taxaResolucao = metrics ? pct(metrics.resolvedConversations, metrics.totalConversations) : 0;
  const anterior = metrics?.anterior;
  const returningCount = returningLeadsQuery.data?.count;

  const rotuloGrafico = `${format(effectiveRange.from, "d 'de' MMMM", { locale: ptBR })} a ${format(effectiveRange.to, "d 'de' MMMM", { locale: ptBR })}`;

  if (!account?.id) {
    return (
      <div className="flex items-center justify-center h-[50vh] text-muted-foreground">
        Carregando conta...
      </div>
    );
  }

  return (
    <div className="page-container space-y-5">
      <CabecalhoDashboard
        periodo={period}
        onPeriodo={(p) => {
          setPeriod(p);
          const today = new Date();
          if (p === '7d') setDateRange({ from: subDays(today, 7), to: today });
          else if (p === '30d') setDateRange({ from: subDays(today, 30), to: today });
        }}
        intervalo={dateRange}
        onIntervalo={setDateRange}
        de={effectiveRange.from}
        ate={effectiveRange.to}
        atualizadoHaSegundos={atualizadoHa}
        inboxId={inboxId}
        onInbox={setInboxId}
        inboxes={(inboxesQuery.data ?? []).map((i) => ({ id: i.id, nome: i.name }))}
        teamId={teamId}
        onTeam={setTeamId}
        times={(teamsQuery.data ?? []).map((t) => ({ id: t.id, nome: t.name }))}
        agentId={agentId}
        onAgent={setAgentId}
        agentes={(usersQuery.data ?? []).map((u) => ({ id: u.user_id, nome: u.nome || u.email }))}
      />

      <FaixaAgora
        data={liveAttendanceQuery.data}
        carregando={liveAttendanceQuery.isLoading}
        humanOnlyActive={humanOnlyFilter}
        onFilterHumans={() => setHumanOnlyFilter((v) => !v)}
      />

      <section
        aria-label="Indicadores do período"
        className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3"
      >
        <Indicador
          label="Conversas"
          valor={formatNumero(metrics?.totalConversations ?? 0)}
          carregando={isLoading}
          serie={dailyVolumeData.map((d) => d.total)}
          corSerie="var(--primary)"
          variacao={variacaoContagem(metrics?.totalConversations, anterior?.totalConversations, diasRotulo)}
        />
        <Indicador
          label="Resolvidas"
          valor={formatNumero(metrics?.resolvedConversations ?? 0)}
          carregando={isLoading}
          serie={dailyVolumeData.map((d) => d.resolvidas)}
          corSerie="var(--success)"
          variacao={variacaoContagem(metrics?.resolvedConversations, anterior?.resolvedConversations, diasRotulo)}
          subtitulo={
            metrics ? (
              <>
                <span className="font-semibold text-foreground">{formatPct(taxaResolucao)}</span> das conversas
              </>
            ) : undefined
          }
        />
        <Indicador
          label="1ª resposta"
          valor={formatMin(metrics?.avgFirstResponseMin)}
          carregando={isLoading}
          variacao={variacaoTempo(metrics?.avgFirstResponseMin, anterior?.avgFirstResponseMin)}
          subtitulo="Tempo médio"
        />
        <Indicador
          label="Resolução"
          valor={formatMin(metrics?.avgResolutionMin)}
          carregando={isLoading}
          variacao={variacaoTempo(metrics?.avgResolutionMin, anterior?.avgResolutionMin)}
          subtitulo="Tempo médio"
        />
        <Indicador
          label="Reuniões marcadas"
          valor={metrics?.reunioes ? formatNumero(metrics.reunioes.total) : '—'}
          carregando={isLoading}
          serie={reunioesSerie}
          corSerie="var(--primary)"
          variacao={variacaoContagem(metrics?.reunioes?.total, anterior?.reunioes, diasRotulo)}
          detalhe={
            metrics?.reunioes ? (
              <>
                <span className="font-semibold text-foreground">{formatNumero(metrics.reunioes.peloAgente)}</span> pelo agente de IA
              </>
            ) : undefined
          }
        />
        <Indicador
          label="Leads que voltaram"
          valor={formatNumero(returningCount ?? 0)}
          carregando={returningLeadsQuery.isLoading}
          onClick={() => setReturningModalOpen(true)}
          subtitulo={
            returningCount === 0 ? (
              'Nenhum retorno no período'
            ) : (
              <span className="font-medium text-primary">Ver quem voltou →</span>
            )
          }
        />
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <ConversasPorDia dados={dailyVolumeData} carregando={isDailyLoading} rotuloPeriodo={rotuloGrafico} />
        <QuemResolveu
          resolvidasIa={metrics?.resolvedByAi ?? 0}
          resolvidasHumano={metrics?.resolvedByHuman ?? 0}
          carregando={isLoading}
          transferidas={metrics?.transferidasParaHumano}
        />
      </section>

      {metrics?.fechamento && <FunilFechamento fechamento={metrics.fechamento} />}

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <TabelaEquipe
          agentes={metrics?.byAgent ?? []}
          resolvidasIa={metrics?.resolvedByAi ?? 0}
          agenteSelecionado={agentId}
          onSelecionar={(id) => setAgentId((cur) => (cur === id ? 'all' : id))}
          onLimpar={() => setAgentId('all')}
          carregando={isLoading}
        />
        <Canais
          porInbox={metrics?.byInbox ?? []}
          porTime={metrics?.byTeam ?? []}
          origem={metrics?.origem}
          carregando={isLoading}
        />
      </section>

      {/* T-022 — Drill-down modal: leads que retornaram no período */}
      <Dialog open={returningModalOpen} onOpenChange={setReturningModalOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Repeat className="w-4 h-4 text-warning" />
              Leads que retornaram no período
            </DialogTitle>
            <DialogDescription>
              Contatos com ao menos 1 reabertura ({'>='} 2 ciclos) na janela
              selecionada.
            </DialogDescription>
          </DialogHeader>
          {returningListQuery.isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin mr-2" />
              Carregando...
            </div>
          ) : !returningListQuery.data ||
            returningListQuery.data.data.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">
              Nenhum lead retornou no período selecionado.
            </p>
          ) : (
            <ScrollArea className="max-h-[60vh]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contato</TableHead>
                    <TableHead>Telefone</TableHead>
                    <TableHead className="text-center">Retornos</TableHead>
                    <TableHead>Último retorno</TableHead>
                    <TableHead>Inbox</TableHead>
                    <TableHead>Agente atual</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {returningListQuery.data.data.map((item) => (
                    <TableRow key={item.contactId}>
                      <TableCell className="font-medium">
                        {item.contactName ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.contactPhone ?? '—'}
                      </TableCell>
                      <TableCell className="text-center">
                        <Badge variant="secondary">{item.cyclesCount}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.lastReopenAt
                          ? format(new Date(item.lastReopenAt), 'dd/MM/yy HH:mm', {
                              locale: ptBR,
                            })
                          : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.inboxName ?? '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {item.assigneeName ?? (
                          <span className="italic">Não atribuído</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
