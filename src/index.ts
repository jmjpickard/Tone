import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Telegraf, type Context } from 'telegraf';
import { message } from 'telegraf/filters';
import { config } from './config.js';
import { logFeedbackSignal, logInteraction } from './feedback.js';
import { route } from './router.js';
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

  try {
    await sendWithReactions(ctx, responseText, interactionId);
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
    'Tone is online. Send text or voice. I will route it through skills and log feedback via 👍/👎.',
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
    await ctx.reply('I could not process that voice note. Please try again or send text instead.');
  }
});

bot.on('callback_query', async (ctx) => {
  const callbackQuery = ctx.callbackQuery;
  if (!('data' in callbackQuery) || typeof callbackQuery.data !== 'string') {
    await ctx.answerCbQuery('Unsupported callback.');
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

export { bot };
