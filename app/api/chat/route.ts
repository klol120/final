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
const MAX_ACTIVE_FILE_CHARS = 52000;
const MAX_TOTAL_FILE_CHARS = 90000;
const MAX_FILE_INDEX_ITEMS = 700;
const MAX_HISTORY_MESSAGES = 10;
const MAX_HISTORY_MESSAGE_CHARS = 1400;

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

function buildFileOutline(content: string) {
  const lines = content.split("\n");
  const outline: string[] = [];
  const pattern =
    /^\s*(export\s+)?(default\s+)?(async\s+)?(function|const|let|var|type|interface|class)\s+([A-Za-z0-9_$]+)?|^\s*([A-Za-z0-9_$]+)\s*[:=]\s*(async\s*)?\(?[^=]*\)?\s*=>/;

  lines.forEach((line, index) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("//")) return;
    if (pattern.test(line) || /<(button|input|select|textarea|form|nav|menu)\b/i.test(line)) {
      outline.push(`${index + 1}: ${trimmed.slice(0, 180)}`);
    }
  });

  return outline.slice(0, 160).join("\n");
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
      .filter((item) => item.content?.trim())
      .slice(-MAX_HISTORY_MESSAGES)
      .map((item) => `${item.role || "user"}: ${item.content || ""}`)
      .map((item) => truncateMiddle(item, MAX_HISTORY_MESSAGE_CHARS))
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

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "APIUserAbortError")
  );
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

async function pickRelevantFiles(
  provider: string,
  model: string,
  files: ProjectFile[],
  message: string,
  activePath?: string,
  selectedFolder?: string,
  signal?: AbortSignal
) {
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

ACTIVE EDITOR TAB:
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
- The active editor tab is only UI context. If the user explicitly names a different file, include that named file and do not assume the active tab is the edit target.
- Include files explicitly named by the user.
- Include sibling component, style, utility, and config files when the requested change can affect a shared workflow or repeated UI pattern.
- For UI changes involving menus, toolbars, buttons, forms, navigation, state, or handlers, include the file that defines the surrounding component and any shared styling file if present.
- Include related config files only if needed.
- Do not invent paths.
`,
    input: pickerInput,
    signal
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

function buildSelectedFileContext(files: ProjectFile[], selectedPaths: string[], activePath?: string) {
  const map = new Map(files.map((file) => [file.path, file]));
  const cleanActivePath = activePath ? cleanPath(activePath) : "";
  let total = 0;
  const chunks: string[] = [];

  for (const path of selectedPaths) {
    const file = map.get(path);
    if (!file) continue;

    const remaining = MAX_TOTAL_FILE_CHARS - total;
    if (remaining <= 0) break;

    const perFileLimit = file.path === cleanActivePath ? MAX_ACTIVE_FILE_CHARS : MAX_FILE_CHARS;
    const maxForThisFile = Math.min(perFileLimit, remaining);
    const isTruncated = file.content.length > maxForThisFile;
    const content = truncateMiddle(file.content, maxForThisFile);
    total += content.length;
    const outline = buildFileOutline(file.content);

    chunks.push(`FILE: ${file.path}
CONTENT_STATUS: ${isTruncated ? "TRUNCATED" : "FULL"}
CHARS_ORIGINAL: ${file.content.length}
LINES_ORIGINAL: ${estimateLines(file.content)}
OUTLINE:
${outline || "No outline generated."}

CONTENT:
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
      body.selectedFolder,
      req.signal
    );

    const selectedFileContext = buildSelectedFileContext(files, selectedPaths, body.activePath);

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

RECENT CONVERSATION:
${messageText}

ACTIVE EDITOR TAB:
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
- The active editor tab is only UI context. If the user explicitly names another file in the request and that file content is present, treat the named file as the edit target.
- A selected file is truncated only when its CONTENT block contains a "[TRUNCATED ...]" marker. If there is no truncation marker, the displayed CONTENT is the full file, even when it is short.
- If a selected file has CONTENT_STATUS: FULL, do not ask the user to provide that file again. You already have its full content.

CONTEXT DISCIPLINE:
- First understand the surrounding workflow, not only the exact lines named by the user.
- Preserve existing behavior, imports, state, handlers, props, styles, accessibility attributes, and sibling UI unless the request explicitly asks to change them.
- When editing a repeated group such as a menu, toolbar, list of buttons, form controls, tabs, cards, or navigation items, inspect the whole group and keep behavior consistent across siblings.
- When changing shared logic, scan the selected file context for every caller or dependent state path included in the prompt and update all affected parts together.
- If a file is truncated and the missing section is necessary to make a safe full-file update, return an answer requesting the needed file or context instead of producing a risky edit.
- Prefer the smallest complete change that satisfies the request while leaving unrelated code intact.

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
      input: finalInput,
      signal: req.signal
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
    if (isAbortError(error)) {
      return NextResponse.json(
        {
          error: "Request aborted."
        },
        { status: 499 }
      );
    }

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
