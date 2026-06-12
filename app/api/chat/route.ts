import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const ALLOWED_MODELS = new Set([
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4o-mini",
  "gpt-5.4",
  "gpt-5.5"
]);

const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_SELECTED_FILES = 8;
const MAX_FILE_CHARS = 18000;
const MAX_TOTAL_FILE_CHARS = 65000;
const MAX_FILE_INDEX_ITEMS = 700;
const HARD_INPUT_TOKEN_LIMIT = 30000;

type ProjectFile = {
  path: string;
  content: string;
};

type RequestBody = {
  password: string;
  model?: string;
  message: string;
  activePath?: string;
  selectedFolder?: string;
  files: ProjectFile[];
};

type PickFilesResponse = {
  paths?: string[];
  reason?: string;
};

function cleanPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function getRequestedModel(model?: string) {
  const requested = model?.trim() || DEFAULT_MODEL;

  if (ALLOWED_MODELS.has(requested)) {
    return requested;
  }

  if (/^gpt-[a-zA-Z0-9.\-_]+$/.test(requested)) {
    return requested;
  }

  return DEFAULT_MODEL;
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

async function pickRelevantFiles(model: string, files: ProjectFile[], message: string, activePath?: string, selectedFolder?: string) {
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

  const pickerTokens = estimateTokens(pickerInput);

  if (pickerTokens > HARD_INPUT_TOKEN_LIMIT) {
    return localCandidates.slice(0, 3);
  }

  const response = await client.responses.create({
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
    const parsed = JSON.parse(response.output_text) as PickFilesResponse;
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

    if (!process.env.APP_PASSWORD || body.password !== process.env.APP_PASSWORD) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const model = getRequestedModel(body.model);
    const files = (body.files || []).map((file) => ({
      path: cleanPath(file.path),
      content: file.content || ""
    }));

    const selectedPaths = await pickRelevantFiles(
      model,
      files,
      body.message,
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
MODEL USED:
${model}

USER REQUEST:
${body.message}

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

    if (finalInputTokens > HARD_INPUT_TOKEN_LIMIT) {
      return NextResponse.json(
        {
          type: "answer",
          error: `Aborted before calling OpenAI. Estimated input is ${finalInputTokens.toLocaleString()} tokens, above the ${HARD_INPUT_TOKEN_LIMIT.toLocaleString()} token safety limit.`,
          message: `Aborted to protect your credits. Estimated input: ${finalInputTokens.toLocaleString()} tokens. Limit: ${HARD_INPUT_TOKEN_LIMIT.toLocaleString()} tokens. Open/select a smaller file, ask about a specific file, or reduce imported files.`,
          usedFiles: selectedPaths,
          estimatedTokens: finalInputTokens,
          tokenLimit: HARD_INPUT_TOKEN_LIMIT
        },
        { status: 413 }
      );
    }

    const response = await client.responses.create({
      model,
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
`,
      input: finalInput
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

    return NextResponse.json({
      ...parsed,
      usedFiles: selectedPaths,
      estimatedTokens: finalInputTokens,
      tokenLimit: HARD_INPUT_TOKEN_LIMIT
    });
  } catch (error) {
    console.error(error);

    return NextResponse.json(
      {
        error:
          "Server error. Token-saver mode is enabled, so check selected model/API key/Vercel logs."
      },
      { status: 500 }
    );
  }
}
