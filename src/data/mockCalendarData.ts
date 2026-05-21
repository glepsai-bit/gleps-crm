// Mock data for Google Calendar Integration (Frontend Only)
// TODO: Replace with actual API calls when backend is ready

import { GoogleConnection, CalendarEvent, CalendarSettings } from '@/types/calendar';
import { addDays, format, setHours, setMinutes, startOfWeek } from 'date-fns';

// ============= MOCK CONNECTION STATES =============

export const mockCalendarSettings: CalendarSettings = {
  syncPastDays: 30,
  syncFutureDays: 90,
  workingHoursStart: '08:00',
  workingHoursEnd: '18:00',
  workingDays: [1, 2, 3, 4, 5], // Mon-Fri
  defaultDuration: 45,
  bufferBetweenMeetings: 15,
};

export const mockConnectedState: GoogleConnection = {
  status: 'connected',
  email: 'usuario@gmail.com',
  connectedAt: '2025-01-15T10:30:00Z',
  lastSync: new Date().toISOString(),
  calendars: [
    { id: 'primary', name: 'Calendário Principal', selected: true, color: '#4285f4' },
    { id: 'work', name: 'Trabalho', selected: false, color: '#0b8043' },
    { id: 'personal', name: 'Pessoal', selected: false, color: '#8e24aa' },
    { id: 'holidays', name: 'Feriados no Brasil', selected: false, color: '#f6bf26' },
  ],
  settings: mockCalendarSettings,
};

export const mockDisconnectedState: GoogleConnection = {
  status: 'disconnected',
  email: null,
  connectedAt: null,
  lastSync: null,
  calendars: [],
  settings: null,
};

export const mockErrorState: GoogleConnection = {
  status: 'error',
  email: 'usuario@gmail.com',
  connectedAt: '2025-01-15T10:30:00Z',
  lastSync: '2025-01-18T14:00:00Z',
  calendars: [],
  settings: mockCalendarSettings,
  errorMessage: 'Token expirado. Por favor, reconecte sua conta.',
};

// ============= MOCK EVENTS =============

const today = new Date();
const weekStart = startOfWeek(today, { weekStartsOn: 1 });

