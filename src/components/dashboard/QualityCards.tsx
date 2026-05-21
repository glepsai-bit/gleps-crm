import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { MessageSquareOff, ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';

interface QualityData {
  conversasSemResposta: number;
  taxaAtendimentoVenda: string;
}

interface QualityCardsProps {
  data: QualityData;
  isLoading?: boolean;
}

export function QualityCards({ data, isLoading = false }: QualityCardsProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {[...Array(2)].map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <Skeleton className="h-16 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  const cards = [
    {
      title: 'Conversas Sem Resposta',
      subtitle: 'Atendimentos abertos sem resposta enviada',
      value: data.conversasSemResposta,
      icon: MessageSquareOff,
      color: 'text-destructive',
      bgColor: 'bg-destructive/10',
    },
    {
      title: 'Taxa Atendimento → Venda',
      subtitle: 'Conversas que geraram venda',
      value: data.taxaAtendimentoVenda,
      icon: ShoppingCart,
      color: 'text-primary',
      bgColor: 'bg-primary/10',
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          Qualidade & Conversão
        </h3>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {cards.map((card) => (
          <Card key={card.title} className="card-hover">
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="space-y-1 flex-1">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {card.title}
                  </p>
                  <p className="text-2xl font-bold">{card.value}</p>
                  <p className="text-xs text-muted-foreground line-clamp-2">
                    {card.subtitle}
                  </p>
                </div>
                <div className={cn('p-2.5 rounded-lg shrink-0', card.bgColor)}>
                  <card.icon className={cn('w-5 h-5', card.color)} />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}