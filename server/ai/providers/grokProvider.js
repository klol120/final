import OpenAI from "openai";

export const GROK_PROVIDER = "grok";

export const GROK_MODELS = [
  "grok-4.3",
  "grok-4.3-latest",
  "grok-latest",
  "grok-build-0.1",
  "grok-code-fast-1",
  "grok-code-fast"
];

export async function callGrok({ model, instructions, input }) {
  const apiKey = process.env.XAI_API_KEY || process.env.GROK_API_KEY;

  if (!apiKey) {
    throw new Error("Missing XAI_API_KEY or GROK_API_KEY.");
  }

  const client = new OpenAI({
    apiKey,
    baseURL: "https://api.x.ai/v1",
    timeout: 360000
  });

  try {
    const response = await client.responses.create({
      model,
      instructions,
      input
    });

    return {
      provider: GROK_PROVIDER,
      model,
      text: response.output_text || "",
      raw: response
    };
  } catch (error) {
    throw new Error(`Grok provider API failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
