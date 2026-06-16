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

export async function callGemini({ model, instructions, input, signal }) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY.");
  }

  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await ai.models.generateContent({
      model,
      contents: input,
      config: {
        systemInstruction: instructions,
        abortSignal: signal
      }
    });

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
