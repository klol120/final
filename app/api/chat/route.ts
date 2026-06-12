import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

type ProjectFile = {
  path: string;
  content: string;
};

type RequestBody = {
  password: string;
  message: string;
  files: ProjectFile[];
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RequestBody;

    if (!process.env.APP_PASSWORD || body.password !== process.env.APP_PASSWORD) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const fileContext = body.files
      .map((file) => `FILE: ${file.path}\n\`\`\`\n${file.content}\n\`\`\``)
      .join("\n\n");

    const response = await client.responses.create({
      model: "gpt-4.1-mini",
      instructions: `
You are a coding agent inside a web IDE.

You can answer questions, update existing files, create new files, and delete files.

When the user asks for edits, fixes, refactors, features, or new files, return ONLY valid JSON in this exact shape:

{
  "type": "edit",
  "message": "short confirmation of what you changed",
  "changes": [
    {
      "action": "update",
      "path": "existing or new file path",
      "content": "full new file content"
    },
    {
      "action": "create",
      "path": "new file path",
      "content": "full new file content"
    },
    {
      "action": "delete",
      "path": "file path"
    }
  ]
}

When the user only asks a question and no edit is needed, return ONLY valid JSON in this shape:

{
  "type": "answer",
  "message": "your answer"
}

Rules:
- You are allowed to create new files when useful.
- For update and create, always return the entire final file content.
- Never return partial diffs.
- Never use markdown outside the JSON.
- Never wrap the JSON in code fences.
- Keep the message practical and short.
`,
      input: `
PROJECT FILES:

${fileContext || "No files yet."}

USER REQUEST:

${body.message}
`
    });

    let parsed;

    try {
      parsed = JSON.parse(response.output_text);
    } catch {
      parsed = {
        type: "answer",
        message: response.output_text
      };
    }

    return NextResponse.json(parsed);
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error:
          "Server error. If you are on public Wi-Fi and running localhost, the OpenAI request may be blocked. Deploy to Vercel/Render so the API call happens from that server."
      },
      { status: 500 }
    );
  }
}
