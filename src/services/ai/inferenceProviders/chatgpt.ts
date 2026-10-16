import type { InferenceProvider } from "./types";
import { wrapCleanupTranscript } from "../../../config/prompts";
import logger from "../../../utils/logger";
import { errorFromIpcResult } from "../../../helpers/ipcErrorFields";

// ChatGPT Plus/Pro subscription via OAuth. The call runs in main, which holds
// the tokens; text only, no tools, no images.
export const chatgptProvider: InferenceProvider = {
  id: "chatgpt",
  supportsImages: false,
  async call({ text, model, agentName, config, ctx }) {
    if (typeof window === "undefined" || !window.electronAPI?.processChatGptReasoning) {
      throw new Error("ChatGPT reasoning is not available in this environment");
    }

    logger.logReasoning("CHATGPT_START", { model, agentName, textLength: text.length });
    const startTime = Date.now();

    const systemPrompt = config.systemPrompt || ctx.getSystemPrompt(agentName);
    const userContent = config.systemPrompt ? text : wrapCleanupTranscript(text);
    const result = await window.electronAPI.processChatGptReasoning(userContent, model, agentName, {
      ...config,
      systemPrompt,
    });

    const processingTimeMs = Date.now() - startTime;

    if (!result.success) {
      logger.logReasoning("CHATGPT_ERROR", { model, processingTimeMs, error: result.error });
      throw errorFromIpcResult(result);
    }

    logger.logReasoning("CHATGPT_SUCCESS", {
      model,
      processingTimeMs,
      resultLength: result.text?.length ?? 0,
    });
    return result.text ?? "";
  },
};
