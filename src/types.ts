export type InteractionIntent =
  | 'capture'
  | 'task'
  | 'draft'
  | 'chat'
  | 'email'
  | 'calendar'
  | 'rollback'
  | 'introspection'
  | 'unknown';

export type InteractionInput =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'voice';
      transcript: string;
      mimeType?: string;
    };

export type FeedbackSignal = 'thumbs_up' | 'thumbs_down' | 'correction' | 'implicit';

export interface Interaction {
  id: string;
  timestamp: string;
  userId: string;
  input: InteractionInput;
  intent: InteractionIntent;
  skillUsed: string;
  response: string;
  feedbackSignal: FeedbackSignal | null;
}

export interface SkillDefinition {
  name: string;
  triggers: string[];
  inputSchema: string;
  outputSchema: string;
  constraints: string[];
  immutable: boolean;
}

export type FeedbackEventType =
  | 'correction'
  | 'thumbs_up'
  | 'thumbs_down'
  | 'implicit_engagement_timing'
  | 'implicit_draft_acceptance'
  | 'email_draft_generated'
  | 'email_send_confirmed'
  | 'email_send_canceled'
  | 'email_send_failed'
  | 'email_triage_accepted'
  | 'email_snooze'
  | 'email_marked_done'
  | 'email_marked_no_reply'
  | 'email_ignored_urgent';

export interface FeedbackEvent {
  id: string;
  timestamp: string;
  interactionId?: string;
  type: FeedbackEventType;
  details:
    | {
        correction: {
          previousBehavior: string;
          desiredBehavior: string;
          learnedRule: string;
        };
      }
    | {
        reaction: 'thumbs_up' | 'thumbs_down';
      }
    | {
        implicitSignal: 'engagement_timing' | 'draft_acceptance';
        value: number;
        note?: string;
      }
    | {
        emailAction: {
          action: 'draft_generated' | 'send_confirmed' | 'send_canceled' | 'send_failed';
          draftRef: string;
          threadId?: string;
          confirmationId?: string;
          note?: string;
        };
      }
    | {
        triageAction: {
          action: 'triage_accepted' | 'snooze' | 'marked_done' | 'marked_no_reply' | 'ignored_urgent';
          threadId: string;
          snoozedUntil?: string;
          note?: string;
        };
      };
}

export interface VaultConfig {
  rootPath: string;
  inboxDir: string;
  threadsDir: string;
  tasksDir: string;
  projectsDir: string;
  peopleDir: string;
  dailyDir: string;
  skillsDir: string;
  configDir: string;
  feedbackDir: string;
}

export interface LLMTier {
  id: 'tier1' | 'tier2' | 'tier3';
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface RouterResult {
  intent: InteractionIntent;
  confidence: number;
  extractedEntities: Record<string, string | number | boolean | null>;
}
