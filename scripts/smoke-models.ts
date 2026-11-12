// Operator-invoked only. Run with Node's react-server condition for server-only modules.
import { createModelRouter } from "../src/server/ai/model-router";
import { invokeOmp, verifyOmpConfiguration } from "../src/server/ai/omp-stdio";
import { MODEL_SELECTORS, PRIMARY_MODEL, ModelError, type ModelInput } from "../src/server/ai/types";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const input: ModelInput = {
  purpose: "answer",
  messages: [
    { role: "system", content: "This is a harmless local personal demo smoke test. Do not call tools. Reply with one short Vietnamese greeting only." },
    { role: "user", content: "Chào LeadDesk, đây là dữ liệu tổng hợp để kiểm tra kết nối." },
  ],
};
try {
  await verifyOmpConfiguration(controller.signal);
  console.log(JSON.stringify({ step: "effective-config-isolation", status: "verified" }));
  for (const model of MODEL_SELECTORS) {
    const result = await invokeOmp(model, input, controller.signal);
    console.log(JSON.stringify({ step: "single-model", status: "success", requestedModel: result.requestedModel, reportedModel: result.reportedModel }));
  }
  // Primary failure is injected BEFORE any Gemini request, not evidence of a real outage.
  const route = createModelRouter(async (model, request, signal) => {
    if (model === PRIMARY_MODEL) throw new ModelError("upstream", "Intentionally injected primary failure", { status: 503 });
    return invokeOmp(model, request, signal);
  });
  const fallback = await route(input, controller.signal);
  console.log(JSON.stringify({
    step: "injected-primary-failure-real-luna", primaryFailureInjected: true, status: "success",
    requestedModel: fallback.requestedModel, reportedModel: fallback.reportedModel,
    fallbackUsed: fallback.fallbackUsed, trace: fallback.trace,
  }));
} catch (error) {
  // Stop at the first failure, including quota/auth/permission: never repeat probes.
  console.error(JSON.stringify({
    status: "stopped", code: error instanceof ModelError ? error.code : "unexpected",
    ...(error instanceof ModelError && error.status !== undefined ? { upstreamStatus: error.status } : {}),
  }));
  process.exitCode = 1;
} finally {
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
