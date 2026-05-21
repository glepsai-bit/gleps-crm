import { prisma } from '../config/database';
import { CalendarEventType, CalendarEventStatus } from '@prisma/client';
import { PaginationParams, DateRangeFilter } from '../types';
import { NotFoundError, AppError } from '../utils/errors';
import { getPaginationMeta } from '../utils/helpers';

export interface CreateCalendarEventInput {
  accountId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  type?: CalendarEventType;
  location?: string;
  meetingLink?: string;
  contactId?: string;
  notes?: string;
  createdById?: string;
  attendees?: Array<{ name: string; email: string }>;
}

export interface UpdateCalendarEventInput {
  title?: string;
  startTime?: Date;
  endTime?: Date;
  type?: CalendarEventType;
  status?: CalendarEventStatus;
  location?: string;
  meetingLink?: string;
  contactId?: string;
  notes?: string;
}

export interface CalendarEventFilters extends DateRangeFilter {
  accountId: string;
  type?: CalendarEventType;
  status?: CalendarEventStatus;
  contactId?: string;
}

interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

type GoogleCredentialSource = 'db' | 'env' | 'mixed' | 'default' | 'none';

interface GoogleCredentialResolution {
  credentials: GoogleCredentials | null;
  missing: string[];
  source: GoogleCredentialSource;
}

interface GoogleOAuthState {
  accountId: string;
  userId: string;
  origin?: string;
}

class CalendarService {
  /**
   * Build a safe redirect URI when the account does not have one stored yet.
   */
  private getDefaultGoogleRedirectUri(): string {
    const envRedirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim();
    if (envRedirectUri) return envRedirectUri;

    const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:8080').trim().replace(/\/$/, '');
    return `${frontendUrl}/api/calendar/google/callback`;
  }

