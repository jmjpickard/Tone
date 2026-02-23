import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Markup, Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from './config.js';
import {
  detectCorrection,
  findMostRecentInteractionForUser,
  logCorrection,
  logFeedbackSignal,
  logInteraction,
} from './feedback.js';
import { generateIntrospectionSummary } from './introspection.js';
import { scheduleBriefing, scheduleEveningRecap, scheduleMiddayReminder, trackBriefingEngagement } from './loops/briefing.js';
import { scheduleNightly } from './loops/nightly.js';
import { handleWeeklyApprovalDecision, scheduleWeekly } from './loops/weekly.js';
import { cancelRollback, confirmRollback, handleRollbackRequest } from './rollback.js';
import { route } from './router.js';
import { cancelPendingEmailSend, confirmPendingEmailSend } from './skills/email.js';
import { resolveSkill } from './skills/index.js';
import { loadSkills } from './skills/loader.js';
import type { SkillResult } from './skills/types.js';
import { createTranscriber, type TranscriptionError } from './transcriber.js';
import type { Interaction, InteractionInput, RouterResult, SkillDefinition } from './types.js';
import { downloadVoice, sendWithReactions } from './utils/telegram.js';

const bot = new Telegraf(config.telegramBotToken);
const transcriber = createTranscriber();

function extractInputText(input: InteractionInput): string {
  return input.type === 'text' ? input.text : input.transcript;
}

function normalizeInputText(input: InteractionInput): string {
  return extractInputText(input).trim();
}

function defaultRouting(text: string): RouterResult {
  return {
    intent: 'chat',
    confidence: text.length > 0 ? 0.5 : 1,
    extractedEntities: {},
  };
}

