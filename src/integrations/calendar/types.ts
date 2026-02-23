export const CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
] as const;

export type CalendarScope = (typeof CALENDAR_SCOPES)[number];

export type CalendarErrorCode =
  | 'calendar_disabled'
  | 'gmail_not_connected'
  | 'missing_scope'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'network_error'
  | 'invalid_response'
  | 'api_error';

export interface CalendarErrorOptions {
  code: CalendarErrorCode;
  message: string;
  safeMessage: string;
  status?: number;
  retryable?: boolean;
  cause?: unknown;
}

export class CalendarIntegrationError extends Error {
  readonly code: CalendarErrorCode;
  readonly safeMessage: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(options: CalendarErrorOptions) {
    super(options.message);
    this.name = 'CalendarIntegrationError';
    this.code = options.code;
    this.safeMessage = options.safeMessage;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    if (options.cause !== undefined) {
      (this as Error & { cause: unknown }).cause = options.cause;
    }
  }
}

export interface CalendarAttendee {
  email: string;
  displayName?: string;
  responseStatus: 'needsAction' | 'declined' | 'tentative' | 'accepted';
  self?: boolean;
  organizer?: boolean;
}

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  start: string;
  end: string;
  allDay: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink?: string;
  attendees: CalendarAttendee[];
  organizer?: {
    email: string;
    displayName?: string;
  };
  conferenceLink?: string;
  recurringEventId?: string;
}

export interface CalendarEventPage {
  events: CalendarEvent[];
  nextPageToken?: string;
}

export interface FreeBusyWindow {
  start: string;
  end: string;
}

export interface FreeBusyResult {
  calendarId: string;
  busy: FreeBusyWindow[];
}
