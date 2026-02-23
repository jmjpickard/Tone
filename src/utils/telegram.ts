import { Markup, type Context, type Telegraf } from 'telegraf';

export interface BriefingPayload {
  headline?: string;
  priorities: string[];
  activeThreads: string[];
  pendingTasks: string[];
  email?: {
    status: 'available' | 'unavailable';
    needsReply: string[];
    waitingOnThem: string[];
    staleThreads: string[];
    note?: string;
  };
}

export function formatBriefing(payload: BriefingPayload): string {
  const headline = payload.headline?.trim() || 'Daily Briefing';
  const priorities =
    payload.priorities.length > 0 ? payload.priorities.map((item) => `- ${item}`).join('\n') : '- None';
  const activeThreads =
    payload.activeThreads.length > 0
      ? payload.activeThreads.map((item) => `- ${item}`).join('\n')
      : '- None';
  const pendingTasks =
    payload.pendingTasks.length > 0
      ? payload.pendingTasks.map((item) => `- ${item}`).join('\n')
      : '- None';
  const emailSection =
    payload.email === undefined
      ? ''
      : payload.email.status === 'unavailable'
        ? ['*Email*', payload.email.note ? `- ${payload.email.note}` : '- Email triage unavailable.', ''].join(
            '\n',
          )
        : [
            '*Email*',
            '*Needs Reply*',
            payload.email.needsReply.length > 0 ? payload.email.needsReply.map((item) => `- ${item}`).join('\n') : '- None',
            '',
            '*Waiting On Them*',
            payload.email.waitingOnThem.length > 0
              ? payload.email.waitingOnThem.map((item) => `- ${item}`).join('\n')
              : '- None',
            '',
            '*Stale Threads*',
            payload.email.staleThreads.length > 0
              ? payload.email.staleThreads.map((item) => `- ${item}`).join('\n')
              : '- None',
            '',
          ].join('\n');

  const blocks = [
    `*${headline}*`,
    '',
    '*Priorities*',
    priorities,
    '',
    '*Active Threads*',
    activeThreads,
    '',
    '*Pending Tasks*',
    pendingTasks,
  ];

  if (emailSection) {
    blocks.push('', emailSection.trimEnd());
  }

  return blocks.join('\n');
}

export function formatTaskList(tasks: string[], title = 'Tasks'): string {
  if (tasks.length === 0) {
    return `*${title}*\n- No tasks right now.`;
  }

  const rows = tasks.map((task, index) => `${index + 1}. ${task}`);
  return `*${title}*\n${rows.join('\n')}`;
}

export async function sendWithReactions(
  ctx: Context,
  text: string,
  interactionId: string,
): Promise<void> {
  await ctx.reply(text, {
    reply_markup: Markup.inlineKeyboard([
      [
        Markup.button.callback('👍', `feedback:up:${interactionId}`),
        Markup.button.callback('👎', `feedback:down:${interactionId}`),
      ],
    ]).reply_markup,
  });
}

export async function downloadVoice(bot: Telegraf<Context>, fileId: string): Promise<Buffer> {
  const fileUrl = await bot.telegram.getFileLink(fileId);
  const response = await fetch(fileUrl.href);

  if (!response.ok) {
    throw new Error(`Failed to download voice file from Telegram: ${response.status}`);
  }

  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
}
