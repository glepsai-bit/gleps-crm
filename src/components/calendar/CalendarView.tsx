import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCalendar } from '@/contexts/CalendarContext';
import { CalendarEvent } from '@/types/calendar';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
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
}

export function CalendarView({ onNewEvent }: CalendarViewProps) {
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

  // Get events for the current view
  const visibleEvents = useMemo(() => {
    let start: Date, end: Date;

    if (viewMode === 'day') {
      start = startOfDay(currentDate);
      end = addHours(start, 24);
    } else if (viewMode === 'week') {
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
  }, [events, currentDate, viewMode]);

  const getEventColor = (event: CalendarEvent) => {
    if (event.source === 'google') {
      return 'bg-blue-500/20 border-blue-500 text-blue-700 dark:text-blue-300';
    }
    if (event.type === 'block') {
      return 'bg-yellow-500/20 border-yellow-500 text-yellow-700 dark:text-yellow-300';
    }
    return 'bg-success/20 border-success text-success';
  };

  const hours = Array.from({ length: 12 }, (_, i) => i + 7); // 7:00 - 18:00

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
    
    const topMinutes = differenceInMinutes(start, dayStart) - 7 * 60; // Offset from 7:00
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
              {format(currentDate, viewMode === 'day' ? 'dd MMMM yyyy' : 'MMMM yyyy', { locale: ptBR })}
            </CardTitle>
            <Button variant="outline" size="sm" onClick={goToToday}>
              Hoje
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="icon" onClick={goToPrevious}>
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button variant="outline" size="icon" onClick={goToNext}>
              <ChevronRight className="w-4 h-4" />
            </Button>

            <div className="flex border rounded-lg overflow-hidden ml-2">
              {(['day', 'week', 'month'] as const).map(mode => (
                <Button
                  key={mode}
                  variant={viewMode === mode ? 'default' : 'ghost'}
                  size="sm"
                  className="rounded-none"
                  onClick={() => setViewMode(mode)}
                >
                  {mode === 'day' ? 'Dia' : mode === 'week' ? 'Semana' : 'Mês'}
                </Button>
              ))}
            </div>

            {onNewEvent && (
              <Button onClick={onNewEvent} size="sm" className="ml-2">
                <Plus className="w-4 h-4 mr-1" />
                Novo Evento
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 overflow-auto p-0">
        {/* Week View */}
        {viewMode === 'week' && (
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
        {viewMode === 'month' && (
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
        {viewMode === 'day' && (
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
