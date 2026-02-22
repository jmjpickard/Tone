import type {
  InteractionInput,
  InteractionIntent,
  RouterResult,
  SkillDefinition,
} from '../types.js';

export interface SkillExecutionInput {
  text: string;
  input: InteractionInput;
  intent: InteractionIntent;
  entities: RouterResult['extractedEntities'];
}

export interface SkillExecutionContext {
  interactionId: string;
  userId: string;
  skillDefinitions: SkillDefinition[];
}

export type SkillStatus = 'success' | 'not_found' | 'needs_clarification' | 'error';

export interface SkillResult {
  status: SkillStatus;
  intent: InteractionIntent;
  response: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface SkillHandler {
  name: InteractionIntent;
  execute(input: SkillExecutionInput, context: SkillExecutionContext): Promise<SkillResult>;
}
