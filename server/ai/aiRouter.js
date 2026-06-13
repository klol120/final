import { callGemini, GEMINI_MODELS, GEMINI_PROVIDER } from "./providers/geminiProvider.js";
import { callOpenAI, OPENAI_MODELS, OPENAI_PROVIDER } from "./providers/openaiProvider.js";

export const AUTO_PROVIDER = "auto";

export const PROVIDER_MODELS = {
  [OPENAI_PROVIDER]: OPENAI_MODELS,
  [GEMINI_PROVIDER]: GEMINI_MODELS
};

export const ALLOWED_PROVIDERS = [OPENAI_PROVIDER, GEMINI_PROVIDER, AUTO_PROVIDER];

export function getDefaultProvider() {
  const configured = process.env.DEFAULT_AI_PROVIDER || OPENAI_PROVIDER;
  return ALLOWED_PROVIDERS.includes(configured) ? configured : OPENAI_PROVIDER;
}

export function getDefaultModel(provider) {
  if (provider === GEMINI_PROVIDER) {
    const configured = process.env.DEFAULT_GEMINI_MODEL || "gemini-3.1-flash-lite";
    return GEMINI_MODELS.includes(configured) ? configured : GEMINI_MODELS[0];
  }

  const configured = process.env.DEFAULT_OPENAI_MODEL || "gpt-5.4-mini";
  return OPENAI_MODELS.includes(configured) ? configured : OPENAI_MODELS[0];
}

export function getMaxInputChars() {
  const parsed = Number(process.env.MAX_INPUT_CHARS || "120000");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000;
}

export function assertInputWithinLimit(input, label = "input") {
  const maxInputChars = getMaxInputChars();

  if (input.length > maxInputChars) {
    const error = new Error(
      `Input too large. ${label} is ${input.length.toLocaleString()} characters, above the ${maxInputChars.toLocaleString()} character limit.`
    );
    error.status = 413;
    throw error;
  }
}

export function resolveProviderAndModel({ provider, model }) {
  const requestedProvider = (provider || getDefaultProvider()).trim();

  if (!ALLOWED_PROVIDERS.includes(requestedProvider)) {
    const error = new Error(`Invalid provider "${requestedProvider}". Allowed providers: ${ALLOWED_PROVIDERS.join(", ")}.`);
    error.status = 400;
    throw error;
  }

  if (requestedProvider === AUTO_PROVIDER) {
    if (process.env.OPENAI_API_KEY) {
      return {
        provider: OPENAI_PROVIDER,
        requestedProvider,
        model: OPENAI_MODELS.includes(model) ? model : getDefaultModel(OPENAI_PROVIDER)
      };
    }

    if (process.env.GEMINI_API_KEY) {
      return {
        provider: GEMINI_PROVIDER,
        requestedProvider,
        model: GEMINI_MODELS.includes(model) ? model : getDefaultModel(GEMINI_PROVIDER)
      };
    }

    const error = new Error("Missing API key. Set OPENAI_API_KEY or GEMINI_API_KEY for auto provider fallback.");
    error.status = 500;
    throw error;
  }

  return {
    provider: requestedProvider,
    requestedProvider,
    model: model || getDefaultModel(requestedProvider)
  };
}

export function validateProviderModel(provider, model) {
  const allowedModels = PROVIDER_MODELS[provider];

  if (!allowedModels) {
    const error = new Error(`Invalid provider "${provider}".`);
    error.status = 400;
    throw error;
  }

  if (!allowedModels.includes(model)) {
    const error = new Error(
      `Invalid model "${model}" for ${provider}. Allowed models: ${allowedModels.join(", ")}.`
    );
    error.status = 400;
    throw error;
  }
}

export async function callAi({ provider, model, instructions, input }) {
  validateProviderModel(provider, model);
  assertInputWithinLimit(input);

  if (provider === OPENAI_PROVIDER) {
    return callOpenAI({ model, instructions, input });
  }

  if (provider === GEMINI_PROVIDER) {
    return callGemini({ model, instructions, input });
  }

  const error = new Error(`Invalid provider "${provider}".`);
  error.status = 400;
  throw error;
}
