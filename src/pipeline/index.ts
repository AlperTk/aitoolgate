import type {
  Pipeline,
  PipelineStage,
  RequestContext,
  ResponseContext,
  ResultContext,
} from '../ports/pipeline';

/**
 * Minimal {@link Pipeline} implementation: an ordered list of stages that run as
 * a passthrough. No policy stage is registered yet; stages are added later to
 * form the Chain-of-Responsibility backbone (request-in → LLM → response-out).
 */
export class DefaultPipeline implements Pipeline {
  readonly stages: PipelineStage[] = [];

  use(stage: PipelineStage): this {
    this.stages.push(stage);
    return this;
  }

  async handleRequest(ctx: RequestContext): Promise<RequestContext> {
    let current = ctx;
    for (const stage of this.stages) {
      if (stage.onRequest) current = await stage.onRequest(current);
    }
    return current;
  }

  async handleResponse(ctx: ResponseContext): Promise<ResponseContext> {
    let current = ctx;
    for (const stage of this.stages) {
      if (stage.onResponse) current = await stage.onResponse(current);
    }
    return current;
  }

  async handleResult(ctx: ResultContext): Promise<ResultContext> {
    let current = ctx;
    for (const stage of this.stages) {
      if (stage.onResult) current = await stage.onResult(current);
    }
    return current;
  }
}

/** Create a fresh passthrough pipeline (no stages registered). */
export function createPipeline(): Pipeline {
  return new DefaultPipeline();
}
