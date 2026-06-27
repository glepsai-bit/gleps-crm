import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { useCalendar } from '@/contexts/CalendarContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { CalendarEvent } from '@/types/calendar';
import { CalendarDays, ChevronLeft, ChevronRight, Info, Plus } from 'lucide-react';
import {
  format,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
  isToday,
  addHours,
  startOfDay,
  differenceInMinutes,
  parseISO,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';

interface CalendarViewProps {
  onNewEvent?: () => void;
  /** Hora inicial do grid (Day/Week). Default: 6 (academia abre 06:00). */
  startHour?: number;
  /** Hora final do grid (Day/Week, exclusiva). Default: 22 (academia fecha 22:00). */
  endHour?: number;
}

export function CalendarView({
  onNewEvent,
  startHour = 6,
  endHour = 22,
}: CalendarViewProps) {
  const {
    events,
    currentDate,
    viewMode,
    setViewMode,
    goToToday,
    goToPrevious,
    goToNext,
    selectEvent,
  } = useCalendar();

  // GRUPO B6: em mobile (<768px) a vista Semana exige scroll horizontal e
  // expoe apenas 2-3 dias visiveis, alem de espremer os botoes de navegacao.
  // Para evitar UX degradada, forcamos Day view enquanto o viewport for mobile,
  // mantendo a escolha do usuario ('week'/'month') para quando ele voltar pro
  // desktop. Tambem mostramos um aviso explicando o downgrade automatico.
  const isMobile = useIsMobile();
  const effectiveViewMode =
    isMobile && (viewMode === 'week' || viewMode === 'month') ? 'day' : viewMode;
  const showMobileWeekNotice = isMobile && viewMode === 'week';
  const showMobileMonthNotice = isMobile && viewMode === 'month';

  // Get events for the current view
  const visibleEvents = useMemo(() => {
    let start: Date, end: Date;

    if (effectiveViewMode === 'day') {
      start = startOfDay(currentDate);
      end = addHours(start, 24);
    } else if (effectiveViewMode === 'week') {
      start = startOfWeek(currentDate, { weekStartsOn: 1 });
      end = endOfWeek(currentDate, { weekStartsOn: 1 });
    } else {
      start = startOfMonth(currentDate);
      end = endOfMonth(currentDate);
    }

    return events.filter(event => {
      const eventStart = parseISO(event.start);
      return eventStart >= start && eventStart <= end;
    });
  }, [events, currentDate, effectiveViewMode]);

  const getEventColor = (event: CalendarEvent) => {
    if (event.source === 'google') {
      return 'bg-blue-500/20 border-blue-500 text-blue-700 dark:text-blue-300';
    }
    if (event.type === 'block') {
      return 'bg-yellow-500/20 border-yellow-500 text-yellow-700 dark:text-yellow-300';
    }
    return 'bg-success/20 border-success text-success';
  };

  // H-AGENDA-1: range configuravel (default 06:00-22:00 cobre horario de academia)
  const hours = useMemo(
    () =>
      Array.from(
        { length: Math.max(0, endHour - startHour) },
        (_, i) => i + startHour,
      ),
    [startHour, endHour],
  );

  const weekDays = useMemo(() => {
    const start = startOfWeek(currentDate, { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end: endOfWeek(start, { weekStartsOn: 1 }) });
  }, [currentDate]);

  const monthDays = useMemo(() => {
    const start = startOfMonth(currentDate);
    const end = endOfMonth(currentDate);
    const monthStart = startOfWeek(start, { weekStartsOn: 1 });
    const monthEnd = endOfWeek(end, { weekStartsOn: 1 });
    return eachDayOfInterval({ start: monthStart, end: monthEnd });
  }, [currentDate]);

  const getEventsForDay = (day: Date) => {
    return visibleEvents.filter(event => isSameDay(parseISO(event.start), day));
  };

  const getEventPosition = (event: CalendarEvent) => {
    const start = parseISO(event.start);
    const end = parseISO(event.end);
    const dayStart = startOfDay(start);

    // Offset relativo ao startHour configurado
    const topMinutes = differenceInMinutes(start, dayStart) - startHour * 60;
    const durationMinutes = differenceInMinutes(end, start);

    return {
      top: Math.max(0, (topMinutes / 60) * 60), // 60px per hour
      height: Math.max(30, (durationMinutes / 60) * 60),
    };
  };

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <CardTitle className="text-xl">
              {format(currentDate, effectiveViewMode === 'day' ? 'dd MMMM yyyy' : 'MMMM yyyy', { locale: ptBR })}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={goToToday} className="min-h-[44px] sm:min-h-0">
              Hoje
            </Button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* GRUPO B6: prev/next maiores em mobile (touch target 44x44) */}
            <Button
              variant="outline"
              size="icon"
              onClick={goToPrevious}
              aria-label="Anterior"
              className="h-11 w-11 sm:h-9 sm:w-9"
            >
              <ChevronLeft className="w-5 h-5 sm:w-4 sm:h-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={goToNext}
              aria-label="Proximo"
              className="h-11 w-11 sm:h-9 sm:w-9"
            >
              <ChevronRight className="w-5 h-5 sm:w-4 sm:h-4" />
            </Button>

            <div className="flex border rounded-lg overflow-hidden ml-2">
              {(['day', 'week', 'month'] as const).map(mode => (
                <Button
                  key={mode}
                  variant={viewMode === mode ? 'default' : 'ghost'}
                  size="sm"
                  className="rounded-none min-h-[44px] sm:min-h-0"
                  onClick={() => setViewMode(mode)}
                >
                  {mode === 'day' ? 'Dia' : mode === 'week' ? 'Semana' : 'Mês'}
                </Button>
              ))}
            </div>

            {onNewEvent && (
              <Button onClick={onNewEvent} size="sm" className="ml-2 min-h-[44px] sm:min-h-0">
                <Plus className="w-4 h-4 mr-1" />
                Novo Evento
              </Button>
            )}
          </div>
        </div>

        {/* GRUPO B6: aviso quando o usuario escolheu Semana/Mes mas estamos em mobile */}
        {(showMobileWeekNotice || showMobileMonthNotice) && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground/90"
          >
            <Info className="w-4 h-4 shrink-0 mt-0.5 text-warning" aria-hidden="true" />
            <span>
              Vista {showMobileWeekNotice ? 'Semana' : 'Mês'} é otimizada para desktop.
              Em telas pequenas exibimos a vista Dia. Gire o aparelho ou abra no
              desktop para ver a {showMobileWeekNotice ? 'semana completa' : 'grade mensal'}.
            </span>
          </div>
        )}
      </CardHeader>

      <CardContent className="flex-1 overflow-auto p-0">
        {/* GRUPO B4: empty state quando nao ha eventos no periodo visivel.
            Mostra acima do grid em vez de substitui-lo para o usuario continuar
            tendo o contexto temporal (linhas de hora / dias do mes). */}
        {visibleEvents.length === 0 && (
          <EmptyState
            icon={<CalendarDays className="w-10 h-10" />}
            title="Sem eventos no periodo"
            description={
              effectiveViewMode === 'day'
                ? 'Nada agendado para este dia. Crie um evento ou navegue para outra data.'
                : effectiveViewMode === 'week'
                  ? 'Nada agendado nesta semana. Crie um evento ou navegue para outra semana.'
                  : 'Nada agendado neste mes. Crie um evento ou navegue para outro mes.'
            }
            action={
              onNewEvent ? (
                <Button size="sm" onClick={onNewEvent} className="gap-2">
                  <Plus className="w-4 h-4" />
                  Novo Evento
                </Button>
              ) : null
            }
            className="py-8 border-b"
          />
        )}

        {/* Week View */}
        {effectiveViewMode === 'week' && (
          <div className="overflow-x-auto">
            <div className="min-w-[700px] min-h-[600px]">
              {/* Header */}
              <div className="grid grid-cols-8 border-b sticky top-0 bg-background z-10">
                <div className="p-2 text-center text-xs text-muted-foreground border-r min-w-[50px]" />
                {weekDays.map(day => (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      'p-2 text-center border-r last:border-r-0 min-w-[80px]',
                      isToday(day) && 'bg-primary/5'
                    )}
                  >
                    <div className="text-xs text-muted-foreground">
                      {format(day, 'EEE', { locale: ptBR })}
                    </div>
                    <div className={cn(
                      'text-lg font-semibold',
                      isToday(day) && 'text-primary'
                    )}>
                      {format(day, 'd')}
                    </div>
                  </div>
                ))}
              </div>

              {/* Time Grid */}
              <div className="grid grid-cols-8">
                {/* Time Labels */}
                <div className="border-r min-w-[50px]">
                  {hours.map(hour => (
                    <div key={hour} className="h-[60px] text-xs text-muted-foreground text-right pr-2 pt-0">
                      {`${hour.toString().padStart(2, '0')}:00`}
                    </div>
                  ))}
                </div>

                {/* Days */}
                {weekDays.map(day => (
                  <div key={day.toISOString()} className="relative border-r last:border-r-0 min-w-[80px]">
                    {/* Hour Lines */}
                    {hours.map(hour => (
                      <div key={hour} className="h-[60px] border-b border-dashed" />
                    ))}

                    {/* Events */}
                    {getEventsForDay(day).map(event => {
                      const pos = getEventPosition(event);
                      return (
                        <div
                          key={event.id}
                          className={cn(
                            'absolute left-1 right-1 px-1 py-0.5 text-xs rounded border-l-2 cursor-pointer overflow-hidden',
                            getEventColor(event)
                          )}
                          style={{
                            top: pos.top,
                            height: pos.height,
                            minHeight: 24,
                          }}
                          onClick={() => selectEvent(event)}
                          title={event.title}
                        >
                          <div className="font-medium truncate">{event.title}</div>
                          {pos.height > 40 && (
                            <div className="truncate opacity-75">
                              {format(parseISO(event.start), 'HH:mm')}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Month View */}
        {effectiveViewMode === 'month' && (
          <div className="min-h-[600px] p-4">
            {/* Day Labels */}
            <div className="grid grid-cols-7 mb-2">
              {['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map(day => (
                <div key={day} className="text-center text-sm font-medium text-muted-foreground">
                  {day}
                </div>
              ))}
            </div>

            {/* Days Grid */}
            <div className="grid grid-cols-7 gap-1">
              {monthDays.map(day => {
                const dayEvents = getEventsForDay(day);
                return (
                  <div
                    key={day.toISOString()}
                    className={cn(
                      'min-h-[80px] p-1 border rounded-lg',
                      !isSameMonth(day, currentDate) && 'opacity-30',
                      isToday(day) && 'ring-2 ring-primary'
                    )}
                  >
                    <div className={cn(
                      'text-sm font-medium mb-1',
                      isToday(day) && 'text-primary'
                    )}>
                      {format(day, 'd')}
                    </div>
                    <div className="space-y-0.5">
                      {dayEvents.slice(0, 2).map(event => (
                        <div
                          key={event.id}
                          className={cn(
                            'text-xs truncate px-1 rounded cursor-pointer',
                            getEventColor(event)
                          )}
                          onClick={() => selectEvent(event)}
                        >
                          {event.title}
                        </div>
                      ))}
                      {dayEvents.length > 2 && (
                        <div className="text-xs text-muted-foreground pl-1">
                          +{dayEvents.length - 2} mais
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Day View */}
        {effectiveViewMode === 'day' && (
          <div className="min-h-[600px]">
            <div className="flex">
              {/* Time Labels */}
              <div className="flex-shrink-0 w-14 border-r">
                {hours.map(hour => (
                  <div key={hour} className="h-[60px] text-xs text-muted-foreground text-right pr-2">
                    {`${hour.toString().padStart(2, '0')}:00`}
                  </div>
                ))}
              </div>

              {/* Events */}
              <div className="relative flex-1 min-w-0">
                {hours.map(hour => (
                  <div key={hour} className="h-[60px] border-b border-dashed" />
                ))}

                {getEventsForDay(currentDate).map(event => {
                  const pos = getEventPosition(event);
                  return (
                    <div
                      key={event.id}
                      className={cn(
                        'absolute left-2 right-2 px-2 py-1 text-sm rounded border-l-4 cursor-pointer overflow-hidden',
                        getEventColor(event)
                      )}
                      style={{
                        top: pos.top,
                        height: pos.height,
                      }}
                      onClick={() => selectEvent(event)}
                    >
                      <div className="font-medium truncate">{event.title}</div>
                      <div className="opacity-75 truncate">
                        {format(parseISO(event.start), 'HH:mm')} - {format(parseISO(event.end), 'HH:mm')}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </CardContent>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-3 sm:gap-4 p-3 sm:p-4 border-t text-xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-blue-500/50" />
          <span>Google Calendar</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-success/50" />
          <span>CRM</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded bg-yellow-500/50" />
          <span>Bloqueio</span>
        </div>
      </div>
    </Card>
  );
}
