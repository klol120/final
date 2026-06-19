import OpenAI from "openai";

export const OPENAI_PROVIDER = "openai";

export const OPENAI_MODELS = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "chat-latest",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-pro",
  "gpt-5.1",
  "gpt-5",
  "gpt-5-pro",
  "gpt-5-mini",
  "gpt-5-nano",
  "o3-pro",
  "o3",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o-mini"
];

function isAbortError(error) {
  return error?.name === "AbortError" || error?.name === "APIUserAbortError";
}

function supportsReasoning(model) {
  return model.startsWith("gpt-5") || model.startsWith("o3");
}

function getMaxOutputTokens() {
  const parsed = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || "32768");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32768;
}

function isResponseFormatError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /json_schema|json_object|response_format|text\.format|schema|format/i.test(message);
}

function isReasoningError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /reasoning|effort/i.test(message);
}

function buildTextConfig(jsonSchema, jsonSchemaName, fallbackJsonObject = false) {
  if (jsonSchema) {
    return {
      format: {
        type: "json_schema",
        name: jsonSchemaName || "json_response",
        schema: jsonSchema,
        strict: false
      },
      verbosity: "low"
    };
  }

  if (fallbackJsonObject) {
    return {
      format: { type: "json_object" },
      verbosity: "low"
    };
  }

  return {
    verbosity: "low"
  };
}

export async function callOpenAI({ model, instructions, input, signal, jsonSchema, jsonSchemaName }) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const client = new OpenAI({ apiKey, timeout: 900000 });

  async function createResponse(textConfig, useReasoning) {
    const request = {
      model,
      instructions,
      input,
      max_output_tokens: getMaxOutputTokens(),
      text: textConfig
    };

    if (useReasoning) {
      request.reasoning = { effort: "high" };
    }

    return client.responses.create(request, { signal });
  }

  async function createResponseWithReasoningFallback(textConfig) {
    const useReasoning = supportsReasoning(model);

    try {
      return await createResponse(textConfig, useReasoning);
    } catch (error) {
      if (!useReasoning || !isReasoningError(error)) throw error;
      return createResponse(textConfig, false);
    }
  }

  try {
    let response;

    try {
      response = await createResponseWithReasoningFallback(buildTextConfig(jsonSchema, jsonSchemaName));
    } catch (error) {
      if (!jsonSchema || !isResponseFormatError(error)) throw error;

      try {
        response = await createResponseWithReasoningFallback(buildTextConfig(undefined, undefined, true));
      } catch (fallbackError) {
        if (!isResponseFormatError(fallbackError)) throw fallbackError;
        response = await createResponseWithReasoningFallback(buildTextConfig(undefined, undefined, false));
      }
    }

    return {
      provider: OPENAI_PROVIDER,
      model,
      text: response.output_text || "",
      raw: response
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`OpenAI provider API failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