  /**
   * Resolve Google OAuth credentials from DB first, then env, field by field.
   * This avoids breaking old accounts that already have client ID/secret saved
   * but were created before redirect URI started being stored in the DB.
   */
  private async resolveGoogleCredentials(accountId: string): Promise<GoogleCredentialResolution> {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        googleClientId: true,
        googleClientSecret: true,
        googleRedirectUri: true,
      },
    });

    const dbClientId = account?.googleClientId?.trim() || '';
    const dbClientSecret = account?.googleClientSecret?.trim() || '';
    const dbRedirectUri = account?.googleRedirectUri?.trim() || '';

    const envClientId = (process.env.GOOGLE_CLIENT_ID || '').trim();
    const envClientSecret = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
    const envRedirectUri = (process.env.GOOGLE_REDIRECT_URI || '').trim();
    const defaultRedirectUri = this.getDefaultGoogleRedirectUri();

    const clientId = dbClientId || envClientId;
    const clientSecret = dbClientSecret || envClientSecret;
    const redirectUri = dbRedirectUri || envRedirectUri || defaultRedirectUri;

    const usesDb = Boolean(
      (clientId && clientId === dbClientId) ||
      (clientSecret && clientSecret === dbClientSecret) ||
      (redirectUri && redirectUri === dbRedirectUri)
    );
    const usesEnv = Boolean(
      (clientId && clientId === envClientId) ||
      (clientSecret && clientSecret === envClientSecret) ||
      (redirectUri && redirectUri === envRedirectUri)
    );
    const usesDefaultRedirect = !dbRedirectUri && !envRedirectUri && Boolean(redirectUri);

    let source: GoogleCredentialSource = 'none';
    if (usesDb && usesEnv) source = 'mixed';
    else if (usesDb) source = 'db';
    else if (usesEnv) source = 'env';
    else if (usesDefaultRedirect) source = 'default';

    console.log(
      `[GoogleCal] Credential resolution for account ${accountId}: source=${source}, ` +
      `db={clientId:${dbClientId ? 'SET' : 'EMPTY'}, secret:${dbClientSecret ? 'SET' : 'EMPTY'}, redirect:${dbRedirectUri ? 'SET' : 'EMPTY'}}, ` +
      `env={clientId:${envClientId ? 'SET' : 'EMPTY'}, secret:${envClientSecret ? 'SET' : 'EMPTY'}, redirect:${envRedirectUri ? 'SET' : 'EMPTY'}}, ` +
      `resolvedRedirect=${redirectUri ? 'SET' : 'EMPTY'}`
    );

    const missing: string[] = [];
    if (!clientId) missing.push('google_client_id');
    if (!clientSecret) missing.push('google_client_secret');
    if (!redirectUri) missing.push('google_redirect_uri');

    if (missing.length > 0) {
      console.warn(`[GoogleCal] Missing credentials for account ${accountId}: ${missing.join(', ')}`);
      return { credentials: null, missing, source };
    }

    return {
      credentials: {
        clientId,
        clientSecret,
        redirectUri,
      },
      missing: [],
      source,
    };
  }

  private buildProductionRedirectUri(requestOrigin?: string): string | null {
    const normalizedOrigin = (requestOrigin || '').trim().replace(/\/$/, '');
    if (!normalizedOrigin) return null;
    return `${normalizedOrigin}/api/calendar/google/callback`;
  }

  private encodeOAuthState(payload: GoogleOAuthState): string {
    return Buffer.from(JSON.stringify(payload)).toString('base64');
  }

  private decodeOAuthState(stateBase64: string): GoogleOAuthState {
    try {
      const decoded = JSON.parse(Buffer.from(stateBase64, 'base64').toString('utf-8')) as GoogleOAuthState;
      if (!decoded.accountId || !decoded.userId) throw new Error('Missing fields');
      return decoded;
    } catch {
      throw new AppError('State OAuth inválido', 400, 'INVALID_STATE');
    }
  }

  /**
   * Get Google OAuth credentials from the account's DB record or env vars
   */
  private async getGoogleCredentials(accountId: string): Promise<GoogleCredentials | null> {
    const { credentials } = await this.resolveGoogleCredentials(accountId);
    return credentials;
  }

  /**
   * List calendar events
   */
  async list(filters: CalendarEventFilters, pagination: PaginationParams) {
    const where: any = {
      accountId: filters.accountId,
    };

    if (filters.type) where.type = filters.type;
    if (filters.status) where.status = filters.status;
    if (filters.contactId) where.contactId = filters.contactId;

    if (filters.startDate || filters.endDate) {
      where.startTime = {};
      if (filters.startDate) where.startTime.gte = filters.startDate;
      if (filters.endDate) where.startTime.lte = filters.endDate;
    }

    const [events, total] = await Promise.all([
      prisma.calendarEvent.findMany({
        where,
        orderBy: { startTime: 'asc' },
        skip: pagination.offset,
        take: pagination.limit,
        include: {
          contact: { select: { id: true, nome: true, telefone: true } },
          createdBy: { select: { id: true, nome: true } },
          attendees: true,
        },
      }),
      prisma.calendarEvent.count({ where }),
    ]);

    return {
      data: events,
      meta: getPaginationMeta(total, pagination),
    };
  }

  /**
   * Get event by ID
   */
  async getById(id: string, accountId?: string) {
    const where: any = { id };
    if (accountId) where.accountId = accountId;

    const event = await prisma.calendarEvent.findFirst({
      where,
      include: {
        contact: { select: { id: true, nome: true, telefone: true, email: true } },
        createdBy: { select: { id: true, nome: true, email: true } },
        attendees: true,
      },
    });

    if (!event) throw new NotFoundError('Evento');
    return event;
  }

  /**
   * Create calendar event
   */
  async create(input: CreateCalendarEventInput) {
    const event = await prisma.calendarEvent.create({
      data: {
        accountId: input.accountId,
        title: input.title,
        startTime: input.startTime,
        endTime: input.endTime,
        type: input.type || 'appointment',
        location: input.location,
        meetingLink: input.meetingLink,
        contactId: input.contactId,
        notes: input.notes,
        createdById: input.createdById,
        attendees: input.attendees ? { create: input.attendees } : undefined,
      },
      include: { attendees: true },
    });
    return event;
  }

  /**
   * Update calendar event
   */
  async update(id: string, input: UpdateCalendarEventInput, accountId: string) {
    await this.getById(id, accountId);
    const event = await prisma.calendarEvent.update({
      where: { id },
      data: {
        title: input.title,
        startTime: input.startTime,
        endTime: input.endTime,
        type: input.type,
        status: input.status,
        location: input.location,
        meetingLink: input.meetingLink,
        contactId: input.contactId,
        notes: input.notes,
      },
      include: { attendees: true },
    });
    return event;
  }

  /**
   * Delete calendar event
   */
  async delete(id: string, accountId: string) {
    await this.getById(id, accountId);
    await prisma.calendarEvent.delete({ where: { id } });
  }

  /**
   * Get Google OAuth URL — credentials from DB
   */
  async getGoogleAuthUrl(accountId: string, userId: string, requestOrigin?: string): Promise<string> {
    const creds = await this.getGoogleCredentials(accountId);
    if (!creds) {
      throw new AppError(
        'Google Calendar não configurado para esta conta. O Super Admin deve configurar as credenciais Google na página de controle da conta.',
        422,
        'GOOGLE_NOT_CONFIGURED'
      );
    }

    const scopes = ['https://www.googleapis.com/auth/calendar.readonly'];
    const productionRedirectUri = this.buildProductionRedirectUri(requestOrigin);
    const redirectUri = productionRedirectUri || creds.redirectUri;
    const statePayload = this.encodeOAuthState({ accountId, userId, origin: requestOrigin });
    const params = new URLSearchParams({
      client_id: creds.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state: statePayload,
    });

    console.log(`[GoogleCal] Auth URL generated for account ${accountId} using redirect ${redirectUri}`);

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  /**
   * Handle Google OAuth callback — credentials from DB
   */
  async handleGoogleCallback(code: string, stateBase64: string) {
    const decodedState = this.decodeOAuthState(stateBase64);
    const { accountId, userId, origin } = decodedState;

    const creds = await this.getGoogleCredentials(accountId);
    if (!creds) {
      throw new AppError('Google Calendar não configurado para esta conta.', 422, 'GOOGLE_NOT_CONFIGURED');
    }

    const productionRedirectUri = this.buildProductionRedirectUri(origin);
    const redirectUri = productionRedirectUri || creds.redirectUri;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error('Falha ao obter tokens do Google');
    }

    const tokens: any = await tokenResponse.json();

    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo: any = await userInfoResponse.json();

    // Upsert by userId (each user has their own token)
    await prisma.googleCalendarToken.upsert({
      where: { userId },
      create: {
        accountId,
        userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        connectedEmail: userInfo.email,
        calendarId: 'primary',
      },
      update: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || undefined,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        connectedEmail: userInfo.email,
      },
    });

    return { success: true, email: userInfo.email, origin: origin || null };
  }

  /**
   * Disconnect Google Calendar
   */
  async disconnectGoogle(accountId: string, userId: string) {
    await prisma.googleCalendarToken.delete({ where: { userId } }).catch(() => {});
    await prisma.calendarEvent.updateMany({
      where: { accountId, source: 'google', createdById: userId },
      data: { googleEventId: null, googleCalendarId: null },
    });
  }

  /**
   * Get Google Calendar connection status — credentials from DB + env fallback
   */
  async getGoogleStatus(accountId: string, userId: string) {
    const { credentials: creds, source, missing } = await this.resolveGoogleCredentials(accountId);

    if (!creds) {
      return {
        connected: false,
        configured: false,
        missing,
        source,
      };
    }

    const token = await prisma.googleCalendarToken.findUnique({ where: { userId } });

    if (!token) {
      return { connected: false, configured: true, missing: [], source };
    }

    return {
      connected: true,
      configured: true,
      missing: [],
      email: token.connectedEmail,
      expiresAt: token.expiresAt,
      needsReauth: token.expiresAt < new Date(),
      source,
    };
  }

  /**
   * Sync with Google Calendar — credentials from DB
   */
  async syncWithGoogle(accountId: string, userId: string) {
    const token = await prisma.googleCalendarToken.findUnique({ where: { userId } });
    if (!token) throw new Error('Google Calendar não conectado');

    let accessToken = token.accessToken;
    if (token.expiresAt < new Date()) {
      accessToken = await this.refreshGoogleToken(accountId, userId, token.refreshToken);
    }

    const now = new Date();
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const oneMonthAhead = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?` +
      new URLSearchParams({
        timeMin: oneMonthAgo.toISOString(),
        timeMax: oneMonthAhead.toISOString(),
        singleEvents: 'true',
        orderBy: 'startTime',
      }),
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!response.ok) throw new Error('Falha ao sincronizar com Google Calendar');

    const data: any = await response.json();
    const googleEvents = data.items || [];

    let created = 0;
    let updated = 0;

    for (const gEvent of googleEvents) {
      if (gEvent.status === 'cancelled') continue;
      const startTime = gEvent.start?.dateTime || gEvent.start?.date;
      const endTime = gEvent.end?.dateTime || gEvent.end?.date;
      if (!startTime || !endTime) continue;

      const existingId = await this.getEventIdByGoogleId(gEvent.id, accountId);

      const eventData = {
        title: gEvent.summary || 'Sem título',
        startTime: new Date(startTime),
        endTime: new Date(endTime),
        location: gEvent.location || null,
        meetingLink: gEvent.hangoutLink || null,
      };

      if (existingId) {
        await prisma.calendarEvent.update({
          where: { id: existingId },
          data: eventData,
        });
        updated++;
      } else {
        await prisma.calendarEvent.create({
          data: {
            ...eventData,
            accountId,
            createdById: userId,
            type: 'meeting',
            source: 'google',
            googleEventId: gEvent.id,
            googleCalendarId: 'primary',
          },
        });
        created++;
      }
    }

    return { synced: created + updated, created, updated };
  }

  private async getEventIdByGoogleId(googleEventId: string, accountId: string): Promise<string | null> {
    const event = await prisma.calendarEvent.findFirst({
      where: { googleEventId, accountId },
      select: { id: true },
    });
    return event?.id || null;
  }

  private async refreshGoogleToken(accountId: string, userId: string, refreshToken: string): Promise<string> {
    const creds = await this.getGoogleCredentials(accountId);
    if (!creds) {
      throw new AppError('Google Calendar não configurado para esta conta.', 422, 'GOOGLE_NOT_CONFIGURED');
    }

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    });

    if (!response.ok) throw new Error('Falha ao renovar token do Google');

    const tokens: any = await response.json();

    await prisma.googleCalendarToken.update({
      where: { userId },
      data: {
        accessToken: tokens.access_token,
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      },
    });

    return tokens.access_token;
  }
}

export const calendarService = new CalendarService();
