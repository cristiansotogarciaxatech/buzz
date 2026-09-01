import type { ContextResponse, RelevantMemory } from "./contracts.js";

export interface ContextBudgets {
  project: number;
  channel: number;
  semantic: number;
  total: number;
}

export function estimateTokens(value: string): number {
  return value.length === 0 ? 0 : Math.ceil(value.length / 4);
}

export function enforceContextBudgets(
  projectMemory: string,
  channelMemory: string,
  relevantMemories: RelevantMemory[],
  budgets: ContextBudgets,
): ContextResponse {
  let remaining = budgets.total;
  const project = takeNewest(projectMemory, Math.min(budgets.project, remaining));
  remaining -= estimateTokens(project);

  const channel = takeNewest(channelMemory, Math.min(budgets.channel, remaining));
  remaining -= estimateTokens(channel);

  const semantic: RelevantMemory[] = [];
  let semanticRemaining = Math.min(budgets.semantic, remaining);
  for (const memory of relevantMemories) {
    if (semanticRemaining <= 0) break;
    const text = takeNewest(memory.text, semanticRemaining);
    if (text.length === 0) continue;
    semantic.push({ ...memory, text });
    const used = estimateTokens(text);
    semanticRemaining -= used;
    remaining -= used;
  }

  return {
    projectMemory: project,
    channelMemory: channel,
    relevantMemories: semantic,
    estimatedTokens:
      estimateTokens(project) +
      estimateTokens(channel) +
      semantic.reduce((sum, item) => sum + estimateTokens(item.text), 0),
  };
}

function takeNewest(value: string, tokenBudget: number): string {
  const maxCharacters = Math.max(0, tokenBudget) * 4;
  if (value.length <= maxCharacters) return value;
  if (maxCharacters <= 3) return value.slice(-maxCharacters);
  return "..." + value.slice(-(maxCharacters - 3));
}
