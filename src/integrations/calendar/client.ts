import { config } from '../../config.js';
import { getAccessToken } from '../gmail/auth.js';
import {
  CalendarIntegrationError,
  type CalendarAttendee,
  type CalendarEvent,
  type CalendarEventPage,
  type FreeBusyResult,
  type FreeBusyWindow,
} from './types.js';

const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const MAX_RETRIES = 3;

interface CalendarApiErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
    status?: unknown;
    errors?: Array<{ reason?: unknown; message?: unknown }>;
  };
}

interface CalendarApiDateTime {
  dateTime?: unknown;
  date?: unknown;
  timeZone?: unknown;
}

interface CalendarApiAttendee {
  email?: unknown;
  displayName?: unknown;
  responseStatus?: unknown;
  self?: unknown;
  organizer?: unknown;
}

interface CalendarApiOrganizer {
  email?: unknown;
  displayName?: unknown;
}

interface CalendarApiConferenceData {
  entryPoints?: Array<{
    entryPointType?: unknown;
    uri?: unknown;
  }>;
}

interface CalendarApiEvent {
  id?: unknown;
  summary?: unknown;
  description?: unknown;
  location?: unknown;
  start?: CalendarApiDateTime;
  end?: CalendarApiDateTime;
  status?: unknown;
  htmlLink?: unknown;
  attendees?: CalendarApiAttendee[];
  organizer?: CalendarApiOrganizer;
  conferenceData?: CalendarApiConferenceData;
  recurringEventId?: unknown;
}

interface CalendarApiEventsResponse {
  items?: CalendarApiEvent[];
  nextPageToken?: unknown;
}

interface CalendarApiFreeBusyResponse {
  calendars?: Record<
    string,
    {
      busy?: Array<{ start?: unknown; end?: unknown }>;
    }
  >;
}

interface CalendarRequestOptions {
  method?: 'GET' | 'POST';
  query?: URLSearchParams;
  body?: unknown;
}