export const mockCalendarEvents: CalendarEvent[] = [
  {
    id: 'evt-1',
    title: 'Reunião com João Silva',
    start: setMinutes(setHours(addDays(weekStart, 1), 9), 0).toISOString(),
    end: setMinutes(setHours(addDays(weekStart, 1), 10), 0).toISOString(),
    type: 'meeting',
    source: 'google',
    status: 'scheduled',
    location: 'Google Meet',
    meetingLink: 'https://meet.google.com/abc-defg-hij',
    attendees: [
      { name: 'João Silva', email: 'joao@email.com', status: 'confirmed' },
    ],
    contact: {
      id: 'contact-1',
      name: 'João Silva',
      email: 'joao@email.com',
    },
    notes: 'Discutir proposta comercial',
    createdBy: 'system',
    createdAt: '2025-01-20T14:32:00Z',
  },
  {
    id: 'evt-2',
    title: 'Consulta - Maria Oliveira',
    start: setMinutes(setHours(addDays(weekStart, 1), 10), 30).toISOString(),
    end: setMinutes(setHours(addDays(weekStart, 1), 11), 15).toISOString(),
    type: 'appointment',
    source: 'crm',
    status: 'scheduled',
    location: 'Presencial - Sala 3',
    attendees: [
      { name: 'Maria Oliveira', email: 'maria@email.com', status: 'confirmed' },
    ],
    contact: {
      id: 'contact-2',
      name: 'Maria Oliveira',
    },
    notes: 'Primeira consulta',
    createdBy: 'user-1',
    createdAt: '2025-01-19T16:00:00Z',
  },
  {
    id: 'evt-3',
    title: 'Almoço',
    start: setMinutes(setHours(addDays(weekStart, 1), 12), 0).toISOString(),
    end: setMinutes(setHours(addDays(weekStart, 1), 13), 0).toISOString(),
    type: 'block',
    source: 'google',
    status: 'scheduled',
    attendees: [],
    createdBy: 'user-1',
    createdAt: '2025-01-15T10:00:00Z',
  },
  {
    id: 'evt-4',
    title: 'Call com Pedro Lima',
    start: setMinutes(setHours(addDays(weekStart, 3), 11), 0).toISOString(),
    end: setMinutes(setHours(addDays(weekStart, 3), 11), 45).toISOString(),
    type: 'meeting',
    source: 'google',
    status: 'cancelled',
    location: 'Google Meet',
    meetingLink: 'https://meet.google.com/xyz-uvwx-rst',
    attendees: [
      { name: 'Pedro Lima', email: 'pedro@email.com', status: 'confirmed' },
    ],
    contact: {
      id: 'contact-3',
      name: 'Pedro Lima',
      email: 'pedro@email.com',
    },
    notes: 'Follow-up proposta',
    createdBy: 'system',
    createdAt: '2025-01-18T09:00:00Z',
  },
  {
    id: 'evt-5',
    title: 'Avaliação - Ana Santos',
    start: setMinutes(setHours(addDays(weekStart, 2), 14), 0).toISOString(),
    end: setMinutes(setHours(addDays(weekStart, 2), 15), 0).toISOString(),
    type: 'appointment',
    source: 'crm',
    status: 'cancelled',
    location: 'Presencial - Consultório 1',
    attendees: [
      { name: 'Ana Santos', email: 'ana@email.com', status: 'pending' },
    ],
    contact: {
      id: 'contact-4',
      name: 'Ana Santos',
      email: 'ana@email.com',
    },
    notes: 'Avaliação completa',
    createdBy: 'user-2',
    createdAt: '2025-01-17T11:00:00Z',
  },
  {
    id: 'evt-6',
    title: 'Reunião de equipe',
    start: setMinutes(setHours(addDays(weekStart, 4), 9), 0).toISOString(),
    end: setMinutes(setHours(addDays(weekStart, 4), 10), 0).toISOString(),
    type: 'meeting',
    source: 'google',
    status: 'scheduled',
    location: 'Sala de Reuniões',
    attendees: [],
    createdBy: 'user-1',
    createdAt: '2025-01-10T08:00:00Z',
  },
];

// ============= MOCK AVAILABILITY =============

export const generateMockAvailability = (month: string): Record<string, string[]> => {
  const [year, monthNum] = month.split('-').map(Number);
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const availability: Record<string, string[]> = {};

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, monthNum - 1, day);
    const dayOfWeek = date.getDay();
    const dateStr = format(date, 'yyyy-MM-dd');

    // No availability on weekends
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      availability[dateStr] = [];
      continue;
    }

    // Generate random available slots
    const baseSlots = ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00', '17:00'];
    const randomSlots = baseSlots.filter(() => Math.random() > 0.3);
    availability[dateStr] = randomSlots;
  }

  return availability;
};

export const mockUnavailableDates = [
  format(addDays(today, 7), 'yyyy-MM-dd'), // Next week
  format(addDays(today, 14), 'yyyy-MM-dd'), // Two weeks
];

// ============= MOCK INTEGRATIONS =============

export interface Integration {
  id: string;
  name: string;
  description: string;
  icon: string;
  status: 'connected' | 'disconnected' | 'coming_soon';
  connectedInfo?: {
    identifier: string;
    connectedAt: string;
  };
}

export const mockIntegrations: Integration[] = [
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'Sincronize sua agenda e permita agendamentos automáticos com leads',
    icon: 'calendar',
    status: 'disconnected',
  },
  {
    id: 'google-meet',
    name: 'Google Meet',
    description: 'Crie links de reunião automaticamente para seus agendamentos',
    icon: 'video',
    status: 'disconnected',
  },
  {
    id: 'chatwoot',
    name: 'Chatwoot',
    description: 'Integração de atendimento multicanal',
    icon: 'message-circle',
    status: 'connected',
    connectedInfo: {
      identifier: 'Conta #12345',
      connectedAt: '2025-01-10T10:00:00Z',
    },
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Business',
    description: 'Conecte seu WhatsApp Business para atendimento',
    icon: 'smartphone',
    status: 'coming_soon',
  },
];
