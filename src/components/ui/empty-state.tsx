import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}

/**
 * Empty state reutilizavel padronizado para listas/tabelas vazias.
 *
 * Padroes esperados:
 *  - icon: lucide-react com tamanho w-10 h-10 (idealmente)
 *  - title: frase curta (3-6 palavras) explicando o estado
 *  - description: 1 linha contextual (opcional)
 *  - action: <Button /> chamada para acao primaria (opcional)
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center py-12 px-4 text-center',
        className,
      )}
    >
      {icon && (
        <div className="text-muted-foreground mb-4 opacity-50">{icon}</div>
      )}
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      {description && (
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          {description}
        </p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
