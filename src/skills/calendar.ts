import { config } from '../config.js';
import {
  getEventDetails,
  listUpcomingEvents,
} from '../integrations/calendar/client.js';
import { CalendarIntegrationError, type CalendarEvent } from '../integrations/calendar/types.js';
import type { SkillExecutionInput, SkillHandler, SkillResult } from './types.js';

type CalendarAction = 'today' | 'week' | 'meeting_prep' | 'status';

function detectAction(input: SkillExecutionInput): CalendarAction {
  const entityAction =
    typeof input.entities.action === 'string'
      ? input.entities.action.trim().toLowerCase()
      : '';

  if (
    entityAction === 'today' ||
    entityAction === 'week' ||
    entityAction === 'meeting_prep'
  ) {
    return entityAction;
  }

  const lowered = input.text.toLowerCase();

  if (/\b(week|this week|next week|upcoming week|weekly)\b/.test(lowered)) {
    return 'week';
  }

  if (/\b(meeting prep|prepare for|prep for|brief me on)\b/.test(lowered)) {
    return 'meeting_prep';
  }

  if (
    /\b(today|today'?s|agenda|schedule|what'?s on|what do i have)\b/.test(
      lowered,
    )
  ) {
    return 'today';
  }

  return 'today';
}

function extractEventId(input: SkillExecutionInput): string {
  const entityEventId =
    typeof input.entities.eventId === 'string'
      ? input.entities.eventId.trim()
      : '';
  if (entityEventId) {
    return entityEventId;
  }

  const match = input.text.match(
    /(?:event|meeting)\s*(?:id|ref)?\s*[:#]?\s*([a-zA-Z0-9_-]{8,})/i,
  );
  return match?.[1]?.trim() ?? '';
}

function formatTime(iso: string, allDay: boolean): string {
  if (allDay) {
    return 'All day';
  }

  try {
    const date = new Date(iso);
    return date.toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: config.timezone,
    });
  } catch {
    return iso;
  }
}

function formatEventLine(event: CalendarEvent): string {
  const time = formatTime(event.start, event.allDay);
  const endTime = event.allDay ? '' : ` - ${formatTime(event.end, false)}`;
  const location = event.location ? ` | ${event.location}` : '';
  const link = event.conferenceLink ? ` | ${event.conferenceLink}` : '';
  return `- ${time}${endTime}: ${event.summary}${location}${link}`;
}

function formatEventDetail(event: CalendarEvent): string {
  const lines: string[] = [];
  lines.push(`*${event.summary}*`);
  lines.push('');

  const startTime = formatTime(event.start, event.allDay);
  const endTime = event.allDay ? '' : ` - ${formatTime(event.end, false)}`;
  lines.push(`Time: ${startTime}${endTime}`);

  if (event.location) {
    lines.push(`Location: ${event.location}`);
  }

  if (event.conferenceLink) {
    lines.push(`Join: ${event.conferenceLink}`);
  }

  if (event.organizer) {
    const name = event.organizer.displayName ?? event.organizer.email;
    lines.push(`Organizer: ${name}`);
  }

  if (event.attendees.length > 0) {
    lines.push('');
    lines.push('Attendees:');
    for (const attendee of event.attendees) {
      const name = attendee.displayName ?? attendee.email;
      const status = attendee.responseStatus;
      const selfTag = attendee.self ? ' (you)' : '';
      lines.push(`- ${name} [${status}]${selfTag}`);
    }
  }

  if (event.description) {
    lines.push('');
    lines.push('Description:');
    lines.push(event.description.slice(0, 500));
  }

  return lines.join('\n');
}

function dayBounds(offsetDays: number): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() + offsetDays);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function weekBounds(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);

  const syncDays = config.calendar.enabled ? config.calendar.syncWindowDays : 7;
  const end = new Date(start);
  end.setDate(end.getDate() + syncDays);

  return {
    start: start.toISOString(),
    end: end.toISOString(),
  };
}

