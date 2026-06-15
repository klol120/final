import { NextRequest, NextResponse } from "next/server";
import {
  assertInputWithinLimit,
  callAi,
  getDefaultProvider,
  resolveProviderAndModel,
  validateProviderModel
} from "../../../server/ai/aiRouter.js";

const MAX_SELECTED_FILES = 8;
const MAX_FILE_CHARS = 18000;
const MAX_TOTAL_FILE_CHARS = 65000;
const MAX_FILE_INDEX_ITEMS = 700;

type ProjectFile = {
  path: string;
  content: string;
};

type ChatMessage = {
  role?: string;
  content?: string;
};

type RequestBody = {
  password: string;
  provider?: string;
  model?: string;
  message?: string;
  messages?: ChatMessage[];
  activePath?: string;
  selectedFolder?: string;
  files: ProjectFile[];
  mode?: "chat" | "code-edit";
};

type PickFilesResponse = {
  paths?: string[];
  reason?: string;
};

function cleanPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / 3.5);
}

function truncateMiddle(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;

  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}

...[TRUNCATED ${text.length - maxChars} CHARS]...

${text.slice(-half)}`;
}

function estimateLines(content: string) {
  if (!content) return 0;
  return content.split("\n").length;
}

function keywordScore(message: string, file: ProjectFile) {
  const lowerMessage = message.toLowerCase();
  const lowerPath = file.path.toLowerCase();
  const name = lowerPath.split("/").pop() || lowerPath;

  const words = lowerMessage
    .replace(/[^a-zA-Z0-9_./-]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3);

  let score = 0;

  for (const word of words) {
    if (lowerPath.includes(word)) score += 5;
    if (name.includes(word)) score += 8;
  }

  if (lowerMessage.includes(lowerPath)) score += 50;
  if (lowerMessage.includes(name)) score += 25;

  return score;
}

function getLocalCandidatePaths(files: ProjectFile[], message: string, activePath?: string, selectedFolder?: string) {
  const cleanActivePath = activePath ? cleanPath(activePath) : "";
  const cleanSelectedFolder = selectedFolder ? cleanPath(selectedFolder) : "";

  const scored = files
    .filter((file) => !file.path.endsWith("/.keep"))
    .map((file) => {
      let score = keywordScore(message, file);

      if (cleanActivePath && file.path === cleanActivePath) score += 100;
      if (cleanSelectedFolder && file.path.startsWith(`${cleanSelectedFolder}/`)) score += 15;

      if (file.path.endsWith("package.json")) score += 5;
      if (file.path.endsWith("app/page.tsx")) score += 8;
      if (file.path.endsWith("app/api/chat/route.ts")) score += 8;
      if (file.path.endsWith("app/globals.css")) score += 5;

      return { path: file.path, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored
    .filter((item, index) => item.score > 0 || index < 3)
    .slice(0, MAX_SELECTED_FILES)
    .map((item) => item.path);
}

function getMessageText(body: RequestBody) {
  if (body.messages?.length) {
    return body.messages
      .map((item) => `${item.role || "user"}: ${item.content || ""}`)
      .join("\n\n")
      .trim();
  }

  return (body.message || "").trim();
}

function getLatestUserMessage(body: RequestBody) {
  const latestUserMessage = [...(body.messages || [])]
    .reverse()
    .find((item) => item.role === "user" && item.content?.trim());

  return latestUserMessage?.content?.trim() || body.message?.trim() || getMessageText(body);
}

function safeRaw(raw: unknown) {
  try {
    return JSON.parse(JSON.stringify(raw));
  } catch {
    return null;
  }
}

function parseAiJson(text: string) {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {
    const firstBrace = unfenced.indexOf("{");
    const lastBrace = unfenced.lastIndexOf("}");

    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(unfenced.slice(firstBrace, lastBrace + 1));
    }

    throw new Error("AI response was not valid JSON.");
  }
}

function normalizeAiEditResponse(parsed: any) {
  if (parsed?.type !== "edit" || !Array.isArray(parsed.changes)) {
    return parsed;
  }

  return {
    ...parsed,
    changes: parsed.changes
      .filter((change: any) => {
        return (
          change &&
          ["create", "update", "delete"].includes(change.action) &&
          typeof change.path === "string" &&
          (change.action === "delete" || typeof change.content === "string")
        );
      })
      .map((change: any) => ({
        action: change.action,
        path: cleanPath(change.path),
        ...(change.action === "delete" ? {} : { content: change.content })
      }))
  };
}

async function pickRelevantFiles(provider: string, model: string, files: ProjectFile[], message: string, activePath?: string, selectedFolder?: string) {
  const localCandidates = getLocalCandidatePaths(files, message, activePath, selectedFolder);

  const fileIndex = files
    .filter((file) => !file.path.endsWith("/.keep"))
    .slice(0, MAX_FILE_INDEX_ITEMS)
    .map((file) => ({
      path: file.path,
      chars: file.content.length,
      lines: estimateLines(file.content)
    }));

  const pickerInput = `
USER REQUEST:
${message}

ACTIVE FILE:
${activePath || "none"}

SELECTED FOLDER:
${selectedFolder || "/"}

LOCAL CANDIDATES:
${JSON.stringify(localCandidates, null, 2)}

PROJECT FILE INDEX:
${JSON.stringify(fileIndex, null, 2)}
`;

  try {
    assertInputWithinLimit(pickerInput, "file picker input");
  } catch {
    return localCandidates.slice(0, 3);
  }

  const response = await callAi({
    provider,
    model,
    instructions: `
You are choosing which project files are needed for a coding request.

Return ONLY valid JSON:

{
  "paths": ["path/to/file1", "path/to/file2"],
  "reason": "short reason"
}

