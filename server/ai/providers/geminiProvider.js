import { GoogleGenAI } from "@google/genai";

export const GEMINI_PROVIDER = "gemini";

export const GEMINI_MODELS = [
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite"
];

function isAbortError(error) {
  return error?.name === "AbortError" || error?.name === "APIUserAbortError";
}

function getMaxOutputTokens() {
  const parsed = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || "32768");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 32768;
}

function isResponseFormatError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /responseMimeType|responseSchema|schema|json|unsupported/i.test(message);
}

export async function callGemini({ model, instructions, input, signal, jsonSchema }) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY.");
  }

  const ai = new GoogleGenAI({ apiKey });

  try {
    async function generate(useSchema) {
      const config = {
        systemInstruction: instructions,
        abortSignal: signal,
        temperature: 0,
        maxOutputTokens: getMaxOutputTokens()
      };

      if (useSchema && jsonSchema) {
        config.responseMimeType = "application/json";
        config.responseSchema = jsonSchema;
      } else if (jsonSchema) {
        config.responseMimeType = "application/json";
      }

      return ai.models.generateContent({
        model,
        contents: input,
        config
      });
    }

    let response;

    try {
      response = await generate(Boolean(jsonSchema));
    } catch (error) {
      if (!jsonSchema || !isResponseFormatError(error)) throw error;
      response = await generate(false);
    }

    return {
      provider: GEMINI_PROVIDER,
      model,
      text: response.text || "",
      raw: response
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new Error(`Gemini provider API failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
