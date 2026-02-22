export type InteractionIntent =
  | 'capture'
  | 'task'
  | 'draft'
  | 'chat'
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
  | 'implicit_draft_acceptance';

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
