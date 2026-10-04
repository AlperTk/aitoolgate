import type {
  ClientConfig,
  ModelConfig,
  SessionKey,
  ToolCall,
  ToolResult,
} from './domain';

/** Normalized incoming LLM request (provider-agnostic view). */
export interface RequestContext {
  /** Client that made the request. */
  client: ClientConfig;
  /** Model being called. */
  model: ModelConfig;
  /** Session this request belongs to. */
  sessionKey: SessionKey;
  /** Provider-agnostic message history. */
  messages: unknown[];
  /** Raw provider request (for pass-through when needed). */
  raw: unknown;
}

/** Normalized outgoing LLM response (provider-agnostic view). */
export interface ResponseContext {
  /** Client that made the request. */
  client: ClientConfig;
  /** Model that produced the response. */
  model: ModelConfig;
  /** Session this response belongs to. */
  sessionKey: SessionKey;
  /** Tool calls the model emitted in this response. */
  toolCalls: ToolCall[];
  /** Textual content of the response, if any. */
  content: string;
  /** Raw provider response (for pass-through when needed). */
  raw: unknown;
}

/** Normalized tool-call results fed back into the stream. */
export interface ResultContext {
  /** Session these results belong to. */
  sessionKey: SessionKey;
  /** Tool results fed back into the stream. */
  results: ToolResult[];
  /** Raw provider result payload, if any. */
  raw: unknown;
}

/**
 * A single stage in the policy pipeline (Chain-of-Responsibility).
 * Implement any subset of the hooks that are relevant.
 */
export interface PipelineStage {
  /** Unique stage name. */
  readonly name: string;
  /** Hook: run for the incoming request, before forwarding to the model. */
  onRequest?(ctx: RequestContext): Promise<RequestContext> | RequestContext;
  /** Hook: run for the model's response, after receiving it. */
  onResponse?(ctx: ResponseContext): Promise<ResponseContext> | ResponseContext;
  /** Hook: run for tool-call results fed back into the stream. */
  onResult?(ctx: ResultContext): Promise<ResultContext> | ResultContext;
}

/** An ordered, composable chain of stages (Chain-of-Responsibility backbone). */
export interface Pipeline {
  /** Register a stage; returns the pipeline for chaining. */
  use(stage: PipelineStage): this;
  /** The ordered stages. */
  readonly stages: readonly PipelineStage[];
  /** Run the request half of the chain across all stages. */
  handleRequest(ctx: RequestContext): Promise<RequestContext>;
  /** Run the response half of the chain across all stages. */
  handleResponse(ctx: ResponseContext): Promise<ResponseContext>;
  /** Run the result half of the chain across all stages. */
  handleResult(ctx: ResultContext): Promise<ResultContext>;
}
