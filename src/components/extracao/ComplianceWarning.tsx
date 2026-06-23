/**
 * ComplianceWarning — Sprint 3 T-022
 *
 * Banner de alerta (Alert do shadcn) que aparece no DispatchDialog
 * quando algum contato do lote possui opt-out de WhatsApp.
 *
 * Uso:
 *   <ComplianceWarning totalLote={leads.length} totalOptOut={3} />
 *
 * Se totalOptOut === 0, não renderiza nada.
 * Os contatos com opt-out serão automaticamente excluídos do disparo
 * pelo backend (este componente é apenas informativo).
 */

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ShieldAlert } from 'lucide-react';

interface ComplianceWarningProps {
  /** Total de contatos no lote selecionado para disparo. */
  totalLote: number;
  /** Número de contatos com opt-out identificados no lote. */
  totalOptOut: number;
}

export function ComplianceWarning({ totalLote, totalOptOut }: ComplianceWarningProps) {
  if (totalOptOut === 0) return null;

  const restante = totalLote - totalOptOut;

  return (
    <Alert className="border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200">
      <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-800 dark:text-amber-300">
        Atenção: contatos com opt-out no lote
      </AlertTitle>
      <AlertDescription className="text-amber-700 dark:text-amber-400 text-sm mt-1">
        <strong>{totalOptOut}</strong> contato{totalOptOut > 1 ? 's' : ''} com opt-out
        {totalOptOut > 1 ? ' serão automaticamente excluídos' : ' será automaticamente excluído'}{' '}
        do disparo.{' '}
        {restante > 0 ? (
          <>
            Apenas <strong>{restante}</strong> contato{restante > 1 ? 's' : ''} receberá{restante > 1 ? 'ão' : ''} as mensagens.
          </>
        ) : (
          <strong>Nenhum contato apto ao envio neste lote.</strong>
        )}
      </AlertDescription>
    </Alert>
  );
}
