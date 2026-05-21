import React, { createContext, useContext, useState, useCallback, useMemo, ReactNode, useEffect, useRef } from 'react';
import { useBackend } from '@/config/backend.config';
import { supabase } from '@/integrations/supabase/client';
import { calendarBackendService } from '@/services/calendar.backend.service';
import {
  GoogleConnection,
  CalendarEvent,
  CalendarSettings,
  CreateEventDTO,
  CalendarViewMode,
} from '@/types/calendar';
import {
  mockCalendarSettings,
} from '@/data/mockCalendarData';
import { toast } from 'sonner';

// ============= CONTEXT TYPE =============

interface CalendarContextType {
  // Connection state
  connection: GoogleConnection;
  isConnected: boolean;
  isLoading: boolean;
  isInitialized: boolean; // true after initial load completes
  googleConfigured: boolean; // true if server has all Google env vars
  googleMissing: string[]; // list of missing env var names
  
  // Events
  events: CalendarEvent[];
  selectedEvent: CalendarEvent | null;
  
  // View state
  currentDate: Date;
  viewMode: CalendarViewMode;
  
  // Actions - Connection
  connectGoogle: () => Promise<void>;
  disconnectGoogle: () => Promise<void>;
  syncNow: () => Promise<void>;
  checkConnectionStatus: () => Promise<void>;
  
  // Actions - Settings
  updateSettings: (settings: Partial<CalendarSettings>) => Promise<void>;
  selectCalendar: (calendarId: string, selected: boolean) => void;
  
  // Actions - Events
  createEvent: (data: CreateEventDTO) => Promise<CalendarEvent>;
  updateEvent: (id: string, data: Partial<CreateEventDTO>) => Promise<CalendarEvent>;
  deleteEvent: (id: string) => Promise<void>;
  selectEvent: (event: CalendarEvent | null) => void;
  loadEvents: () => Promise<void>;
  
  // Actions - Navigation
  setCurrentDate: (date: Date) => void;
  setViewMode: (mode: CalendarViewMode) => void;
  goToToday: () => void;
  goToPrevious: () => void;
  goToNext: () => void;
  
  // Availability (public)
  getAvailability: (month: string) => Record<string, string[]>;
  createBooking: (data: any) => Promise<{ success: boolean; eventId: string }>;
}

const CalendarContext = createContext<CalendarContextType | undefined>(undefined);

// ============= PROVIDER =============

interface CalendarProviderProps {
  children: ReactNode;
  accountId: string;
  userId: string;
}

const defaultConnection: GoogleConnection = {
  status: 'disconnected',
  email: null,
  connectedAt: null,
  calendars: [],
  settings: null,
  lastSync: null,
};

