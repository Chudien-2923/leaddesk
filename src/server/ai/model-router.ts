import "server-only";
import { invokeOmp } from "./omp-stdio";
import {
  PRIMARY_MODEL, FALLBACK_MODEL, ModelError, matchesSelectedModel,
  parseExtractedFacts, throwIfAborted, validateModelInput,
  type ModelCaller, type ModelInvoker, type ModelResult, type ModelTrace,
} from "./types";

export function createModelRouter(invoke: ModelInvoker = invokeOmp): ModelCaller {
  return async (input, signal) => {
    const trace: ModelTrace[] = [];
    throwIfAborted(signal);
    validateModelInput(input);
    for (const model of [PRIMARY_MODEL, FALLBACK_MODEL] as const) {
      throwIfAborted(signal);
      let result: ModelResult | undefined;
      try {
        result = await invoke(model, input, signal);
        throwIfAborted(signal);
        if (!result || result.requestedModel !== model || !matchesSelectedModel(model, result.reportedModel)) {
          throw new ModelError("model_mismatch", "Model result provenance does not match the selected model", {
            reportedModel: result?.reportedModel,
          });
        }
        if (typeof result.text !== "string" || result.text.trim().length === 0) {
          throw new ModelError("protocol", "Model did not return complete assistant text");
        }
        if (input.purpose === "extract") parseExtractedFacts(result.text);
        trace.push({ requestedModel: model, reportedModel: result.reportedModel, outcome: "success" });
        return { ...result, fallbackUsed: model === FALLBACK_MODEL, trace };
      } catch (cause) {
        // Cancellation wins races with success, timeout and provider status.
        const error = signal.aborted ? new ModelError("aborted", "Model request cancelled")
          : cause instanceof ModelError ? cause
            : new ModelError("protocol", "Unexpected model transport failure", { cause });
        const reportedModel = error.reportedModel;
        trace.push({ requestedModel: model, ...(reportedModel !== undefined ? { reportedModel } : {}), outcome: error.code });
        const transient = error.code === "network" || error.code === "attempt_timeout"
          || (error.code === "rate_limited" && (error.status === undefined || error.status === 429))
          || (error.code === "upstream" && error.status !== undefined && error.status >= 500 && error.status <= 599);
        if (transient && model === PRIMARY_MODEL) continue;
        throw new ModelError(transient && model === FALLBACK_MODEL ? "unavailable" : error.code,
          transient && model === FALLBACK_MODEL ? "Both permitted model attempts failed" : error.message,
          { status: error.status, reportedModel, trace, cause: error });
      }
    }
    // The fixed two-element loop always returns or throws; never launch a third attempt.
    throw new ModelError("unavailable", "No permitted model attempt succeeded", { trace });
  };
}
export const callModel = createModelRouter();
