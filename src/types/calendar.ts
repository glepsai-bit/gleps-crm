// Google Calendar Integration Types - Frontend Only (Mock)
// Prepared for future backend integration via OAuth 2.0

// ============= CONNECTION TYPES =============

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error' | 'syncing';

export interface GoogleCalendar {
  id: string;
  name: string;
  selected: boolean;
  color?: string;
}

export interface CalendarSettings {
  syncPastDays: number;
  syncFutureDays: number;
  workingHoursStart: string;
  workingHoursEnd: string;
  workingDays: number[]; // 0=Dom, 1=Seg, ..., 6=Sab
  defaultDuration: number; // minutes
  bufferBetweenMeetings: number; // minutes
}

export interface GoogleConnection {
  status: ConnectionStatus;
  email: string | null;
  connectedAt: string | null;
  lastSync: string | null;
  calendars: GoogleCalendar[];
  settings: CalendarSettings | null;
  errorMessage?: string;
}

// ============= EVENT TYPES =============

export type EventType = 'meeting' | 'appointment' | 'block' | 'other';
export type EventSource = 'google' | 'crm';
export type EventStatus = 'scheduled' | 'cancelled';
export type AttendeeStatus = 'pending' | 'confirmed' | 'declined' | 'tentative';
export type MeetingType = 'presencial' | 'online' | 'telefone';

export interface EventAttendee {
  name: string;
  email: string;
  status: AttendeeStatus;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string; // ISO datetime
  end: string;
  type: EventType;
  source: EventSource;
  status: EventStatus;
  location?: string;
  meetingLink?: string;
  attendees: EventAttendee[];
  contact?: {
    id: string;
    name: string;
    email?: string;
  };
  notes?: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateEventDTO {
  title: string;
  start: string;
  end: string;
  type: EventType;
  meetingType: MeetingType;
  location?: string;
  contactId?: string;
  attendeeEmails?: string[];
  notes?: string;
  createGoogleMeet?: boolean;
  syncToGoogle?: boolean;
  sendInvites?: boolean;
  reminders?: number[]; // minutes before
}

export interface UpdateEventDTO extends Partial<CreateEventDTO> {
  id: string;
}

// ============= AVAILABILITY TYPES =============

export interface AvailabilitySlot {
  date: string;
  time: string;
  available: boolean;
}

export interface BookingRequest {
  accountSlug: string;
  date: string;
  time: string;
  duration: number;
  name: string;
  email: string;
  phone: string;
  notes?: string;
}

export interface BookingConfirmation {
  success: boolean;
  eventId: string;
  meetingLink?: string;
  date: string;
  time: string;
  duration: number;
}

// ============= CALENDAR VIEW TYPES =============

export type CalendarViewMode = 'day' | 'week' | 'month';

export interface CalendarState {
  currentDate: Date;
  viewMode: CalendarViewMode;
  selectedEvent: CalendarEvent | null;
}