Rules:
- Choose at most ${MAX_SELECTED_FILES} files.
- Prefer the active file when relevant.
- Include files explicitly named by the user.
- Include related config files only if needed.
- Do not invent paths.
`,
    input: pickerInput
  });

  try {
    const parsed = parseAiJson(response.text) as PickFilesResponse;
    const validPaths = new Set(files.map((file) => file.path));

    const picked = (parsed.paths || [])
      .map(cleanPath)
      .filter((path) => validPaths.has(path))
      .slice(0, MAX_SELECTED_FILES);

    if (picked.length > 0) return picked;
  } catch {
  }

  return localCandidates;
}

function buildSelectedFileContext(files: ProjectFile[], selectedPaths: string[]) {
  const map = new Map(files.map((file) => [file.path, file]));
  let total = 0;
  const chunks: string[] = [];

  for (const path of selectedPaths) {
    const file = map.get(path);
    if (!file) continue;

    const remaining = MAX_TOTAL_FILE_CHARS - total;
    if (remaining <= 0) break;

    const maxForThisFile = Math.min(MAX_FILE_CHARS, remaining);
    const content = truncateMiddle(file.content, maxForThisFile);
    total += content.length;

    chunks.push(`FILE: ${file.path}
CHARS_ORIGINAL: ${file.content.length}
LINES_ORIGINAL: ${estimateLines(file.content)}
\`\`\`
${content}
\`\`\``);
  }

  return chunks.join("\n\n");
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as RequestBody;

    const configuredPassword = process.env.APP_PASSWORD?.trim();

    if (!configuredPassword) {
      return NextResponse.json(
        { error: "APP_PASSWORD is not configured. Create .env.local from .env.local.example and restart the dev server." },
        { status: 500 }
      );
    }

    if ((body.password || "").trim() !== configuredPassword) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const requested = resolveProviderAndModel({
      provider: body.provider || getDefaultProvider(),
      model: body.model?.trim() || undefined
    });
    validateProviderModel(requested.provider, requested.model);

    const messageText = getMessageText(body);
    const latestUserMessage = getLatestUserMessage(body);
    const mode = body.mode || "code-edit";

    if (!latestUserMessage) {
      return NextResponse.json({ error: "Message is required." }, { status: 400 });
    }

    const files = (body.files || []).map((file) => ({
      path: cleanPath(file.path),
      content: file.content || ""
    }));

    const selectedPaths = await pickRelevantFiles(
      requested.provider,
      requested.model,
      files,
      latestUserMessage,
      body.activePath,
      body.selectedFolder
    );

    const selectedFileContext = buildSelectedFileContext(files, selectedPaths);

    const projectTree = files
      .filter((file) => !file.path.endsWith("/.keep"))
      .slice(0, MAX_FILE_INDEX_ITEMS)
      .map((file) => file.path)
      .join("\n");

    const finalInput = `
PROVIDER USED:
${requested.provider}

MODEL USED:
${requested.model}

MODE:
${mode}

USER REQUEST:
${latestUserMessage}

MESSAGES:
${messageText}

ACTIVE FILE:
${body.activePath || "none"}

SELECTED FOLDER:
${body.selectedFolder || "/"}

FILES SELECTED FOR THIS REQUEST:
${selectedPaths.join("\n") || "none"}

PROJECT TREE ONLY:
${projectTree}

SELECTED FILE CONTENT:
${selectedFileContext || "No selected file contents. This may be a create-only or answer-only request."}
`;

    const finalInputTokens = estimateTokens(finalInput);

    try {
      assertInputWithinLimit(finalInput, "final AI input");
    } catch (error) {
      return NextResponse.json(
        {
          type: "answer",
          error: error instanceof Error ? error.message : "Input too large.",
          message: error instanceof Error ? error.message : "Input too large.",
          usedFiles: selectedPaths,
          estimatedTokens: finalInputTokens,
          maxInputChars: Number(process.env.MAX_INPUT_CHARS || "120000")
        },
        { status: 413 }
      );
    }

    const response = await callAi({
      provider: requested.provider,
      model: requested.model,
      instructions: `
You are a coding agent inside a web IDE.

TOKEN SAVER MODE:
- You were given only selected relevant files, not the whole project.
- If you need a missing file, return an answer saying exactly which path you need.
- Do not guess full contents of missing files.

When the user asks for edits, fixes, refactors, features, or new files, return ONLY valid JSON:

{
  "type": "edit",
  "message": "short confirmation",
  "changes": [
    {
      "action": "update",
      "path": "file path",
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

When no edit is needed, return ONLY valid JSON:

{
  "type": "answer",
  "message": "your answer"
}

Rules:
- For update/create, return full final file content.
- Never return partial diffs.
- Never wrap JSON in markdown.
- Do not include \`\`\`json fences. The first character of your response must be { and the last character must be }.
`,
      input: finalInput
    });

    let parsed;

    try {
      parsed = normalizeAiEditResponse(parseAiJson(response.text));
    } catch {
      parsed = {
        type: "answer",
        message: response.text
      };
    }

    return NextResponse.json({
      ...parsed,
      provider: response.provider,
      model: response.model,
      text: response.text,
      raw: safeRaw(response.raw),
      usedFiles: selectedPaths,
      estimatedTokens: finalInputTokens,
      maxInputChars: Number(process.env.MAX_INPUT_CHARS || "120000")
    });
  } catch (error) {
    console.error(error);
    const status = typeof (error as { status?: unknown }).status === "number" ? (error as { status: number }).status : 500;
    const message = error instanceof Error ? error.message : "Server error.";

    return NextResponse.json(
      {
        error: message
      },
      { status }
    );
  }
}
