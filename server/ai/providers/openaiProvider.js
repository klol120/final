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

export async function callOpenAI({ model, instructions, input }) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY.");
  }

  const client = new OpenAI({ apiKey });

  try {
    const response = await client.responses.create({
      model,
      instructions,
      input
    });

    return {
      provider: OPENAI_PROVIDER,
      model,
      text: response.output_text || "",
      raw: response
    };
  } catch (error) {
    throw new Error(`OpenAI provider API failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
