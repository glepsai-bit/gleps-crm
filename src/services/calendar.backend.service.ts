/**
 * Calendar Backend Service
 * 
 * Handles calendar events and Google Calendar integration
 * via the Express backend API when VITE_USE_BACKEND=true.
 */

import { apiClient, ApiResponse } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { CalendarEvent, CreateEventDTO } from '@/types/calendar';

export const calendarBackendService = {
  // --- Events ---

  fetchEvents: async (): Promise<CalendarEvent[]> => {
    const res = await apiClient.get<ApiResponse<any[]>>(API_ENDPOINTS.CALENDAR.EVENTS);
    return (res.data || []).map(mapEventFromBackend);
  },

  createEvent: async (data: CreateEventDTO): Promise<CalendarEvent> => {
    const res = await apiClient.post<ApiResponse<any>>(API_ENDPOINTS.CALENDAR.CREATE_EVENT, {
      title: data.title,
      startTime: data.start,
      endTime: data.end,
      type: data.type,
      location: data.location,
      notes: data.notes,
      contactId: data.contactId,
    });
    return mapEventFromBackend(res.data);
  },

  updateEvent: async (id: string, data: Partial<CreateEventDTO>): Promise<CalendarEvent> => {
    const res = await apiClient.put<ApiResponse<any>>(API_ENDPOINTS.CALENDAR.UPDATE_EVENT(id), {
      title: data.title,
      startTime: data.start,
      endTime: data.end,
      location: data.location,
      notes: data.notes,
    });
    return mapEventFromBackend(res.data);
  },

  deleteEvent: async (id: string): Promise<void> => {
    await apiClient.delete(API_ENDPOINTS.CALENDAR.DELETE_EVENT(id));
  },

  // --- Google Calendar ---

  getGoogleStatus: async (): Promise<{
    connected: boolean;
    configured: boolean;
    missing: string[];
    email: string | null;
    needsReauth: boolean;
  }> => {
    const res = await apiClient.get<ApiResponse<any>>(`/api/calendar/google/status?_t=${Date.now()}`);
    return res.data;
  },

  connectGoogle: async (): Promise<{ authUrl: string }> => {
    const res = await apiClient.post<ApiResponse<{ authUrl: string }>>('/api/calendar/google/connect');
    return res.data;
  },

  disconnectGoogle: async (): Promise<void> => {
    await apiClient.post('/api/calendar/google/disconnect');
  },

  syncGoogle: async (): Promise<{ synced: number; created: number; updated: number }> => {
    const res = await apiClient.post<ApiResponse<any>>('/api/calendar/google/sync');
    return res.data;
  },
};

// Helper to map backend event shape to frontend CalendarEvent
function mapEventFromBackend(event: any): CalendarEvent {
  return {
    id: event.id,
    title: event.title,
    start: event.startTime || event.start_time || event.start,
    end: event.endTime || event.end_time || event.end,
    type: event.type || 'appointment',
    source: event.source || 'crm',
    status: event.status || 'scheduled',
    location: event.location || undefined,
    meetingLink: event.meetingLink || event.meeting_link || undefined,
    attendees: event.attendees || [],
    notes: event.notes || undefined,
    createdBy: event.createdBy || event.created_by || 'system',
    createdAt: event.createdAt || event.created_at || new Date().toISOString(),
  } as CalendarEvent;
}

export default calendarBackendService;
