import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { RuntimeEventRunner } from "../../events/types.ts";
import type { WorkspaceId } from "../../workspace.ts";

export class PiSessionRunner implements RuntimeEventRunner {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry = ModelRegistry.create(this.authStorage);

  constructor(
    private readonly opts: {
      provider?: string;
      model?: string;
      thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
    } = {},
  ) {}

  runUserMessage(
    _workspaceId: WorkspaceId,
    _sessionId: string,
    text: string,
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<unknown> {
    const provider = this.opts.provider ?? "anthropic";
    const modelId = this.opts.model ?? "claude-haiku-4-5";
    return this.runPrompt(text, provider, modelId, opts.signal);
  }

  private async *runPrompt(
    text: string,
    provider: string,
    modelId: string,
    signal: AbortSignal | undefined,
  ): AsyncIterable<unknown> {
    const model = this.modelRegistry.find(provider, modelId);
    if (!model) {
      throw new Error(`Pi model not available: ${provider}/${modelId}`);
    }
    const { session } = await createAgentSession({
      model,
      thinkingLevel: this.opts.thinkingLevel ?? "off",
      noTools: "builtin",
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      sessionManager: SessionManager.inMemory(),
    });

    const queue: unknown[] = [];
    let done = false;
    let failure: unknown;
    let wake: (() => void) | undefined;

    const stop = session.subscribe((event) => {
      queue.push(event);
      wake?.();
    });

    const onAbort = () => {
      void session.abort();
      wake?.();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const run = session
      .prompt(text)
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        done = true;
        wake?.();
      });

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = undefined;
          continue;
        }
        yield queue.shift();
      }

      await run;
      if (failure) throw failure;
    } finally {
      stop();
      signal?.removeEventListener("abort", onAbort);
      session.dispose();
    }
  }
}
