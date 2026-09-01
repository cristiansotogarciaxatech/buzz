import { z } from "zod";

const scopeId = z.string().trim().min(1).max(512);
const boundedText = z.string().max(262_144);

const baseScopeSchema = z.object({
  communityId: scopeId,
  projectId: scopeId,
  channelId: scopeId,
  agentId: scopeId,
  sessionId: scopeId,
});

export const contextRequestSchema = baseScopeSchema.extend({
  message: boundedText,
});

export const toolEventSchema = z.object({
  name: z.string().trim().min(1).max(256),
  status: z.string().trim().min(1).max(64),
  summary: z.string().max(2_048).optional(),
});

export const memoryRequestSchema = baseScopeSchema.extend({
  userMessage: boundedText,
  agentResponse: boundedText,
  toolEvents: z.array(toolEventSchema).max(64).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ContextRequest = z.infer<typeof contextRequestSchema>;
export type MemoryRequest = z.infer<typeof memoryRequestSchema>;
export type ToolEvent = z.infer<typeof toolEventSchema>;

export interface RelevantMemory {
  text: string;
  sourceChannelId?: string;
  sourceAgentId?: string;
  sourceSessionId?: string;
  createdAt?: string;
  score?: number;
}

export interface ContextResponse {
  projectMemory: string;
  channelMemory: string;
  relevantMemories: RelevantMemory[];
  estimatedTokens: number;
}

export interface MemoryWriteResponse {
  stored: boolean;
  observed: boolean;
}
