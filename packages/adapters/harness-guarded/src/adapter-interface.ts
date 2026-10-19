/**
 * Paperclip Server Adapter Interface
 * Mirrors upstream `server/src/adapters/registry.ts` types
 */

export interface AdapterContext {
  companyId: string;
  agentId: string;
  sessionId: string;
  userId: string;
  env: Record<string, string>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
}

export interface ToolResult {
  toolCallId: string;
  content: unknown;
  isError?: boolean;
}

export interface ServerAdapter {
  readonly name: string;
  readonly version: string;
  initialize(context: AdapterContext): Promise<void>;
  executeTool(toolCall: ToolCall): Promise<ToolResult>;
  shutdown(): Promise<void>;
}

export interface AdapterRegistry {
  register(adapter: ServerAdapter): void;
  unregister(name: string): void;
  get(name: string): ServerAdapter | undefined;
  list(): ServerAdapter[];
}

export function registerServerAdapter(adapter: ServerAdapter): void;