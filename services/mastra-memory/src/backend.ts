import type {
  ContextRequest,
  ContextResponse,
  MemoryRequest,
  MemoryWriteResponse,
} from "./contracts.js";

export interface MemoryBackend {
  health(): Promise<Record<string, unknown>>;
  context(request: ContextRequest): Promise<ContextResponse>;
  remember(request: MemoryRequest): Promise<MemoryWriteResponse>;
  close(): Promise<void>;
}