async function processInteraction(
  ctx: Context,
  interactionId: string,
  input: InteractionInput,
  responsePrefix = '',
): Promise<void> {
  const userId = String(ctx.from?.id ?? 'unknown');
  const timestamp = new Date().toISOString();
  const normalizedText = normalizeInputText(input);

  if (normalizedText.length === 0) {
    await ctx.reply('Please send a non-empty message.');
    return;
  }

  try {
    await trackBriefingEngagement(userId);
  } catch (error) {
    console.error('[tone] failed to track briefing engagement', error);
  }

  let skillDefinitions: SkillDefinition[] = [];
  try {
    skillDefinitions = await loadSkills();
  } catch (error) {
    console.error('[tone] failed to load skills', error);
  }

  let routing = defaultRouting(normalizedText);
  try {
    routing = await route(normalizedText, {
      skillDefinitions,
      confidenceThreshold: config.routing.confidenceThreshold,
    });
  } catch (error) {
    console.error('[tone] routing error', error);
  }

  if (routing.intent !== 'rollback' && routing.intent !== 'introspection') {
    try {
      const previousInteraction = await findMostRecentInteractionForUser(userId);
      const detectedCorrection = detectCorrection({
        text: normalizedText,
        previousInteraction,
      });

      if (detectedCorrection) {
        await logCorrection({
          userId,
          ...(detectedCorrection.interactionId
            ? { interactionId: detectedCorrection.interactionId }
            : {}),
          previousBehavior: detectedCorrection.previousBehavior,
          desiredBehavior: detectedCorrection.desiredBehavior,
          learnedRule: detectedCorrection.learnedRule,
        });
      }
    } catch (error) {
      console.error('[tone] correction detection/logging failed', error);
    }
  }

  if (routing.intent === 'rollback') {
    let responseText = 'I could not process that rollback request.';

    try {
      const rollbackResult = await handleRollbackRequest({
        userId,
        text: normalizedText,
        entities: routing.extractedEntities,
      });
      responseText = rollbackResult.message;

      if (rollbackResult.status === 'prepared' && rollbackResult.pendingId) {
        await ctx.reply(responseText, {
          reply_markup: Markup.inlineKeyboard([
            [
              Markup.button.callback('Confirm rollback', `rollback:confirm:${rollbackResult.pendingId}`),
              Markup.button.callback('Cancel', `rollback:cancel:${rollbackResult.pendingId}`),
            ],
          ]).reply_markup,
        });
      } else {
        await sendWithReactions(ctx, responseText, interactionId);
      }
    } catch (error) {
      console.error('[tone] rollback intent handling failed', error);
      responseText = 'I could not process that rollback request. Please provide a valid reference.';
      await ctx.reply(responseText);
    }

    try {
      await logInteraction({
        id: interactionId,
        timestamp,
        userId,
        input,
        intent: routing.intent,
        skillUsed: 'rollback',
        response: responseText,
        feedbackSignal: null,
      });
    } catch (error) {
      console.error('[tone] failed to log rollback interaction', error);
    }

    return;
  }

  if (routing.intent === 'introspection') {
    let responseText = 'I could not generate an evolution summary right now.';

    try {
      const introspection = await generateIntrospectionSummary({
        text: normalizedText,
        entities: routing.extractedEntities,
      });
      responseText = `What changed since ${introspection.fromRef}:\n\n${introspection.summary}`;
      await sendWithReactions(ctx, responseText, interactionId);
    } catch (error) {
      console.error('[tone] introspection intent handling failed', error);
      responseText = 'I could not generate an evolution summary. Check that your references exist.';
      await ctx.reply(responseText);
    }

    try {
      await logInteraction({
        id: interactionId,
        timestamp,
        userId,
        input,
        intent: routing.intent,
        skillUsed: 'introspection',
        response: responseText,
        feedbackSignal: null,
      });
    } catch (error) {
      console.error('[tone] failed to log introspection interaction', error);
    }

    return;
  }

  let selectedSkill = resolveSkill(routing.intent);
  let skillResult: SkillResult;

  try {
    skillResult = await selectedSkill.execute(
      {
        text: normalizedText,
        input,
        intent: routing.intent,
        entities: routing.extractedEntities,
      },
      {
        interactionId,
        userId,
        skillDefinitions,
      },
    );
  } catch (error) {
    console.error('[tone] skill execution error', {
      intent: routing.intent,
      skill: selectedSkill.name,
      error,
    });

    selectedSkill = resolveSkill('chat');
    try {
      skillResult = await selectedSkill.execute(
        {
          text: normalizedText,
          input,
          intent: 'chat',
          entities: {},
        },
        {
          interactionId,
          userId,
          skillDefinitions,
        },
      );
    } catch (fallbackError) {
      console.error('[tone] chat fallback execution error', fallbackError);
      skillResult = {
        status: 'error',
        intent: 'chat',
        response: 'I hit an internal error while processing that request.',
      };
    }
  }

  const skillResponse = skillResult.response.trim() || 'I do not have a response yet.';
  const responseText = responsePrefix.length > 0 ? `${responsePrefix}\n${skillResponse}` : skillResponse;
  const emailSendConfirmationId =
    typeof skillResult.metadata?.emailSendConfirmationId === 'string'
      ? skillResult.metadata.emailSendConfirmationId
      : '';

  try {
    if (emailSendConfirmationId) {
      await ctx.reply(responseText, {
        reply_markup: Markup.inlineKeyboard([
          [
            Markup.button.callback('Confirm send', `email-send:confirm:${emailSendConfirmationId}`),
            Markup.button.callback('Cancel', `email-send:cancel:${emailSendConfirmationId}`),
          ],
        ]).reply_markup,
      });
    } else {
      await sendWithReactions(ctx, responseText, interactionId);
    }
  } catch (error) {
    console.error('[tone] failed to send reply', error);
    await ctx.reply('I generated a response but could not send it with feedback controls.');
  }

  const interaction: Interaction = {
    id: interactionId,
    timestamp,
    userId,
    input,
    intent: routing.intent,
    skillUsed: selectedSkill.name,
    response: skillResponse,
    feedbackSignal: null,
  };

  try {
    await logInteraction(interaction);
  } catch (error) {
    console.error('[tone] failed to log interaction', error);
  }
}

bot.start(async (ctx) => {
  await ctx.reply(
    [
      'Tone is online and ready to support you.',
      '',
      'To personalize quickly, tell me:',
      '1) What you are trying to improve right now',
      '2) How you like to work (planning cadence, communication style)',
      '3) What you want me to take off your plate this week',
      '',
      'I will adapt around your answers and keep learning from each interaction.',
    ].join('\n'),
  );
});

bot.on(message('text'), async (ctx) => {
  const interactionId = randomUUID();
  const messageText = ctx.message.text.trim();

  if (messageText.length === 0) {
    await ctx.reply('Please send a non-empty message.');
    return;
  }

  await processInteraction(ctx, interactionId, {
    type: 'text',
    text: messageText,
  });
});

bot.on(message('voice'), async (ctx) => {
  const interactionId = randomUUID();

  try {
    const voiceBuffer = await downloadVoice(bot, ctx.message.voice.file_id);
    const transcript = await transcriber.transcribe(voiceBuffer, 'audio/ogg');

    if (!transcript.text.trim()) {
      await ctx.reply('I could not detect speech in that voice note.');
      return;
    }

    const prefix = `[${transcript.provider} transcription ${Math.round(transcript.confidence * 100)}%]`;

    await processInteraction(
      ctx,
      interactionId,
      {
        type: 'voice',
        transcript: transcript.text,
        mimeType: 'audio/ogg',
      },
      prefix,
    );
  } catch (error) {
    const transcriptionError = error as Partial<TranscriptionError>;
    console.error('[tone] voice processing error', {
      message: transcriptionError.message,
      code: transcriptionError.code,
      status: transcriptionError.status,
      details: transcriptionError.details,
    });
    if (transcriptionError.code === 'configuration_error') {
      await ctx.reply(
        'Voice notes are disabled in your current setup. Run `tone onboard` to enable Deepgram or Voxtral.',
      );
      return;
    }

    await ctx.reply('I could not process that voice note. Please try again or send text instead.');
  }
});

