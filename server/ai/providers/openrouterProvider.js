import OpenAI from "openai";

export const OPENROUTER_PROVIDER = "openrouter";

export const OPENROUTER_MODELS = [
  "deepseek/deepseek-chat-v3-0324:free",
  "deepseek/deepseek-r1-0528:free",
  "qwen/qwen3-coder:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "google/gemini-2.0-flash-exp:free"
];

function isAbortError(error) {
  return error?.name === "AbortError" || error?.name === "APIUserAbortError";
}

function getMaxOutputTokens() {
  const parsed = Number(process.env.OPENROUTER_MAX_OUTPUT_TOKENS || "32768");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32768;
}

function getErrorStatus(error) {
  return error?.status || error?.code || error?.response?.status || error?.error?.code;
}

function isResponseFormatError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /response_format|json|schema|unsupported|format/i.test(message);
}

function isFallbackableModelError(error) {
  const status = Number(getErrorStatus(error));
  const message = error instanceof Error ? error.message : String(error || "");

  if ([404, 408, 409, 429, 500, 502, 503, 504].includes(status)) return true;

  return /rate.?limit|temporar|unavailable|no endpoints|provider returned error|model.*not.*available|model.*not.*found|model.*unavailable/i.test(message);
}

export async function callOpenRouter({ model, instructions, input, signal, jsonSchema }) {
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY.");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    timeout: 900000,
    defaultHeaders: {
      "X-Title": process.env.OPENROUTER_APP_NAME || "Home Codex Ready"
    }
  });

  async function create(candidateModel, useJsonMode) {
      const request = {
        model: candidateModel,
        temperature: 0,
        max_tokens: getMaxOutputTokens(),
        messages: [
        { role: "system", content: instructions },
        { role: "user", content: input }
      ]
    };

    if (useJsonMode && jsonSchema) {
      request.response_format = { type: "json_object" };
    }

    return client.chat.completions.create(request, { signal });
  }

  const candidateModels = [
    model,
    ...OPENROUTER_MODELS.filter((fallbackModel) => fallbackModel !== model)
  ];
  const failures = [];

  try {
    for (const candidateModel of candidateModels) {
      try {
        let response;

        try {
          response = await create(candidateModel, Boolean(jsonSchema));
        } catch (error) {
          if (!jsonSchema || !isResponseFormatError(error)) throw error;
          response = await create(candidateModel, false);
        }

        return {
          provider: OPENROUTER_PROVIDER,
          model: candidateModel,
          text: response.choices?.[0]?.message?.content || "",
          raw: response
        };
      } catch (error) {
        if (isAbortError(error)) throw error;
        if (!isFallbackableModelError(error)) throw error;

        const message = error instanceof Error ? error.message : "Unknown error";
        failures.push(`${candidateModel}: ${message}`);
      }
    }

    throw new Error(`All OpenRouter free model fallbacks failed. ${failures.join(" | ")}`);
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`OpenRouter provider API failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
