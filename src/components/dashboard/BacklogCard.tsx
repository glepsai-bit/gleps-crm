import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Inbox } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BacklogBuckets {
  ate15min: number;
  de15a60min: number;
  acima60min: number;
}

interface BacklogData extends BacklogBuckets {
  naoAtribuidas?: BacklogBuckets;
}

interface BacklogCardProps {
  data: BacklogData;
  isLoading?: boolean;
}

const BUCKETS = [
  {
    label: 'Até 15 min',
    dotClass: 'bg-success',
    atendidoKey: 'ate15min' as const,
    naoAtribuidoKey: 'ate15min' as const,
  },
  {
    label: '15 a 60 min',
    dotClass: 'bg-warning',
    atendidoKey: 'de15a60min' as const,
    naoAtribuidoKey: 'de15a60min' as const,
  },
  {
    label: 'Acima de 60 min',
    dotClass: 'bg-destructive',
    atendidoKey: 'acima60min' as const,
    naoAtribuidoKey: 'acima60min' as const,
  },
] as const;

export function BacklogCard({ data, isLoading = false }: BacklogCardProps) {
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-36" />
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  const nao = data.naoAtribuidas ?? { ate15min: 0, de15a60min: 0, acima60min: 0 };

  const grandTotal =
    data.ate15min + data.de15a60min + data.acima60min +
    nao.ate15min + nao.de15a60min + nao.acima60min;

  const isEmpty = grandTotal === 0;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Fila de Espera
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <div
            role="status"
            className="flex flex-col items-center justify-center py-8 gap-3 text-muted-foreground"
          >
            <Inbox className="w-8 h-8 opacity-40" />
            <p className="text-sm text-center">Fila vazia. Tudo em dia.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th
                    scope="col"
                    className="pb-2 text-left font-medium text-muted-foreground w-1/2"
                  >
                    Faixa
                  </th>
                  <th
                    scope="col"
                    className="pb-2 text-center font-medium text-muted-foreground px-2 xs:px-3"
                  >
                    <span className="hidden xs:inline">Atendido</span>
                    <span className="xs:hidden">Atend.</span>
                  </th>
                  <th
                    scope="col"
                    className="pb-2 text-center font-medium text-muted-foreground px-2 xs:px-3"
                  >
                    <span className="hidden xs:inline">Não atendido</span>
                    <span className="xs:hidden">Não atend.</span>
                  </th>
                  <th
                    scope="col"
                    className="pb-2 text-center font-semibold text-foreground px-2 xs:px-3"
                  >
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {BUCKETS.map((bucket) => {
                  const atendido = data[bucket.atendidoKey];
                  const naoAtendido = nao[bucket.naoAtribuidoKey];
                  const total = atendido + naoAtendido;
                  return (
                    <tr
                      key={bucket.label}
                      className={cn(
                        'border-b border-border/50 last:border-0',
                        'transition-colors hover:bg-muted/30',
                      )}
                    >
                      <td
                        scope="row"
                        className="py-3 pr-2 text-left"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              'inline-block w-2 h-2 rounded-full shrink-0',
                              bucket.dotClass,
                            )}
                            aria-hidden="true"
                          />
                          <span className="text-foreground text-xs sm:text-sm whitespace-nowrap">
                            {bucket.label}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 px-2 xs:px-3 text-center text-muted-foreground">
                        {atendido}
                      </td>
                      <td className="py-3 px-2 xs:px-3 text-center text-muted-foreground">
                        {naoAtendido}
                      </td>
                      <td className="py-3 px-2 xs:px-3 text-center font-semibold text-foreground">
                        {total}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
