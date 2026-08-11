/**
 * CONGRUÊNCIA CRM × META.
 *
 * O funil mostra o que aconteceu no CRM; `delivery` mostra o que a Meta
 * confirmou ter recebido. A diferença entre os dois é o que o gerenciador de
 * anúncios NÃO está enxergando — e é isso que a reconciliação corrige.
 *
 * Reenvio é ação de fora pra fora (mexe na otimização das campanhas do
 * usuário), então nunca é automático: exige confirmação explícita.
 */
import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Send,
} from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import type {
  TrackingFunnel,
  TrackingReconcileReport,
} from '@/services/tracking.backend.service';
import { int } from './format';

interface Props {
  funnel: TrackingFunnel | undefined;
  report: TrackingReconcileReport | null;
  verified: boolean;
  verifying: boolean;
  reconciling: boolean;
  lastRun: TrackingReconcileReport | null;
  onVerify: () => void;
  onReconcile: () => void;
}

const EVENT_LABEL: Record<string, string> = {
  Lead: 'Conversas (Lead)',
  Schedule: 'Reuniões (Schedule)',
  Purchase: 'Vendas (Purchase)',
};

export function TrackingValidationCard({
  funnel,
  report,
  verified,
  verifying,
  reconciling,
  lastRun,
  onVerify,
  onReconcile,
}: Props) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  const delivery = funnel?.delivery ?? [];
  const totalFailed = delivery.reduce((a, d) => a + d.failed, 0);
  const totalPending = delivery.reduce((a, d) => a + d.pending, 0);
  const totalSent = delivery.reduce((a, d) => a + d.sent, 0);

  // O que o CRM registrou no período, para comparar com o que a Meta recebeu.
  const crmSide: Record<string, number> = {
    Lead: funnel?.totals.ctwaConversations ?? 0,
    Schedule: funnel?.totals.meetings ?? 0,
    Purchase: funnel?.totals.purchases ?? 0,
  };

  const gaps = report?.gaps.total ?? 0;
  const recoverable = report?.recoverable ?? 0;
  const outOfWindow = report?.outOfWindow ?? 0;
  // totalPending entra aqui: são eventos criados que nunca tiveram confirmação
  // da Meta (processo morreu no meio do envio). O texto mais abaixo diz que
  // "rodar o envio resolve" — sem isto o botão ficaria desabilitado e a
  // promessa não teria como ser cumprida.
  const needsAction = recoverable > 0 || totalFailed > 0 || totalPending > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-base">Validação — CRM × Meta</CardTitle>
            <CardDescription>
              Compara o que aconteceu no CRM com o que o gerenciador de anúncios
              realmente recebeu.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onVerify} disabled={verifying}>
              {verifying ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 mr-1" />
              )}
              Validar agora
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirmOpen(true)}
              disabled={reconciling || !needsAction}
            >
              {reconciling ? (
                <Loader2 className="w-4 h-4 mr-1 animate-spin" />
              ) : (
                <Send className="w-4 h-4 mr-1" />
              )}
              Enviar à Meta
              {recoverable + totalFailed + totalPending > 0 &&
                ` (${recoverable + totalFailed + totalPending})`}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Comparativo por evento */}
        <div className="grid gap-2 sm:grid-cols-3">
          {(['Lead', 'Schedule', 'Purchase'] as const).map((name) => {
            const d = delivery.find((x) => x.eventName === name);
            const crm = crmSide[name];
            const sent = d?.sent ?? 0;
            const match = crm === sent;
            return (
              <div
                key={name}
                className={cn(
                  'rounded-md border p-3',
                  match ? 'border-border' : 'border-amber-500/40 bg-amber-500/5'
                )}
              >
                <p className="text-xs text-muted-foreground">{EVENT_LABEL[name]}</p>
                <div className="flex items-baseline gap-2 mt-1">
                  <span className="text-xl font-bold">{int(sent)}</span>
                  <span className="text-xs text-muted-foreground">
                    de {int(crm)} no CRM
                  </span>
                  {match ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 ml-auto shrink-0" />
                  ) : (
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 ml-auto shrink-0" />
                  )}
                </div>
                <div className="flex gap-2 mt-2 flex-wrap">
                  {(d?.failed ?? 0) > 0 && (
                    <Badge variant="outline" className="text-destructive border-destructive text-[10px]">
                      {d!.failed} falha{d!.failed > 1 ? 's' : ''}
                    </Badge>
                  )}
                  {(d?.pending ?? 0) > 0 && (
                    <Badge variant="outline" className="text-[10px]">
                      {d!.pending} pendente
                    </Badge>
                  )}
                  {(d?.skipped ?? 0) > 0 && (
                    <Badge variant="outline" className="text-[10px]">
                      {d!.skipped} fora do prazo
                    </Badge>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Veredito */}
        {!verified && (
          <p className="text-sm text-muted-foreground">
            Clique em <strong>Validar agora</strong> para conferir a conexão e medir a
            diferença. Essa checagem não envia nada.
          </p>
        )}

        {verified && gaps === 0 && totalFailed === 0 && totalPending === 0 && (
          <Alert className="border-emerald-600/40 bg-emerald-600/5">
            <CheckCircle2 className="h-4 w-4 !text-emerald-600" />
            <AlertTitle>Tudo congruente</AlertTitle>
            <AlertDescription>
              Todos os {int(totalSent)} eventos do período chegaram à Meta. Nenhum dado
              ficou pra trás.
            </AlertDescription>
          </Alert>
        )}

        {verified && recoverable > 0 && (
          <Alert className="border-amber-500/40 bg-amber-500/5">
            <AlertTriangle className="h-4 w-4 !text-amber-500" />
            <AlertTitle>
              {int(recoverable)} evento(s) do CRM não chegaram ao gerenciador
            </AlertTitle>
            <AlertDescription className="space-y-1">
              <p>
                {report?.gaps.Lead ? `${report.gaps.Lead} conversa(s) · ` : ''}
                {report?.gaps.Schedule ? `${report.gaps.Schedule} reunião(ões) · ` : ''}
                {report?.gaps.Purchase ? `${report.gaps.Purchase} venda(s)` : ''}
              </p>
              <p>
                Use <strong>Enviar à Meta</strong> para reprocessar. O envio usa um
                identificador estável por evento, então a Meta não conta nada em dobro.
              </p>
            </AlertDescription>
          </Alert>
        )}

        {verified && outOfWindow > 0 && (
          <Alert>
            <Clock className="h-4 w-4" />
            <AlertTitle>{int(outOfWindow)} evento(s) fora do prazo da Meta</AlertTitle>
            <AlertDescription>
              A Conversions API só aceita eventos dos <strong>últimos 7 dias</strong>.
              Esses fatos são anteriores a isso e não têm como ser recuperados — ficam
              registrados como “fora do prazo” para auditoria. Daqui pra frente eles são
              enviados na hora em que acontecem.
            </AlertDescription>
          </Alert>
        )}

        {totalPending > 0 && (
          <p className="text-xs text-muted-foreground">
            {int(totalPending)} evento(s) em <strong>pendente</strong>: criados mas sem
            confirmação da Meta. Rodar o envio resolve.
          </p>
        )}

        {/* Resultado da última execução */}
        {lastRun && !lastRun.dryRun && (
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            <p className="font-medium mb-1">Última reconciliação</p>
            <p className="text-muted-foreground">
              {int(lastRun.sent)} enviado(s) · {int(lastRun.failed)} falha(s) ·{' '}
              {int(lastRun.skipped)} fora do prazo
              {lastRun.retriedFailed > 0 &&
                ` · ${lastRun.retriedOk}/${lastRun.retriedFailed} reenvio(s) recuperado(s)`}
            </p>
            {lastRun.capped && (
              <p className="text-xs text-amber-600 mt-1">
                O lote foi limitado por execução. Rode novamente para processar o restante.
              </p>
            )}
          </div>
        )}
      </CardContent>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Enviar eventos à Meta?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                <p>
                  Vão ser enviados <strong>{int(recoverable)}</strong> evento(s) que
                  faltavam
                  {totalFailed > 0 && (
                    <>
                      {' '}
                      e reprocessadas <strong>{int(totalFailed)}</strong> falha(s)
                    </>
                  )}
                  .
                </p>
                <p>
                  Isso altera os dados do seu gerenciador de anúncios e pode influenciar a
                  otimização das campanhas. A ação não tem desfazer.
                </p>
                {outOfWindow > 0 && (
                  <p>
                    {int(outOfWindow)} evento(s) com mais de 7 dias serão apenas marcados
                    como fora do prazo — a Meta não os aceita.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false);
                onReconcile();
              }}
            >
              Enviar agora
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
