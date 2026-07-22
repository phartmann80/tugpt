import { Mastra } from '@mastra/core';
import type { MastraCompositeStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import type { TextCompletionRouter } from './router';

const messageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().min(1),
});

const usageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

const attemptSchema = z.object({
  provider: z.enum(['logicc', 'langdock', 'openai']),
  model: z.string().optional(),
  outcome: z.enum(['success', 'failure']),
  errorCode: z
    .enum([
      'timeout',
      'rate_limited',
      'provider_error',
      'invalid_response',
      'no_provider_configured',
    ])
    .optional(),
  latencyMs: z.number().nonnegative(),
  usage: usageSchema.optional(),
});

export const textCompletionInputSchema = z.object({
  messages: z.array(messageSchema).min(1),
  options: z
    .object({
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().positive().optional(),
      organizationId: z.string().min(1).optional(),
      requestId: z.string().min(1).optional(),
      models: z
        .object({
          logicc: z.string().min(1).optional(),
          langdock: z.string().min(1).optional(),
          openai: z.string().min(1).optional(),
        })
        .optional(),
    })
    .optional(),
});

export const textCompletionOutputSchema = z.object({
  response: z.object({
    id: z.string().min(1),
    provider: z.enum(['logicc', 'langdock', 'openai']),
    model: z.string().min(1),
    text: z.string().min(1),
    usage: usageSchema,
    latencyMs: z.number().nonnegative(),
  }),
  attempts: z.array(attemptSchema).min(1),
  usedFallback: z.boolean(),
});

export function createTextCompletionWorkflow(router: TextCompletionRouter) {
  const routeCompletion = createStep({
    id: 'route-text-completion',
    inputSchema: textCompletionInputSchema,
    outputSchema: textCompletionOutputSchema,
    execute: async ({ inputData }) => {
      const result = await router.complete(inputData.messages, inputData.options);
      return { ...result, attempts: [...result.attempts] };
    },
  });

  return createWorkflow({
    id: 'text-completion-orchestration',
    inputSchema: textCompletionInputSchema,
    outputSchema: textCompletionOutputSchema,
  })
    .then(routeCompletion)
    .commit();
}

export function createAIOrchestrationRuntime(
  router: TextCompletionRouter,
  storage: MastraCompositeStore
) {
  if (!storage) {
    throw new Error('Mastra storage is required for AI orchestration');
  }

  const textCompletionWorkflow = createTextCompletionWorkflow(router);
  const mastra = new Mastra({
    workflows: { textCompletionWorkflow },
    storage,
  });

  return { mastra, textCompletionWorkflow };
}
