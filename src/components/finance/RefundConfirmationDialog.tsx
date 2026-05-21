import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, Loader2 } from 'lucide-react';

interface RefundConfirmationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saleValue: number;
  onConfirm: (reason: string, password: string) => void | Promise<void>;
}

export function RefundConfirmationDialog({
  open,
  onOpenChange,
  saleValue,
  onConfirm,
}: RefundConfirmationDialogProps) {
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    }).format(value);
  };

  const handleConfirm = async () => {
    if (!reason.trim()) {
      setError('Informe o motivo do estorno');
      return;
    }
    if (!password.trim()) {
      setError('Informe sua senha para confirmar');
      return;
    }

    setIsSubmitting(true);
    setError('');
    try {
      await onConfirm(reason, password);
      handleClose();
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || 'Erro ao processar estorno';
      setError(msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    setReason('');
    setPassword('');
    setError('');
    setIsSubmitting(false);
    onOpenChange(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleClose}>
      <AlertDialogContent className="sm:max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="w-5 h-5" />
            Confirmar Estorno
          </AlertDialogTitle>
          <AlertDialogDescription>
            Você está prestes a estornar uma venda de{' '}
            <strong className="text-foreground">{formatCurrency(saleValue)}</strong>.
            Esta ação não pode ser desfeita.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4 py-4">
          <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20">
            <p className="text-sm text-destructive font-medium">
              Atenção: o valor será devolvido e a venda marcada como estornada.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="refund-reason">Motivo do estorno</Label>
            <Textarea
              id="refund-reason"
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError('');
              }}
              placeholder="Descreva o motivo do estorno..."
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="refund-password">Senha de confirmação</Label>
            <Input
              id="refund-password"
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError('');
              }}
              placeholder="Digite sua senha..."
            />
          </div>

          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleClose} disabled={isSubmitting}>
            Cancelar
          </AlertDialogCancel>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!reason.trim() || !password.trim() || isSubmitting}
            className="inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 bg-destructive text-destructive-foreground hover:bg-destructive/90 h-10 px-4 py-2"
          >
            {isSubmitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Processando...
              </>
            ) : (
              'Confirmar Estorno'
            )}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