export function CalendarProvider({ children, accountId, userId }: CalendarProviderProps) {
  // State
  const [connection, setConnection] = useState<GoogleConnection>(defaultConnection);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<CalendarEvent | null>(null);
  const [currentDate, setCurrentDate] = useState<Date>(new Date());
  const [viewMode, setViewMode] = useState<CalendarViewMode>('week');
  const [isLoading, setIsLoading] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [googleConfigured, setGoogleConfigured] = useState(true);
  const [googleMissing, setGoogleMissing] = useState<string[]>([]);

  const isConnected = connection.status === 'connected';

  // ============= LOAD EVENTS FROM DATABASE =============
  // Load CRM events from account + Google events from current user

  const loadEvents = useCallback(async () => {
    console.log('[Calendar] loadEvents called with accountId:', accountId, 'userId:', userId);
    
    try {
      if (useBackend) {
        const mappedEvents = await calendarBackendService.fetchEvents();
        mappedEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
        setEvents(mappedEvents);
        return;
      }

      // Load CRM events for the whole account
      const { data: crmEvents, error: crmError } = await supabase
        .from('calendar_events')
        .select('*')
        .eq('account_id', accountId)
        .eq('source', 'crm')
        .order('start_time', { ascending: true });

      if (crmError) {
        console.error('[Calendar] Error loading CRM events:', crmError);
      }

      // Load Google events only for the current user
      const { data: googleEvents, error: googleError } = await supabase
        .from('calendar_events')
        .select('*')
        .eq('created_by', userId)
        .eq('source', 'google')
        .order('start_time', { ascending: true });

      if (googleError) {
        console.error('[Calendar] Error loading Google events:', googleError);
      }

      const allEvents = [...(crmEvents || []), ...(googleEvents || [])];

      const mappedEvents: CalendarEvent[] = allEvents.map((event) => ({
        id: event.id,
        title: event.title,
        start: event.start_time,
        end: event.end_time,
        type: (event.type as CalendarEvent['type']) || 'appointment',
        source: (event.source as 'google' | 'crm') || 'crm',
        status: (event.status as CalendarEvent['status']) || 'scheduled',
        location: event.location || undefined,
        meetingLink: event.meeting_link || undefined,
        googleEventId: event.google_event_id || undefined,
        googleCalendarId: event.google_calendar_id || undefined,
        attendees: [],
        notes: event.notes || undefined,
        createdBy: event.created_by || undefined,
        createdAt: event.created_at || undefined,
        contactId: event.contact_id || undefined,
      }) as CalendarEvent);

      mappedEvents.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      setEvents(mappedEvents);
    } catch (error) {
      console.error('[Calendar] Failed to load events:', error);
    }
  }, [accountId, userId]);

  // ============= CHECK CONNECTION STATUS =============

  const checkConnectionStatus = useCallback(async () => {
    try {
      if (useBackend) {
        const status = await calendarBackendService.getGoogleStatus();
        setGoogleConfigured(status.configured ?? true);
        setGoogleMissing(status.missing ?? []);
        if (status.needsReauth) {
          setConnection({ ...defaultConnection, status: 'error', email: status.email });
        } else if (status.connected) {
          setConnection({
            status: 'connected',
            email: status.email,
            connectedAt: new Date().toISOString(),
            calendars: [],
            settings: mockCalendarSettings,
            lastSync: new Date().toISOString(),
          });
        } else {
          setConnection(defaultConnection);
        }
        setIsLoading(false);
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        setIsLoading(false);
        return;
      }

      const response = await supabase.functions.invoke('google-calendar-status', {});
      
      if (response.error) {
        console.error('Status check error:', response.error);
        setConnection(defaultConnection);
      } else if (response.data) {
        const { connected, email, needsReauth } = response.data;
        
        if (needsReauth) {
          setConnection({ ...defaultConnection, status: 'error', email });
        } else if (connected) {
          setConnection({
            status: 'connected',
            email,
            connectedAt: new Date().toISOString(),
            calendars: [],
            settings: mockCalendarSettings,
            lastSync: new Date().toISOString(),
          });
        } else {
          setConnection(defaultConnection);
        }
      }
    } catch (error) {
      console.error('Connection status check failed:', error);
      setConnection(defaultConnection);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // ============= INITIAL LOAD =============

  const initRef = useRef(false);

  useEffect(() => {
    if (!accountId) return;
    if (initRef.current) return;
    initRef.current = true;

    const init = async () => {
      console.log('[Calendar] Initializing context...');
      await checkConnectionStatus();
      await loadEvents();
      setIsInitialized(true);
      console.log('[Calendar] Context initialized');
    };
    init();
  }, [accountId, checkConnectionStatus, loadEvents]);

  // ============= AUTO-SYNC POLLING =============
  // Syncs every 30 seconds ONLY when connected.
  // Pauses on critical errors to avoid flooding.

  const syncErrorCountRef = useRef(0);
  const MAX_SYNC_ERRORS = 3;

  useEffect(() => {
    if (!accountId) return;
    if (!isConnected) return;

    const SYNC_INTERVAL = 30000;

    const intervalId = setInterval(async () => {
      // Stop polling if too many consecutive errors
      if (syncErrorCountRef.current >= MAX_SYNC_ERRORS) {
        console.warn('[Calendar] Auto-sync paused after repeated errors');
        return;
      }

      console.log('[Calendar] Auto-sync polling...');

      try {
        if (useBackend) {
          await calendarBackendService.syncGoogle();
          await loadEvents();
          syncErrorCountRef.current = 0; // Reset on success
          return;
        }

        const { data: { session } } = await supabase.auth.getSession();
        if (!session) return;

        const response = await supabase.functions.invoke('google-calendar-sync', {});
        if (!response.error) {
          await loadEvents();
          syncErrorCountRef.current = 0;
        } else {
          syncErrorCountRef.current++;
        }
      } catch (error) {
        syncErrorCountRef.current++;
        console.warn(`[Calendar] Auto-sync failed (${syncErrorCountRef.current}/${MAX_SYNC_ERRORS}):`, error);
      }
    }, SYNC_INTERVAL);

    return () => {
      clearInterval(intervalId);
    };
  }, [accountId, isConnected, loadEvents]);

  // ============= CONNECTION ACTIONS =============

  const connectGoogle = useCallback(async () => {
    setConnection(prev => ({ ...prev, status: 'connecting' }));

    try {
      let authUrl: string;

      if (useBackend) {
        const result = await calendarBackendService.connectGoogle();
        authUrl = result.authUrl;
      } else {
        const response = await supabase.functions.invoke('google-calendar-auth-url', {});
        if (response.error) {
          throw new Error(response.error.message || 'Erro ao iniciar conexão');
        }
        if (!response.data?.authUrl) {
          throw new Error('URL de autorização não recebida');
        }
        authUrl = response.data.authUrl;
      }

      const isInIframe = window.self !== window.top;
      if (isInIframe) {
        window.open(authUrl, '_blank');
      } else {
        window.location.href = authUrl;
      }
    } catch (error: any) {
      console.error('Connect error:', error);
      setConnection(defaultConnection);
      
      const code = error?.response?.data?.error?.code || error?.code || '';
      const msg = error?.response?.data?.error?.message || error?.message || '';
      if (code === 'GOOGLE_NOT_CONFIGURED' || msg.includes('não configurado') || msg.includes('not configured')) {
        toast.error('Google Calendar ainda não foi configurado pelo administrador do sistema. Entre em contato com o suporte.');
      } else {
        toast.error(msg || 'Erro ao conectar com Google Calendar');
      }
    }
  }, []);

  const disconnectGoogle = useCallback(async () => {
    try {
      if (useBackend) {
        await calendarBackendService.disconnectGoogle();
      } else {
        const response = await supabase.functions.invoke('google-calendar-disconnect', {});
        if (response.error) {
          throw new Error(response.error.message || 'Erro ao desconectar');
        }
      }

      setConnection(defaultConnection);
      setEvents(prev => prev.filter(event => event.source !== 'google'));
      await loadEvents();
      toast.success('Google Calendar desconectado');
    } catch (error: any) {
      console.error('Disconnect error:', error);
      toast.error(error.message || 'Erro ao desconectar');
    }
  }, [loadEvents]);

  const syncNow = useCallback(async () => {
    console.log('[Calendar] syncNow called');
    
    setConnection(prev => ({ ...prev, status: 'syncing' }));

    try {
      if (useBackend) {
        const result = await calendarBackendService.syncGoogle();
        await loadEvents();
        setConnection(prev => ({ ...prev, status: 'connected', lastSync: new Date().toISOString() }));
        toast.success(`Sincronizado! ${result.created || 0} novos, ${result.updated || 0} atualizados`);
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.warn('[Calendar] syncNow: No session, aborting');
        setConnection(prev => ({ ...prev, status: 'connected' }));
        return;
      }
      
      const response = await supabase.functions.invoke('google-calendar-sync', {});
      
      if (response.error) {
        if (response.error.message?.toLowerCase().includes('não conectado')) {
          setConnection(prev => ({ ...prev, status: 'error' }));
          toast.error('Sua conexão com o Google Calendar expirou. Clique em "Reconectar".');
          return;
        }
        throw new Error(response.error.message || 'Erro ao sincronizar');
      }

      await loadEvents();
      setConnection(prev => ({ ...prev, status: 'connected', lastSync: new Date().toISOString() }));

      const { created, updated } = response.data || {};
      toast.success(`Sincronizado! ${created || 0} novos, ${updated || 0} atualizados`);
    } catch (error: any) {
      console.error('[Calendar] Sync error:', error);
      setConnection(prev => ({ ...prev, status: 'connected' }));
      toast.error(error.message || 'Erro ao sincronizar');
    }
  }, [loadEvents]);

  // ============= SETTINGS ACTIONS =============

  const updateSettings = useCallback(async (newSettings: Partial<CalendarSettings>) => {
    setConnection(prev => ({
      ...prev,
      settings: prev.settings ? { ...prev.settings, ...newSettings } : mockCalendarSettings,
    }));
    
    toast.success('Configurações salvas!');
  }, []);

  const selectCalendar = useCallback((calendarId: string, selected: boolean) => {
    setConnection(prev => ({
      ...prev,
      calendars: prev.calendars.map(cal =>
        cal.id === calendarId ? { ...cal, selected } : cal
      ),
    }));
  }, []);

  // ============= EVENT ACTIONS =============

  const createEvent = useCallback(async (data: CreateEventDTO): Promise<CalendarEvent> => {
    if (useBackend) {
      const mappedEvent = await calendarBackendService.createEvent(data);
      setEvents(prev => [...prev, mappedEvent]);
      toast.success('Evento criado com sucesso!');
      return mappedEvent;
    }

    const { data: newEvent, error } = await supabase
      .from('calendar_events')
      .insert({
        account_id: accountId,
        title: data.title,
        start_time: data.start,
        end_time: data.end,
        type: data.type,
        location: data.location,
        notes: data.notes,
        contact_id: data.contactId,
        source: 'crm',
        status: 'scheduled',
      })
      .select()
      .single();

    if (error) {
      console.error('Create event error:', error);
      toast.error('Erro ao criar evento');
      throw error;
    }

    const mappedEvent: CalendarEvent = {
      id: newEvent.id,
      title: newEvent.title,
      start: newEvent.start_time,
      end: newEvent.end_time,
      type: (newEvent.type as CalendarEvent['type']) || 'appointment',
      source: 'crm',
      status: 'scheduled',
      location: newEvent.location || undefined,
      attendees: [],
      notes: newEvent.notes || undefined,
      createdBy: newEvent.created_by || 'system',
      createdAt: newEvent.created_at || new Date().toISOString(),
    };

    setEvents(prev => [...prev, mappedEvent]);
    toast.success('Evento criado com sucesso!');
    
    return mappedEvent;
  }, [accountId]);

  const updateEvent = useCallback(async (id: string, data: Partial<CreateEventDTO>): Promise<CalendarEvent> => {
    if (useBackend) {
      const mappedEvent = await calendarBackendService.updateEvent(id, data);
      setEvents(prev => prev.map(event => event.id === id ? mappedEvent : event));
      toast.success('Evento atualizado!');
      return mappedEvent;
    }

    const { data: updatedEvent, error } = await supabase
      .from('calendar_events')
      .update({
        title: data.title,
        start_time: data.start,
        end_time: data.end,
        location: data.location,
        notes: data.notes,
      })
      .eq('id', id)
      .select()
      .single();

    if (error) {
      console.error('Update event error:', error);
      toast.error('Erro ao atualizar evento');
      throw error;
    }

    const mappedEvent: CalendarEvent = {
      id: updatedEvent.id,
      title: updatedEvent.title,
      start: updatedEvent.start_time,
      end: updatedEvent.end_time,
      type: (updatedEvent.type as CalendarEvent['type']) || 'appointment',
      source: (updatedEvent.source as 'google' | 'crm') || 'crm',
      status: (updatedEvent.status as CalendarEvent['status']) || 'scheduled',
      location: updatedEvent.location || undefined,
      attendees: [],
      notes: updatedEvent.notes || undefined,
      createdBy: updatedEvent.created_by || 'system',
      createdAt: updatedEvent.created_at || new Date().toISOString(),
    };

    setEvents(prev => prev.map(event => event.id === id ? mappedEvent : event));
    toast.success('Evento atualizado!');
    
    return mappedEvent;
  }, []);

  const deleteEvent = useCallback(async (id: string) => {
    if (useBackend) {
      await calendarBackendService.deleteEvent(id);
      setEvents(prev => prev.filter(event => event.id !== id));
      setSelectedEvent(null);
      toast.success('Evento excluído!');
      return;
    }

    const { error } = await supabase
      .from('calendar_events')
      .delete()
      .eq('id', id);

    if (error) {
      console.error('Delete event error:', error);
      toast.error('Erro ao excluir evento');
      throw error;
    }

    setEvents(prev => prev.filter(event => event.id !== id));
    setSelectedEvent(null);
    toast.success('Evento excluído!');
  }, []);

  const selectEvent = useCallback((event: CalendarEvent | null) => {
    setSelectedEvent(event);
  }, []);

  // ============= NAVIGATION ACTIONS =============

  const goToToday = useCallback(() => {
    setCurrentDate(new Date());
  }, []);

  const goToPrevious = useCallback(() => {
    setCurrentDate(prev => {
      const newDate = new Date(prev);
      if (viewMode === 'day') {
        newDate.setDate(newDate.getDate() - 1);
      } else if (viewMode === 'week') {
        newDate.setDate(newDate.getDate() - 7);
      } else {
        newDate.setMonth(newDate.getMonth() - 1);
      }
      return newDate;
    });
  }, [viewMode]);

  const goToNext = useCallback(() => {
    setCurrentDate(prev => {
      const newDate = new Date(prev);
      if (viewMode === 'day') {
        newDate.setDate(newDate.getDate() + 1);
      } else if (viewMode === 'week') {
        newDate.setDate(newDate.getDate() + 7);
      } else {
        newDate.setMonth(newDate.getMonth() + 1);
      }
      return newDate;
    });
  }, [viewMode]);

  // ============= PUBLIC AVAILABILITY =============

  const getAvailability = useCallback((month: string) => {
    // TODO: Implement real availability based on events
    return {};
  }, []);

  const createBooking = useCallback(async (data: any) => {
    console.log('Creating booking:', data);
    return {
      success: true,
      eventId: `booking-${Date.now()}`,
    };
  }, []);

  // ============= CONTEXT VALUE =============

  const value = useMemo(() => ({
    connection,
    isConnected,
    isLoading,
    isInitialized,
    googleConfigured,
    googleMissing,
    events,
    selectedEvent,
    currentDate,
    viewMode,
    connectGoogle,
    disconnectGoogle,
    syncNow,
    checkConnectionStatus,
    updateSettings,
    selectCalendar,
    createEvent,
    updateEvent,
    deleteEvent,
    selectEvent,
    loadEvents,
    setCurrentDate,
    setViewMode,
    goToToday,
    goToPrevious,
    goToNext,
    getAvailability,
    createBooking,
  }), [
    connection,
    isConnected,
    isLoading,
    isInitialized,
    googleConfigured,
    googleMissing,
    events,
    selectedEvent,
    currentDate,
    viewMode,
    connectGoogle,
    disconnectGoogle,
    syncNow,
    checkConnectionStatus,
    updateSettings,
    selectCalendar,
    createEvent,
    updateEvent,
    deleteEvent,
    selectEvent,
    loadEvents,
    goToToday,
    goToPrevious,
    goToNext,
    getAvailability,
    createBooking,
  ]);

  return (
    <CalendarContext.Provider value={value}>
      {children}
    </CalendarContext.Provider>
  );
}

// ============= HOOK =============

export function useCalendar() {
  const context = useContext(CalendarContext);
  if (context === undefined) {
    throw new Error('useCalendar must be used within a CalendarProvider');
  }
  return context;
}
