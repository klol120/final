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

export async function callGroq({ model, instructions, input, signal }) {
  const apiKey = process.env.GROQ_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GROQ_API_KEY.");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
    timeout: 360000
  });

  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: input }
      ]
    }, { signal });

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