bot.on('callback_query', async (ctx) => {
  const callbackQuery = ctx.callbackQuery;
  if (!('data' in callbackQuery) || typeof callbackQuery.data !== 'string') {
    await ctx.answerCbQuery('Unsupported callback.');
    return;
  }

  const rollbackMatch = callbackQuery.data.match(/^rollback:(confirm|cancel):([0-9a-f-]+)$/i);
  if (rollbackMatch?.[1] && rollbackMatch[2]) {
    const userId = String(ctx.from?.id ?? 'unknown');

    try {
      const outcome =
        rollbackMatch[1] === 'confirm'
          ? await confirmRollback(rollbackMatch[2], userId)
          : await cancelRollback(rollbackMatch[2], userId);
      await ctx.answerCbQuery(outcome.message);
      await ctx.reply(outcome.message);
    } catch (error) {
      console.error('[tone] rollback callback failed', error);
      await ctx.answerCbQuery('Unable to process rollback decision.');
    }

    return;
  }

  const weeklyMatch = callbackQuery.data.match(/^weekly:(approve|reject):(\d{4}-W\d{2})$/);
  if (weeklyMatch?.[1] && weeklyMatch[2]) {
    const decision = weeklyMatch[1] === 'approve' ? 'approve' : 'reject';
    try {
      const result = await handleWeeklyApprovalDecision({
        decision,
        weekKey: weeklyMatch[2],
        userId: String(ctx.from?.id ?? 'unknown'),
        reason:
          decision === 'approve'
            ? 'Approved from Telegram inline control'
            : 'Rejected from Telegram inline control',
      });
      await ctx.answerCbQuery(result.message);
    } catch (error) {
      console.error('[tone] weekly approval callback failed', error);
      await ctx.answerCbQuery('Unable to process weekly decision.');
    }
    return;
  }

  const emailSendMatch = callbackQuery.data.match(/^email-send:(confirm|cancel):([0-9a-f-]+)$/i);
  if (emailSendMatch?.[1] && emailSendMatch[2]) {
    const userId = String(ctx.from?.id ?? 'unknown');
    try {
      const outcome =
        emailSendMatch[1].toLowerCase() === 'confirm'
          ? await confirmPendingEmailSend(emailSendMatch[2], userId)
          : await cancelPendingEmailSend(emailSendMatch[2], userId);
      const callbackMessage =
        outcome.status === 'sent'
          ? 'Email sent.'
          : outcome.status === 'canceled'
            ? 'Send canceled.'
            : outcome.status === 'failed'
              ? 'Send failed.'
              : 'Already handled.';
      await ctx.answerCbQuery(callbackMessage);
      await ctx.reply(outcome.message);
    } catch (error) {
      console.error('[tone] email send callback failed', error);
      await ctx.answerCbQuery('Unable to process email send decision.');
    }

    return;
  }

  const match = callbackQuery.data.match(/^feedback:(up|down):(.+)$/);
  if (!match?.[1] || !match[2]) {
    await ctx.answerCbQuery('Unknown action.');
    return;
  }

  const direction = match[1];
  const interactionId = match[2];
  const signal = direction === 'up' ? 'thumbs_up' : 'thumbs_down';

  try {
    await logFeedbackSignal({
      interactionId,
      userId: String(ctx.from?.id ?? 'unknown'),
      signal,
    });
  } catch (error) {
    console.error('[tone] feedback logging error', error);
  }

  await ctx.answerCbQuery(signal === 'thumbs_up' ? 'Feedback recorded.' : 'Thanks, feedback recorded.');
});

bot.catch(async (error, ctx) => {
  console.error('[tone] unhandled bot error', error);
  try {
    await ctx.reply('Something went wrong while handling that request. Please try again.');
  } catch {
    // Ignore secondary failures when reporting an error to Telegram.
  }
});

async function launch(): Promise<void> {
  await bot.launch();

  scheduleBriefing({
    bot,
  });
  scheduleMiddayReminder({
    bot,
  });
  scheduleEveningRecap({
    bot,
  });
  scheduleNightly({
    bot,
  });
  scheduleWeekly({
    bot,
  });

  console.log('[tone] bot is running');
}

const isMainModule =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  launch().catch((error) => {
    console.error('[tone] failed to start bot', error);
    process.exitCode = 1;
  });
}

export { bot, launch };