function ensureCalendarEnabled(): void {
  if (!config.calendar.enabled) {
    throw new CalendarIntegrationError({
      code: 'calendar_disabled',
      message: 'Calendar integration is disabled in configuration.',
      safeMessage: 'Calendar integration is currently disabled. Run `tone onboard` to enable it.',
    });
  }

  if (!config.gmail.enabled) {
    throw new CalendarIntegrationError({
      code: 'gmail_not_connected',
      message: 'Calendar requires Gmail OAuth to be enabled.',
      safeMessage:
        'Calendar uses Gmail OAuth for authentication. Enable Gmail first, then enable Calendar.',
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function mapApiError(
  status: number,
  body: CalendarApiErrorBody,
): CalendarIntegrationError {
  const apiMessage =
    typeof body.error?.message === 'string'
      ? body.error.message
      : 'Unknown Calendar API error';
  const reason =
    body.error?.errors?.[0]?.reason;
  const reasonStr = typeof reason === 'string' ? reason.toLowerCase() : '';

  if (reasonStr.includes('quota') || reasonStr.includes('limitexceeded')) {
    return new CalendarIntegrationError({
      code: 'quota_exceeded',
      message: `Calendar API quota exceeded: ${apiMessage}`,
      safeMessage: 'Calendar quota limit reached. Please try again later.',
      status,
      retryable: true,
    });
  }

  if (status === 429 || reasonStr.includes('ratelimit')) {
    return new CalendarIntegrationError({
      code: 'rate_limited',
      message: `Calendar API rate limited: ${apiMessage}`,
      safeMessage: 'Calendar rate limit hit. Retrying shortly.',
      status,
      retryable: true,
    });
  }

  if (status === 403 && reasonStr.includes('insufficientpermissions')) {
    return new CalendarIntegrationError({
      code: 'missing_scope',
      message: `Calendar API missing scope: ${apiMessage}`,
      safeMessage:
        'Calendar access was not granted. Reconnect Gmail with calendar permissions.',
      status,
    });
  }

  return new CalendarIntegrationError({
    code: 'api_error',
    message: `Calendar API request failed (${status}): ${apiMessage}`,
    safeMessage: 'Calendar request failed. Please try again.',
    status,
    retryable: isRetryableStatus(status),
  });
}

function normalizeUrl(pathname: string, query?: URLSearchParams): string {
  const url = new URL(`${CALENDAR_API_BASE}${pathname}`);
  if (query) {
    url.search = query.toString();
  }
  return url.toString();
}

async function calendarRequest<T>(
  pathname: string,
  options: CalendarRequestOptions = {},
): Promise<T> {
  ensureCalendarEnabled();
  const method = options.method ?? 'GET';
  let lastError: CalendarIntegrationError | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const accessToken = await getAccessToken();
    let response: Response;

    try {
      response = await fetch(normalizeUrl(pathname, options.query), {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(options.body !== undefined
          ? { body: JSON.stringify(options.body) }
          : {}),
      });
    } catch (error) {
      lastError = new CalendarIntegrationError({
        code: 'network_error',
        message: 'Network failure while requesting Calendar API.',
        safeMessage:
          'Could not reach Google Calendar API. Check your network and try again.',
        cause: error,
        retryable: true,
      });

      if (attempt < MAX_RETRIES) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }

      throw lastError;
    }

    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? (JSON.parse(raw) as unknown) : {};
    } catch {
      parsed = {};
    }

    if (!response.ok) {
      lastError = mapApiError(
        response.status,
        (parsed ?? {}) as CalendarApiErrorBody,
      );

      if (lastError.retryable && attempt < MAX_RETRIES) {
        await sleep(250 * 2 ** (attempt - 1));
        continue;
      }

      throw lastError;
    }

    return parsed as T;
  }

  throw (
    lastError ??
    new CalendarIntegrationError({
      code: 'api_error',
      message: 'Calendar API request failed after retries.',
      safeMessage: 'Calendar request failed after retries.',
    })
  );
}

const VALID_RESPONSE_STATUSES = new Set([
  'needsAction',
  'declined',
  'tentative',
  'accepted',
]);

function toAttendee(raw: CalendarApiAttendee): CalendarAttendee {
  const email = typeof raw.email === 'string' ? raw.email : '';
  const responseStatus =
    typeof raw.responseStatus === 'string' &&
    VALID_RESPONSE_STATUSES.has(raw.responseStatus)
      ? (raw.responseStatus as CalendarAttendee['responseStatus'])
      : 'needsAction';

  return {
    email,
    responseStatus,
    ...(typeof raw.displayName === 'string'
      ? { displayName: raw.displayName }
      : {}),
    ...(raw.self === true ? { self: true } : {}),
    ...(raw.organizer === true ? { organizer: true } : {}),
  };
}

function parseDateTimeField(field: CalendarApiDateTime | undefined): {
  iso: string;
  allDay: boolean;
} {
  if (!field) {
    return { iso: new Date().toISOString(), allDay: false };
  }

  if (typeof field.date === 'string' && field.date.length > 0) {
    return { iso: field.date, allDay: true };
  }

  if (typeof field.dateTime === 'string' && field.dateTime.length > 0) {
    return { iso: field.dateTime, allDay: false };
  }

  return { iso: new Date().toISOString(), allDay: false };
}

function extractConferenceLink(
  data: CalendarApiConferenceData | undefined,
): string | undefined {
  if (!data?.entryPoints || !Array.isArray(data.entryPoints)) {
    return undefined;
  }

  for (const entry of data.entryPoints) {
    if (
      typeof entry.entryPointType === 'string' &&
      entry.entryPointType === 'video' &&
      typeof entry.uri === 'string'
    ) {
      return entry.uri;
    }
  }

  return undefined;
}

const VALID_EVENT_STATUSES = new Set([
  'confirmed',
  'tentative',
  'cancelled',
]);

function toCalendarEvent(raw: CalendarApiEvent): CalendarEvent {
  const id = typeof raw.id === 'string' ? raw.id : '';
  const summary = typeof raw.summary === 'string' ? raw.summary : '(No title)';

  const startField = parseDateTimeField(raw.start);
  const endField = parseDateTimeField(raw.end);

  const status =
    typeof raw.status === 'string' && VALID_EVENT_STATUSES.has(raw.status)
      ? (raw.status as CalendarEvent['status'])
      : 'confirmed';

  const attendees = Array.isArray(raw.attendees)
    ? raw.attendees.map(toAttendee)
    : [];

  const conferenceLink = extractConferenceLink(raw.conferenceData);

  return {
    id,
    summary,
    start: startField.iso,
    end: endField.iso,
    allDay: startField.allDay,
    status,
    attendees,
    ...(typeof raw.description === 'string'
      ? { description: raw.description }
      : {}),
    ...(typeof raw.location === 'string' ? { location: raw.location } : {}),
    ...(typeof raw.htmlLink === 'string' ? { htmlLink: raw.htmlLink } : {}),
    ...(raw.organizer
      ? {
          organizer: {
            email:
              typeof raw.organizer.email === 'string'
                ? raw.organizer.email
                : '',
            ...(typeof raw.organizer.displayName === 'string'
              ? { displayName: raw.organizer.displayName }
              : {}),
          },
        }
      : {}),
    ...(conferenceLink ? { conferenceLink } : {}),
    ...(typeof raw.recurringEventId === 'string'
      ? { recurringEventId: raw.recurringEventId }
      : {}),
  };
}

export interface ListEventsOptions {
  timeMin: string;
  timeMax: string;
  maxResults?: number;
  pageToken?: string;
  calendarId?: string;
  singleEvents?: boolean;
  orderBy?: 'startTime' | 'updated';
}

export async function listUpcomingEvents(
  options: ListEventsOptions,
): Promise<CalendarEventPage> {
  const calendarId = options.calendarId ?? 'primary';
  const maxResults = Math.max(1, Math.min(250, options.maxResults ?? 50));

  const query = new URLSearchParams({
    timeMin: options.timeMin,
    timeMax: options.timeMax,
    maxResults: String(maxResults),
    singleEvents: String(options.singleEvents ?? true),
    orderBy: options.orderBy ?? 'startTime',
  });

  if (options.pageToken?.trim()) {
    query.set('pageToken', options.pageToken.trim());
  }

  const response = await calendarRequest<CalendarApiEventsResponse>(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: 'GET', query },
  );

  const items = Array.isArray(response.items) ? response.items : [];
  const events = items
    .map(toCalendarEvent)
    .filter((event) => event.status !== 'cancelled');

  return {
    events,
    ...(typeof response.nextPageToken === 'string' &&
    response.nextPageToken.trim()
      ? { nextPageToken: response.nextPageToken.trim() }
      : {}),
  };
}

