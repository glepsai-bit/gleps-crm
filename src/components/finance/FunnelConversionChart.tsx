import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { useFinance } from '@/contexts/FinanceContext';
import { useTagContext } from '@/contexts/TagContext';
import { ArrowRight, Users, ShoppingCart, CheckCircle, Settings2 } from 'lucide-react';

interface FunnelConversionChartProps {
  isLoading?: boolean;
}

export function FunnelConversionChart({ isLoading = false }: FunnelConversionChartProps) {
  const { kpis } = useFinance();
  const { stageTags, finalStageIds, toggleFinalStage } = useTagContext();
  const [activePopover, setActivePopover] = useState<number | null>(null);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[120px] w-full" />
        </CardContent>
      </Card>
    );
  }

  const steps = [
    {
      id: 0,
      label: 'Leads Convertidos',
      value: kpis.leadsConvertidos,
      icon: Users,
      color: 'text-primary',
      bgColor: 'bg-primary/10',
      description: 'Leads em etapas finais do funil',
      configurable: true,
    },
    {
      id: 1,
      label: 'Vendas Criadas',
      value: kpis.vendasCriadas,
      icon: ShoppingCart,
      color: 'text-warning',
      bgColor: 'bg-warning/10',
      description: 'Vendas registradas no sistema',
      configurable: false,
    },
    {
      id: 2,
      label: 'Vendas Pagas',
      value: kpis.vendasPagasCount,
      icon: CheckCircle,
      color: 'text-success',
      bgColor: 'bg-success/10',
      description: 'Vendas confirmadas e pagas',
      configurable: false,
    },
  ];

  const getConversionRate = (from: number, to: number) => {
    if (from === 0) return '0%';
    return `${((to / from) * 100).toFixed(1)}%`;
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div>
          <CardTitle className="text-base font-semibold">Conversão Financeira do Funil</CardTitle>
          <p className="text-xs text-muted-foreground">
            Jornada do lead até a venda paga
          </p>
        </div>
      </CardHeader>
      <CardContent className="p-3 sm:p-6">
        <div className="flex flex-col sm:flex-row items-stretch gap-3 sm:gap-4">
          {steps.map((step, index) => (
            <div key={step.label} className="flex-1 flex flex-col sm:flex-row items-center gap-2">
              <div className="flex-1 w-full">
                <div className={`p-3 sm:p-4 rounded-lg ${step.bgColor} text-center relative group`}>
                  {step.configurable && (
                    <Popover 
                      open={activePopover === step.id} 
                      onOpenChange={(open) => setActivePopover(open ? step.id : null)}
                    >
                      <PopoverTrigger asChild>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="absolute top-1 right-1 h-6 w-6 opacity-0 group-hover:opacity-100 sm:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-64">
                        <div className="space-y-3">
                          <p className="text-sm font-medium">Etapas que contam como "{step.label}"</p>
                          <p className="text-xs text-muted-foreground">
                            Selecione quais etapas do Kanban são consideradas conversão
                          </p>
                          <div className="space-y-2 max-h-48 overflow-y-auto">
                            {stageTags.map((stage) => (
                              <label 
                                key={stage.id} 
                                className="flex items-center gap-2 cursor-pointer hover:bg-muted/50 p-1.5 rounded-md transition-colors"
                              >
                                <Checkbox
                                  checked={finalStageIds.includes(stage.id)}
                                  onCheckedChange={() => toggleFinalStage(stage.id)}
                                />
                                <div 
                                  className="w-2.5 h-2.5 rounded-full flex-shrink-0" 
                                  style={{ backgroundColor: stage.color }} 
                                />
                                <span className="text-sm truncate">{stage.name}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </PopoverContent>
                    </Popover>
                  )}
                  <step.icon className={`w-5 h-5 sm:w-6 sm:h-6 ${step.color} mx-auto mb-1.5 sm:mb-2`} />
                  <p className="text-xl sm:text-2xl font-bold">{step.value}</p>
                  <p className="text-[10px] sm:text-xs text-muted-foreground mt-0.5 sm:mt-1">{step.label}</p>
                  {step.configurable && finalStageIds.length > 0 && (
                    <div className="flex flex-wrap gap-1 justify-center mt-1">
                      {stageTags
                        .filter(s => finalStageIds.includes(s.id))
                        .map(s => (
                          <span 
                            key={s.id} 
                            className="text-[9px] px-1.5 py-0.5 rounded-full bg-background/50 text-muted-foreground"
                            style={{ borderLeft: `2px solid ${s.color}` }}
                          >
                            {s.name}
                          </span>
                        ))}
                    </div>
                  )}
                </div>
                <p className="text-[10px] sm:text-xs text-muted-foreground text-center mt-1.5 sm:mt-2 hidden sm:block">
                  {step.description}
                </p>
              </div>
              
              {/* Arrow - vertical on mobile, horizontal on desktop */}
              {index < steps.length - 1 && (
                <>
                  <div className="flex sm:hidden items-center justify-center py-1">
                    <div className="flex flex-col items-center">
                      <ArrowRight className="w-4 h-4 text-muted-foreground rotate-90" />
                      <span className="text-[10px] text-muted-foreground">
                        {getConversionRate(steps[index].value, steps[index + 1].value)}
                      </span>
                    </div>
                  </div>
                  <div className="hidden sm:flex flex-col items-center justify-center px-2">
                    <ArrowRight className="w-5 h-5 text-muted-foreground" />
                    <span className="text-xs text-muted-foreground mt-1">
                      {getConversionRate(steps[index].value, steps[index + 1].value)}
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