function groupByDate(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const groups = new Map<string, CalendarEvent[]>();

  for (const event of events) {
    let dateKey: string;
    if (event.allDay) {
      dateKey = event.start;
    } else {
      try {
        dateKey = new Date(event.start).toLocaleDateString('en-CA', {
          timeZone: config.timezone,
        });
      } catch {
        dateKey = event.start.slice(0, 10);
      }
    }

    const existing = groups.get(dateKey);
    if (existing) {
      existing.push(event);
    } else {
      groups.set(dateKey, [event]);
    }
  }

  return groups;
}

function formatDayLabel(dateStr: string): string {
  try {
    const date = new Date(`${dateStr}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (date.getTime() === today.getTime()) {
      return 'Today';
    }
    if (date.getTime() === tomorrow.getTime()) {
      return 'Tomorrow';
    }

    return date.toLocaleDateString('en-GB', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

function buildUnavailableResponse(error: unknown): string {
  if (error instanceof CalendarIntegrationError) {
    return error.safeMessage;
  }
  return 'Calendar action failed due to an unexpected error.';
}

async function handleTodayAction(): Promise<SkillResult> {
  const bounds = dayBounds(0);
  const page = await listUpcomingEvents({
    timeMin: bounds.start,
    timeMax: bounds.end,
  });

  if (page.events.length === 0) {
    return {
      status: 'success',
      intent: 'calendar',
      response: 'No events on your calendar today.',
    };
  }

  const lines = [
    `*Today's Agenda* (${page.events.length} event${page.events.length === 1 ? '' : 's'})`,
    '',
    ...page.events.map(formatEventLine),
  ];

  return {
    status: 'success',
    intent: 'calendar',
    response: lines.join('\n'),
    metadata: { eventCount: page.events.length },
  };
}

async function handleWeekAction(): Promise<SkillResult> {
  const bounds = weekBounds();
  const page = await listUpcomingEvents({
    timeMin: bounds.start,
    timeMax: bounds.end,
    maxResults: 100,
  });

  if (page.events.length === 0) {
    return {
      status: 'success',
      intent: 'calendar',
      response: 'No events on your calendar this week.',
    };
  }

  const grouped = groupByDate(page.events);
  const lines: string[] = ['*Week Preview*', ''];

  for (const [dateStr, events] of grouped) {
    lines.push(`*${formatDayLabel(dateStr)}*`);
    for (const event of events) {
      lines.push(formatEventLine(event));
    }
    lines.push('');
  }

  return {
    status: 'success',
    intent: 'calendar',
    response: lines.join('\n').trim(),
    metadata: { eventCount: page.events.length },
  };
}

async function handleMeetingPrepAction(
  input: SkillExecutionInput,
): Promise<SkillResult> {
  const eventId = extractEventId(input);

  if (eventId) {
    const event = await getEventDetails(eventId);
    return {
      status: 'success',
      intent: 'calendar',
      response: formatEventDetail(event),
      metadata: { eventId: event.id },
    };
  }

  const bounds = dayBounds(0);
  const page = await listUpcomingEvents({
    timeMin: new Date().toISOString(),
    timeMax: bounds.end,
    maxResults: 1,
  });

  const nextEvent = page.events[0];
  if (!nextEvent) {
    return {
      status: 'success',
      intent: 'calendar',
      response: 'No upcoming meetings today to prep for.',
    };
  }

  return {
    status: 'success',
    intent: 'calendar',
    response: formatEventDetail(nextEvent),
    metadata: { eventId: nextEvent.id },
  };
}

export const calendarSkill: SkillHandler = {
  name: 'calendar',
  async execute(input): Promise<SkillResult> {
    const action = detectAction(input);

    try {
      if (action === 'today') {
        return await handleTodayAction();
      }

      if (action === 'week') {
        return await handleWeekAction();
      }

      if (action === 'meeting_prep') {
        return await handleMeetingPrepAction(input);
      }

      return await handleTodayAction();
    } catch (error) {
      return {
        status: 'error',
        intent: 'calendar',
        response: buildUnavailableResponse(error),
      };
    }
  },
};
