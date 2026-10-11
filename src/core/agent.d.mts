export interface ExecutionLimits { maxRequests: number; maxInputBytes: number; maxOutputTokens: number; timeoutMs: number }
export interface Usage { inputTokens: number; outputTokens: number; cachedInputTokens: number | null }
export interface EditResult { files: { path: string; content: string }[]; summary: string }
export interface CheckFeedback { passed: number; total: number; checks?: { name: string; passed: boolean; detail: string }[] }
export interface AgentRequest { number: number; inputBytes: number; outputTokenLimit: number; status: string; usage: Usage | null; result?: EditResult; checks?: CheckFeedback }
export interface ExecutionReceipt { kind: 'model-agent'; limits: ExecutionLimits; startedAt: string; finishedAt: string | null; status: 'queued' | 'running' | 'finished' | 'stopped' | 'failed' | 'interrupted'; requests: AgentRequest[]; inputTokens: number; outputTokens: number; cachedInputTokens: number | null; usageComplete: boolean; error: string | null; elapsedMs?: number }
export type ModelProvider = (input: { messages: { role: string; content: string }[]; maxOutputTokens: number; signal: AbortSignal }) => Promise<{ content: string; finishReason: string; usage: unknown }>;
export function executionLimits(value: unknown): ExecutionLimits;
export function usageRecord(value: unknown): Usage;
export function runEditingAgent(input: { instructions: string; files: Record<string,string>; limits: ExecutionLimits; provider: ModelProvider; apply: (files: EditResult['files'], signal: AbortSignal) => Promise<void>; check: (signal: AbortSignal) => Promise<CheckFeedback>; save: (receipt: ExecutionReceipt) => Promise<void>; signal?: AbortSignal }): Promise<EditResult & { receipt: ExecutionReceipt }>;
export function chatProvider(input: { endpoint: string; apiKey: string; model: string; fetchImpl?: typeof fetch;
  tokenLimitField?: 'max_completion_tokens' | 'max_tokens'; rejectIfBusy?: boolean }): ModelProvider;
