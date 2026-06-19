import OpenAI from "openai";

export const GROQ_PROVIDER = "groq";

export const GROQ_MODELS = [
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3-32b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "allam-2-7b",
  "groq/compound",
  "groq/compound-mini"
];

function isAbortError(error) {
  return error?.name === "AbortError" || error?.name === "APIUserAbortError";
}

function getMaxOutputTokens() {
  const parsed = Number(process.env.GROQ_MAX_OUTPUT_TOKENS || "32768");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32768;
}

function isResponseFormatError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /response_format|json|schema|unsupported/i.test(message);
}

export async function callGroq({ model, instructions, input, signal, jsonSchema }) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY.");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
    timeout: 900000
  });

  try {
    async function create(useJsonMode) {
      const request = {
        model,
        temperature: 0,
        max_completion_tokens: getMaxOutputTokens(),
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

    let response;

    try {
      response = await create(Boolean(jsonSchema));
    } catch (error) {
      if (!jsonSchema || !isResponseFormatError(error)) throw error;
      response = await create(false);
    }

    return {
      provider: GROQ_PROVIDER,
      model,
      text: response.choices?.[0]?.message?.content || "",
      raw: response
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`Groq provider API failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
