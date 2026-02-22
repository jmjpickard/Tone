import type { InteractionIntent } from '../types.js';
import { captureSkill } from './capture.js';
import { chatSkill } from './chat.js';
import { draftSkill } from './draft.js';
import { taskSkill } from './task.js';
import type { SkillHandler } from './types.js';

const skillRegistry: Record<'capture' | 'task' | 'draft' | 'chat', SkillHandler> = {
  capture: captureSkill,
  task: taskSkill,
  draft: draftSkill,
  chat: chatSkill,
};

export function resolveSkill(intent: InteractionIntent): SkillHandler {
  if (intent === 'capture' || intent === 'task' || intent === 'draft' || intent === 'chat') {
    return skillRegistry[intent];
  }

  return skillRegistry.chat;
}
