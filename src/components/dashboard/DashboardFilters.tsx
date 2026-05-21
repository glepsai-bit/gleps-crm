import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Calendar as CalendarIcon, MessageCircle, Bot, User, Filter } from 'lucide-react';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { format, subDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { DateRange } from 'react-day-picker';
import { AgentFilter } from './AgentFilter';

interface DashboardFiltersProps {
  onPeriodChange?: (period: string, dateRange?: DateRange) => void;
  onChannelChange?: (channel: string) => void;
  onTypeChange?: (type: string) => void;
  onAgentChange?: (agentId: string) => void;
  showAgentFilter?: boolean;
  showChannelFilter?: boolean;
  showTypeFilter?: boolean;
}

export function DashboardFilters({
  onPeriodChange,
  onChannelChange,
  onTypeChange,
  onAgentChange,
  showAgentFilter = false,
  showChannelFilter = true,
  showTypeFilter = true,
}: DashboardFiltersProps) {
  const [activePeriod, setActivePeriod] = useState('7d');
  const [channel, setChannel] = useState('all');
  const [type, setType] = useState('all');
  const [selectedAgent, setSelectedAgent] = useState('all');
  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: subDays(new Date(), 7),
    to: new Date(),
  });

  const periods = [
    { value: '7d', label: '7 dias' },
    { value: '30d', label: '30 dias' },
  ];

  const handlePeriodChange = (period: string) => {
    setActivePeriod(period);
    
    let newRange: DateRange;
    if (period === '7d') {
      newRange = { from: subDays(new Date(), 7), to: new Date() };
    } else if (period === '30d') {
      newRange = { from: subDays(new Date(), 30), to: new Date() };
    } else {
      newRange = dateRange || { from: new Date(), to: new Date() };
    }
    
    setDateRange(newRange);
    onPeriodChange?.(period, newRange);
  };

  const handleDateRangeChange = (range: DateRange | undefined) => {
    setDateRange(range);
    setActivePeriod('custom');
    onPeriodChange?.('custom', range);
  };

  const handleChannelChange = (value: string) => {
    setChannel(value);
    onChannelChange?.(value);
  };

  const handleTypeChange = (value: string) => {
    setType(value);
    onTypeChange?.(value);
  };

  const handleAgentChange = (value: string) => {
    setSelectedAgent(value);
    onAgentChange?.(value);
  };

  return (
    <div className="flex flex-col gap-2 sm:gap-3 p-3 sm:p-4 bg-card rounded-lg border border-border sm:flex-row sm:flex-wrap sm:items-center">
      <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto">
        <CalendarIcon className="w-4 h-4 text-muted-foreground flex-shrink-0 hidden sm:block" />
        <div className="flex bg-muted rounded-lg p-0.5 sm:p-1 gap-0.5 sm:gap-1 min-w-0">
          {periods.map((period) => (
            <Button
              key={period.value}
              variant={activePeriod === period.value ? 'default' : 'ghost'}
              size="sm"
              className="h-7 sm:h-8 px-2 sm:px-3 text-[10px] sm:text-xs shrink-0"
              onClick={() => handlePeriodChange(period.value)}
            >
              {period.label}
            </Button>
          ))}
          
          {/* Calendar Picker */}
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant={activePeriod === 'custom' ? 'default' : 'ghost'}
                size="sm"
                className={cn(
                  "h-7 sm:h-8 px-2 sm:px-3 text-[10px] sm:text-xs gap-1 sm:gap-1.5 shrink-0",
                  activePeriod === 'custom' && "bg-primary text-primary-foreground"
                )}
              >
                <CalendarIcon className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                {activePeriod === 'custom' && dateRange?.from ? (
                  dateRange.to ? (
                    <>
                      {format(dateRange.from, "dd/MM", { locale: ptBR })} - {format(dateRange.to, "dd/MM", { locale: ptBR })}
                    </>
                  ) : (
                    format(dateRange.from, "dd/MM", { locale: ptBR })
                  )
                ) : (
                  "Período"
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 bg-popover" align="start">
              <Calendar
                initialFocus
                mode="range"
                defaultMonth={dateRange?.from}
                selected={dateRange}
                onSelect={handleDateRangeChange}
                numberOfMonths={1}
                locale={ptBR}
                className="sm:hidden"
              />
              <Calendar
                initialFocus
                mode="range"
                defaultMonth={dateRange?.from}
                selected={dateRange}
                onSelect={handleDateRangeChange}
                numberOfMonths={2}
                locale={ptBR}
                className="hidden sm:block"
              />
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {/* Channel Filter */}
      {showChannelFilter && (
        <>
          <div className="hidden sm:block h-6 w-px bg-border" />
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <MessageCircle className="w-4 h-4 text-muted-foreground flex-shrink-0 hidden sm:block" />
            <Select value={channel} onValueChange={handleChannelChange}>
              <SelectTrigger className="w-full sm:w-[120px] md:w-[140px] h-8 text-xs sm:text-sm">
                <SelectValue placeholder="Canal" />
              </SelectTrigger>
              <SelectContent className="bg-popover border border-border z-50">
                <SelectItem value="all">Todos Canais</SelectItem>
                <SelectItem value="whatsapp">WhatsApp</SelectItem>
                <SelectItem value="instagram">Instagram</SelectItem>
                <SelectItem value="webchat">Webchat</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </>
      )}

      {/* Type Filter (IA/Human) */}
      {showTypeFilter && (
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter className="w-4 h-4 text-muted-foreground flex-shrink-0 hidden sm:block" />
          <Select value={type} onValueChange={handleTypeChange}>
            <SelectTrigger className="w-full sm:w-[110px] md:w-[140px] h-8 text-xs sm:text-sm">
              <SelectValue placeholder="Tipo" />
            </SelectTrigger>
            <SelectContent className="bg-popover border border-border z-50">
              <SelectItem value="all">Todos</SelectItem>
              <SelectItem value="ia">
                <div className="flex items-center gap-2">
                  <Bot className="w-3 h-3" />
                  IA
                </div>
              </SelectItem>
              <SelectItem value="human">
                <div className="flex items-center gap-2">
                  <User className="w-3 h-3" />
                  Humano
                </div>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Agent Filter - Only visible for admins when enabled */}
      {showAgentFilter && (
        <>
          <div className="hidden sm:block h-6 w-px bg-border" />
          <div className="w-full sm:w-auto">
            <AgentFilter value={selectedAgent} onChange={handleAgentChange} />
          </div>
        </>
      )}
    </div>
  );
}
