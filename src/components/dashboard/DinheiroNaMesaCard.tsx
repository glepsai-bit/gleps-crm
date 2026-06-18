/**
 * DinheiroNaMesaCard — KPI de orcamentos pendentes (outcome vai_pensar) ultimos 30d (T-017)
 * Visivel apenas para role=admin.
 *
 * TODO server-side: backend deve rejeitar role != admin em GET /dashboard/dinheiro-mesa
 * adicionando middleware requireRole('admin') antes do handler.
 * (Ressalva Critic UX T-017 — handoff para Dev Principal)
 */

import { useQuery } from '@tanstack/react-query';
import { DollarSign } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { buscarDinheiroMesa } from '@/api/appointments';
import { useAuth } from '@/contexts/AuthContext';

const LABEL_OUTCOME: Record<string, string> = {
  fechou_tratamento: 'Fechou tratamento',
  vai_pensar: 'Vai pensar',
  sem_interesse: 'Sem interesse',
  pediu_retorno: 'Pediu retorno',
};

function formatarBRL(centavos: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(centavos / 100);
}

export function DinheiroNaMesaCard() {
  const { user } = useAuth();

  // So renderiza para admin
  if (!user || user.role !== 'admin') return null;

  return <DinheiroNaMesaCardInner />;
}

function DinheiroNaMesaCardInner() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dinheiro-mesa'],
    queryFn: () => buscarDinheiroMesa('30d'),
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: (failureCount, err: unknown) => {
      // Nao tentar novamente em 401/403 (defense in depth: backend nao autorizou)
      const status = (err as { status?: number })?.status;
      if (status === 401 || status === 403) return false;
      return failureCount < 2;
    },
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-40" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-full" />
        </CardContent>
      </Card>
    );
  }

  // Fallback silencioso para 401/403: nao quebra a UI (defense in depth)
  const status = (error as { status?: number } | null)?.status;
  if (error && (status === 401 || status === 403)) {
    return null;
  }

  const total = data?.totalCents ?? 0;
  const count = data?.count ?? 0;
  const breakdown = data?.breakdown ?? [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-warning/10">
            <DollarSign className="w-4 h-4 text-warning" aria-hidden="true" />
          </div>
          <div>
            <CardTitle className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
              Dinheiro na Mesa
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Orcamentos dos ultimos 30 dias
            </p>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {count === 0 ? (
          <p
            role="status"
            className="text-sm text-muted-foreground py-4 text-center"
          >
            Nenhum orcamento pendente nos ultimos 30 dias.
          </p>
        ) : (
          <>
            {/* KPI principal */}
            <div>
              <p className="text-3xl font-bold text-foreground tabular-nums">
                {formatarBRL(total)}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {count} consulta(s) com orcamento registrado
              </p>
            </div>

            {/* Breakdown por outcome */}
            {breakdown.length > 0 && (
              <div className="space-y-2">
                {breakdown.map((b) => (
                  <div
                    key={b.outcome}
                    className="flex items-center justify-between text-xs"
                  >
                    <span className="text-muted-foreground">
                      {LABEL_OUTCOME[b.outcome] ?? b.outcome} ({b.count})
                    </span>
                    <span className="font-medium text-foreground tabular-nums">
                      {formatarBRL(b.sumCents)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