export async function getEventDetails(
  eventId: string,
  calendarId = 'primary',
): Promise<CalendarEvent> {
  const trimmedId = eventId.trim();
  if (!trimmedId) {
    throw new CalendarIntegrationError({
      code: 'invalid_response',
      message: 'Event id is required for getEventDetails.',
      safeMessage: 'Event reference is missing.',
    });
  }

  const raw = await calendarRequest<CalendarApiEvent>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(trimmedId)}`,
    { method: 'GET' },
  );

  return toCalendarEvent(raw);
}

export async function getFreeBusy(
  timeMin: string,
  timeMax: string,
  calendarIds: string[] = ['primary'],
): Promise<FreeBusyResult[]> {
  const response = await calendarRequest<CalendarApiFreeBusyResponse>(
    '/freeBusy',
    {
      method: 'POST',
      body: {
        timeMin,
        timeMax,
        items: calendarIds.map((id) => ({ id })),
      },
    },
  );

  const calendars = response.calendars ?? {};
  const results: FreeBusyResult[] = [];

  for (const calendarId of calendarIds) {
    const calendarData = calendars[calendarId];
    const busySlots: FreeBusyWindow[] = [];

    if (calendarData?.busy && Array.isArray(calendarData.busy)) {
      for (const slot of calendarData.busy) {
        const start = typeof slot.start === 'string' ? slot.start : '';
        const end = typeof slot.end === 'string' ? slot.end : '';
        if (start && end) {
          busySlots.push({ start, end });
        }
      }
    }

    results.push({
      calendarId,
      busy: busySlots,
    });
  }

  return results;
}
