import type { InteractionIntent } from '../types.js';
import { calendarSkill } from './calendar.js';
import { captureSkill } from './capture.js';
import { chatSkill } from './chat.js';
import { draftSkill } from './draft.js';
import { emailSkill } from './email.js';
import { taskSkill } from './task.js';
import type { SkillHandler } from './types.js';

const skillRegistry: Record<'capture' | 'task' | 'draft' | 'email' | 'calendar' | 'chat', SkillHandler> = {
  capture: captureSkill,
  task: taskSkill,
  draft: draftSkill,
  email: emailSkill,
  calendar: calendarSkill,
  chat: chatSkill,
};

export function resolveSkill(intent: InteractionIntent): SkillHandler {
  if (
    intent === 'capture' ||
    intent === 'task' ||
    intent === 'draft' ||
    intent === 'email' ||
    intent === 'calendar' ||
    intent === 'chat'
  ) {
    return skillRegistry[intent];
  }

  return skillRegistry.chat;
}
