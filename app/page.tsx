"use client";

import dynamic from "next/dynamic";
import type { CSSProperties, DragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });
const MonacoDiffEditor = dynamic(() => import("@monaco-editor/react").then((module) => module.DiffEditor), { ssr: false });

type ProjectFile = {
  path: string;
  content: string;
};

type AiChange = {
  action: "update" | "create" | "delete";
  path: string;
  content?: string;
};

type AiResponse = {
  type?: "answer" | "edit";
  message?: string;
  changes?: AiChange[];
  provider?: string;
  model?: string;
  error?: string;
  text?: string;
  estimatedTokens?: number;
  usedFiles?: string[];
  requiresConfirmation?: boolean;
  inputChars?: number;
  maxInputChars?: number;
};

type ChatEntry = {
  role: "user" | "ai" | "system";
  text: string;
  createdAt: string;
  estimatedTokens: number;
  transient?: boolean;
  usedFiles?: string[];
};

type TreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  children: TreeNode[];
};

type DiffLine = {
  type: "context" | "add" | "remove";
  text: string;
  oldLine?: number;
  newLine?: number;
};

type UsageStats = {
  lastInputTokens: number;
  lastOutputTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  provider: string;
  model: string;
};

type ModelPreset = {
  id: string;
  label: string;
  provider: string;
  model: string;
};

type RightPanelTab = "chat" | "changes" | "usage";

type DraftItem = {
  type: "file" | "folder";
  parentPath: string;
  name: string;
};

const PROVIDER_OPTIONS = [
  { value: "auto", label: "Auto fallback" },
  { value: "openai", label: "OpenAI" },
  { value: "gemini", label: "Google Gemini" },
  { value: "groq", label: "Groq" },
  { value: "openrouter", label: "OpenRouter" }
];

const MODEL_GROUPS = [
  {
    provider: "openai",
    label: "OpenAI",
    models: [
      { value: "gpt-5.5", label: "gpt-5.5 - strongest coding" },
      { value: "gpt-5.5-pro", label: "gpt-5.5-pro - highest accuracy" },
      { value: "gpt-5.4", label: "gpt-5.4 - strong / cheaper" },
      { value: "gpt-5.4-pro", label: "gpt-5.4-pro - high accuracy" },
      { value: "gpt-5.4-mini", label: "gpt-5.4-mini - default value" },
      { value: "gpt-5.4-nano", label: "gpt-5.4-nano - cheapest" },
      { value: "chat-latest", label: "chat-latest" },
      { value: "gpt-5.3-codex", label: "gpt-5.3-codex - coding agent" },
      { value: "gpt-5.2", label: "gpt-5.2" },
      { value: "gpt-5.2-pro", label: "gpt-5.2-pro" },
      { value: "gpt-5.1", label: "gpt-5.1" },
      { value: "gpt-5", label: "gpt-5" },
      { value: "gpt-5-pro", label: "gpt-5-pro" },
      { value: "gpt-5-mini", label: "gpt-5-mini" },
      { value: "gpt-5-nano", label: "gpt-5-nano" },
      { value: "o3-pro", label: "o3-pro" },
      { value: "o3", label: "o3" },
      { value: "gpt-4.1", label: "gpt-4.1" },
      { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
      { value: "gpt-4o-mini", label: "gpt-4o-mini" }
    ]
  },
  {
    provider: "gemini",
    label: "Google",
    models: [
      { value: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview - strongest" },
      { value: "gemini-3.5-flash", label: "gemini-3.5-flash" },
      { value: "gemini-3-flash-preview", label: "gemini-3-flash-preview" },
      { value: "gemini-3.1-flash-lite", label: "gemini-3.1-flash-lite - default value" },
      { value: "gemini-2.5-pro", label: "gemini-2.5-pro" },
      { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
      { value: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite" }
    ]
  },
  {
    provider: "groq",
    label: "Groq",
    models: [
      { value: "llama-3.3-70b-versatile", label: "llama-3.3-70b-versatile - general purpose" },
      { value: "llama-3.1-8b-instant", label: "llama-3.1-8b-instant - fast / cheap" },
      { value: "openai/gpt-oss-120b", label: "openai/gpt-oss-120b - reasoning" },
      { value: "openai/gpt-oss-20b", label: "openai/gpt-oss-20b - fast reasoning" },
      { value: "qwen/qwen3-32b", label: "qwen/qwen3-32b - coding / reasoning" },
      { value: "meta-llama/llama-4-scout-17b-16e-instruct", label: "llama-4-scout - multimodal" },
      { value: "allam-2-7b", label: "allam-2-7b - Arabic / English" },
      { value: "groq/compound", label: "groq/compound - agentic tools" },
      { value: "groq/compound-mini", label: "groq/compound-mini - fast agentic tools" }
    ]
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    models: [
      { value: "deepseek/deepseek-chat-v3-0324:free", label: "deepseek-chat-v3-0324 - free" },
      { value: "deepseek/deepseek-r1-0528:free", label: "deepseek-r1-0528 - free reasoning" },
      { value: "qwen/qwen3-coder:free", label: "qwen3-coder - free coding" },
      { value: "meta-llama/llama-3.3-70b-instruct:free", label: "llama-3.3-70b-instruct - free" },
      { value: "google/gemini-2.0-flash-exp:free", label: "gemini-2.0-flash-exp - free" }
    ]
  }
];

const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  openai: "gpt-5.4-mini",
  gemini: "gemini-3.1-flash-lite",
  groq: "llama-3.3-70b-versatile",
  openrouter: "deepseek/deepseek-chat-v3-0324:free"
};

const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "fast",
    label: "Fast",
    provider: "groq",
    model: "llama-3.1-8b-instant"
  },
  {
    id: "balanced",
    label: "Balanced",
    provider: "openai",
    model: "gpt-5.4-mini"
  },
  {
    id: "best-coding",
    label: "Best coding",
    provider: "openai",
    model: "gpt-5.5"
  },
  {
    id: "cheapest",
    label: "Cheapest",
    provider: "openai",
    model: "gpt-4o-mini"
  }
];

const ALL_MODEL_VALUES = MODEL_GROUPS.flatMap((group) => group.models.map((model) => model.value));
const ALL_PROVIDER_VALUES = PROVIDER_OPTIONS.map((provider) => provider.value);
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 620;
const SIDEBAR_DEFAULT_WIDTH = 320;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_HISTORY_TOKENS = 1800;
const LARGE_REQUEST_CONFIRM_CHARS = 120000;

const MODEL_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "openai:gpt-5.5": { input: 5, output: 30 },
  "openai:gpt-5.5-pro": { input: 30, output: 180 },
  "openai:gpt-5.4": { input: 2.5, output: 15 },
  "openai:gpt-5.4-mini": { input: 0.75, output: 4.5 },
  "openai:gpt-4.1": { input: 2, output: 8 },
  "openai:gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "openai:gpt-4o-mini": { input: 0.15, output: 0.6 },
  "groq:llama-3.3-70b-versatile": { input: 0.59, output: 0.79 },
  "groq:llama-3.1-8b-instant": { input: 0.05, output: 0.08 },
  "groq:qwen/qwen3-32b": { input: 0.29, output: 0.59 },
  "openrouter:deepseek/deepseek-chat-v3-0324:free": { input: 0, output: 0 },
  "openrouter:deepseek/deepseek-r1-0528:free": { input: 0, output: 0 },
  "openrouter:qwen/qwen3-coder:free": { input: 0, output: 0 },
  "openrouter:meta-llama/llama-3.3-70b-instruct:free": { input: 0, output: 0 },
  "openrouter:google/gemini-2.0-flash-exp:free": { input: 0, output: 0 }
};

function normalizeProvider(provider: string) {
  if (provider === "grok") return "groq";
  if (provider === "open-router") return "openrouter";
  return ALL_PROVIDER_VALUES.includes(provider) ? provider : "openai";
}

function isModelAllowedForProvider(provider: string, model: string) {
  if (provider === "auto") return ALL_MODEL_VALUES.includes(model);
  return MODEL_GROUPS.some((group) => group.provider === provider && group.models.some((item) => item.value === model));
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function cleanPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function createChatEntry(role: ChatEntry["role"], text: string, transient = false, usedFiles: string[] = []): ChatEntry {
  return {
    role,
    text,
    transient,
    usedFiles,
    estimatedTokens: estimateTokens(text),
    createdAt: new Date().toISOString()
  };
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 3.5));
}

function estimateCostUsd(provider: string, model: string, inputTokens: number, outputTokens: number) {
  const pricing = MODEL_PRICING_PER_MILLION[`${provider}:${model}`];

  if (!pricing) return null;

  return ((inputTokens * pricing.input) + (outputTokens * pricing.output)) / 1_000_000;
}

function formatUsd(value: number | null) {
  if (value === null) return "n/a";
  if (value === 0) return "$0.0000";

  return value < 0.0001 ? "<$0.0001" : `$${value.toFixed(4)}`;
}

function formatCharacterCount(value: number) {
  return value.toLocaleString();
}

function formatChatTime(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function truncateForHistory(text: string) {
  if (text.length <= MAX_HISTORY_MESSAGE_CHARS) return text;

  return `${text.slice(0, MAX_HISTORY_MESSAGE_CHARS)}\n...[truncated]`;
}

function buildCompactHistory(chatEntries: ChatEntry[], nextUserMessage: string): { role: string; content: string }[] {
  const usefulEntries = chatEntries
    .filter((entry) => !entry.transient && (entry.role === "user" || entry.role === "ai"))
    .slice(-MAX_HISTORY_MESSAGES);

  const candidates = [
    ...usefulEntries.map((entry) => ({
      role: entry.role === "ai" ? "assistant" : "user",
      content: truncateForHistory(entry.text)
    })),
    {
      role: "user",
      content: truncateForHistory(nextUserMessage)
    }
  ];

  const compacted: { role: string; content: string }[] = [];
  let totalTokens = 0;

  for (const item of [...candidates].reverse()) {
    const tokens = estimateTokens(item.content);

    if (compacted.length > 0 && totalTokens + tokens > MAX_HISTORY_TOKENS) {
      break;
    }

    compacted.push(item);
    totalTokens += tokens;
  }

  return compacted.reverse();
}

function fileName(path: string) {
  return cleanPath(path).split("/").filter(Boolean).pop() || path;
}

function folderName(path: string) {
  const parts = cleanPath(path).split("/").filter(Boolean);
  return parts.pop() || "/";
}

function buildTree(files: ProjectFile[]) {
  const root: TreeNode = {
    name: "root",
    path: "",
    type: "folder",
    children: []
  };

  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let current = root;

    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1;
      const nodePath = parts.slice(0, index + 1).join("/");

      let existing = current.children.find((child) => child.name === part);

      if (!existing) {
        existing = {
          name: part,
          path: nodePath,
          type: isFile ? "file" : "folder",
          children: []
        };

        current.children.push(existing);
      }

      current = existing;
    });
  }

  function sortNodes(nodes: TreeNode[]) {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    nodes.forEach((node) => sortNodes(node.children));
  }

  sortNodes(root.children);
  return root.children;
}

function filterTreeByQuery(nodes: TreeNode[], query: string): TreeNode[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return nodes;

  return nodes
    .map((node) => {
      const nodeMatches = node.path.toLowerCase().includes(normalizedQuery) || node.name.toLowerCase().includes(normalizedQuery);
      const children = filterTreeByQuery(node.children, normalizedQuery);

      if (!nodeMatches && children.length === 0) return null;

      return {
        ...node,
        children
      };
    })
    .filter((node): node is TreeNode => Boolean(node));
}

function getFileIcon(path: string) {
  if (path.endsWith(".py")) return "PY";
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "TS";
  if (path.endsWith(".jsx") || path.endsWith(".js")) return "JS";
  if (path.endsWith(".html")) return "HT";
  if (path.endsWith(".css")) return "#";
  if (path.endsWith(".json")) return "{}";
  if (path.endsWith(".md")) return "MD";
  if (path.endsWith(".env")) return "ENV";
  if (path.endsWith(".zip")) return "ZIP";
  return "TXT";
}

function getLanguage(path: string) {
  if (path.endsWith(".py")) return "python";
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "typescript";
  if (path.endsWith(".jsx") || path.endsWith(".js")) return "javascript";
  if (path.endsWith(".html")) return "html";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".json")) return "json";
  if (path.endsWith(".md")) return "markdown";
  return "plaintext";
}

function isBinaryLike(path: string) {
  const lower = path.toLowerCase();

  return [
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".mp4",
    ".mp3",
    ".wav",
    ".ttf",
    ".otf",
    ".woff",
    ".woff2",
    ".exe",
    ".dll"
  ].some((ext) => lower.endsWith(ext));
}

function buildLineDiff(before: string, after: string): DiffLine[] {
  const oldLines = before.length > 0 ? before.split("\n") : [];
  const newLines = after.length > 0 ? after.split("\n") : [];
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = Array.from({ length: rows }, () => Array(cols).fill(0) as number[]);

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      if (oldLines[oldIndex] === newLines[newIndex]) {
        table[oldIndex][newIndex] = table[oldIndex + 1][newIndex + 1] + 1;
      } else {
        table[oldIndex][newIndex] = Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
      }
    }
  }

  const diff: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      diff.push({
        type: "context",
        text: oldLines[oldIndex],
        oldLine: oldIndex + 1,
        newLine: newIndex + 1
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (table[oldIndex + 1][newIndex] >= table[oldIndex][newIndex + 1]) {
      diff.push({
        type: "remove",
        text: oldLines[oldIndex],
        oldLine: oldIndex + 1
      });
      oldIndex += 1;
    } else {
      diff.push({
        type: "add",
        text: newLines[newIndex],
        newLine: newIndex + 1
      });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    diff.push({
      type: "remove",
      text: oldLines[oldIndex],
      oldLine: oldIndex + 1
    });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    diff.push({
      type: "add",
      text: newLines[newIndex],
      newLine: newIndex + 1
    });
    newIndex += 1;
  }

  return diff;
}

function compactDiffLines(lines: DiffLine[], contextRadius = 3, maxLines = 220) {
  const interesting = new Set<number>();

  lines.forEach((line, index) => {
    if (line.type === "context") return;

    for (let offset = -contextRadius; offset <= contextRadius; offset += 1) {
      const nearby = index + offset;
      if (nearby >= 0 && nearby < lines.length) {
        interesting.add(nearby);
      }
    }
  });

  if (interesting.size === 0) {
    return lines.slice(0, 24);
  }

  const compacted: Array<DiffLine | { type: "gap" }> = [];
  let previous = -2;

  Array.from(interesting)
    .sort((a, b) => a - b)
    .slice(0, maxLines)
    .forEach((index) => {
      if (previous >= 0 && index > previous + 1) {
        compacted.push({ type: "gap" });
      }

      compacted.push(lines[index]);
      previous = index;
    });

  return compacted;
}

function shouldIgnoreImportedPath(path: string) {
  const clean = cleanPath(path);
  const parts = clean.split("/");

  return (
    parts.includes("node_modules") ||
    parts.includes(".next") ||
    parts.includes(".git") ||
    parts.includes("dist") ||
    parts.includes("build") ||
    clean.endsWith("package-lock.json")
  );
}

async function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function importZipFile(file: File, baseFolder = "") {
  const zip = await JSZip.loadAsync(file);
  const imported: ProjectFile[] = [];
  const folderKeeps = new Set<string>();

  for (const [rawPath, entry] of Object.entries(zip.files)) {
    const path = cleanPath(rawPath);

    if (!path || shouldIgnoreImportedPath(path)) continue;

    const fullPath = baseFolder ? cleanPath(`${baseFolder}/${path}`) : path;

    if (entry.dir) {
      folderKeeps.add(cleanPath(`${fullPath}/.keep`));
      continue;
    }

    const parent = fullPath.split("/").slice(0, -1).join("/");
    if (parent) folderKeeps.add(cleanPath(`${parent}/.keep`));

    if (isBinaryLike(fullPath)) {
      imported.push({
        path: fullPath,
        content: `[Binary file imported from ZIP: ${fileName(fullPath)}]\nThis editor stores text files only.`
      });
      continue;
    }

    const content = await entry.async("text");
    imported.push({
      path: fullPath,
      content
    });
  }

  for (const keepPath of folderKeeps) {
    const folderHasFile = imported.some((item) => item.path.startsWith(keepPath.replace(/\/\.keep$/, "/")));
    const keepAlreadyImported = imported.some((item) => item.path === keepPath);

    if (!folderHasFile && !keepAlreadyImported) {
      imported.push({
        path: keepPath,
        content: ""
      });
    }
  }

  return imported;
}

async function walkEntry(entry: any, basePath = ""): Promise<ProjectFile[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file(async (file: File) => {
        if (file.name.toLowerCase().endsWith(".zip")) {
          const files = await importZipFile(file, basePath);
          resolve(files);
          return;
        }

        const content = await readFileAsText(file);
        resolve([
          {
            path: cleanPath(`${basePath}/${file.name}`),
            content
          }
        ]);
      });
    });
  }

  if (entry.isDirectory) {
    const reader = entry.createReader();

    return new Promise((resolve) => {
      reader.readEntries(async (entries: any[]) => {
        const groups = await Promise.all(
          entries.map((child) => walkEntry(child, cleanPath(`${basePath}/${entry.name}`)))
        );

        const files = groups.flat();

        if (files.length === 0) {
          files.push({
            path: cleanPath(`${basePath}/${entry.name}/.keep`),
            content: ""
          });
        }

        resolve(files);
      });
    });
  }

  return [];
}

async function safeJson(res: Response): Promise<AiResponse> {
  const text = await res.text();

  if (!text.trim()) {
    return {
      error: `Empty server response. Status: ${res.status}`
    };
  }

  try {
    return JSON.parse(text) as AiResponse;
  } catch {
    return {
      error: text.slice(0, 500)
    };
  }
}

export default function Home() {
  const [projectName, setProjectName] = useState("");
  const [projectCreated, setProjectCreated] = useState(false);
  const [files, setFiles] = useState<ProjectFile[]>([]);
  const [activePath, setActivePath] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [fileSearch, setFileSearch] = useState("");
  const [draftItem, setDraftItem] = useState<DraftItem | null>(null);
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [selectedProvider, setSelectedProvider] = useState("openai");
  const [selectedModel, setSelectedModel] = useState("gpt-5.4-mini");
  const [rightPanelTab, setRightPanelTab] = useState<RightPanelTab>("chat");
  const [chat, setChat] = useState<ChatEntry[]>([]);
  const [usageStats, setUsageStats] = useState<UsageStats>({
    lastInputTokens: 0,
    lastOutputTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    provider: "",
    model: ""
  });
  const [pendingChanges, setPendingChanges] = useState<AiChange[]>([]);
  const [previewChangeIndex, setPreviewChangeIndex] = useState<number | null>(null);
  const [proposalBaseline, setProposalBaseline] = useState<ProjectFile[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [thinkingElapsedSeconds, setThinkingElapsedSeconds] = useState(0);
  const [draggingExternal, setDraggingExternal] = useState(false);
  const [draggedPath, setDraggedPath] = useState("");
  const [dropFolder, setDropFolder] = useState("");
  const [toast, setToast] = useState("");
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT_WIDTH);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const draftInputRef = useRef<HTMLInputElement | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  const tree = useMemo(() => buildTree(files), [files]);
  const filteredTree = useMemo(() => filterTreeByQuery(tree, fileSearch), [tree, fileSearch]);
  const visibleFileCount = useMemo(() => {
    const query = fileSearch.trim().toLowerCase();
    const visibleFiles = files.filter((file) => !file.path.endsWith("/.keep"));

    if (!query) return visibleFiles.length;
    return visibleFiles.filter((file) => file.path.toLowerCase().includes(query) || fileName(file.path).toLowerCase().includes(query)).length;
  }, [fileSearch, files]);
  const appStyle = { "--sidebar-width": `${sidebarWidth}px` } as CSSProperties;
  const conversationTokens = useMemo(() => {
    return chat
      .filter((item) => !item.transient)
      .reduce((sum, item) => sum + item.estimatedTokens, 0);
  }, [chat]);
  const lastCostUsd = estimateCostUsd(
    usageStats.provider,
    usageStats.model,
    usageStats.lastInputTokens,
    usageStats.lastOutputTokens
  );
  const totalCostUsd = estimateCostUsd(
    usageStats.provider,
    usageStats.model,
    usageStats.totalInputTokens,
    usageStats.totalOutputTokens
  );
  const activePresetId =
    MODEL_PRESETS.find((preset) => preset.provider === selectedProvider && preset.model === selectedModel)?.id || "";
  const pendingFileCount = pendingChanges.length;

  const activeFile = useMemo(() => {
    return files.find((file) => file.path === activePath) || null;
  }, [files, activePath]);

  const previewChange = previewChangeIndex === null ? null : pendingChanges[previewChangeIndex] || null;
  const previewContent =
    previewChange
      ? previewChange.action === "delete"
        ? ""
        : previewChange.content || ""
      : activeFile?.content || "";

  const editorPath = previewChange?.path || activeFile?.path || "";
  const activeLanguage = editorPath ? getLanguage(editorPath) : "plaintext";
  const activeLineCount = previewContent ? previewContent.split("\n").length : activeFile?.content ? activeFile.content.split("\n").length : 0;
  const previewOriginalContent = useMemo(() => {
    if (!previewChange) return activeFile?.content || "";

    const path = cleanPath(previewChange.path);
    const baselineFile = proposalBaseline?.find((file) => cleanPath(file.path) === path);
    const currentFile = files.find((file) => cleanPath(file.path) === path);

    return baselineFile?.content || currentFile?.content || "";
  }, [activeFile, files, previewChange, proposalBaseline]);

  const previewDiff = useMemo(() => {
    if (!previewChange) return [];

    const path = cleanPath(previewChange.path);
    const before = previewOriginalContent;
    const after = previewChange.action === "delete" ? "" : previewChange.content || "";

    return compactDiffLines(buildLineDiff(before, after));
  }, [previewChange, previewOriginalContent]);

  useEffect(() => {
    const saved = localStorage.getItem("home-codex-project");
    if (!saved) return;

    const data = JSON.parse(saved);
    const savedProvider = normalizeProvider(data.selectedProvider || "openai");
    const savedModel = ALL_MODEL_VALUES.includes(data.selectedModel)
      ? data.selectedModel
      : DEFAULT_MODEL_BY_PROVIDER[savedProvider] || "gpt-5.4-mini";

    setProjectName(data.projectName || "");
    setProjectCreated(data.projectCreated || false);
    setFiles(data.files || []);
    setActivePath(data.activePath || "");
    setSelectedFolder(data.selectedFolder || "");
    setSelectedProvider(savedProvider);
    setSelectedModel(savedModel);
    setCollapsedFolders(Array.isArray(data.collapsedFolders) ? data.collapsedFolders : []);
    setSidebarWidth(
      typeof data.sidebarWidth === "number"
        ? clamp(data.sidebarWidth, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
        : SIDEBAR_DEFAULT_WIDTH
    );
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "home-codex-project",
      JSON.stringify({
        projectName,
        projectCreated,
        files,
        activePath,
        selectedFolder,
        selectedProvider,
        selectedModel,
        collapsedFolders,
        sidebarWidth
      })
    );
  }, [projectName, projectCreated, files, activePath, selectedFolder, selectedProvider, selectedModel, collapsedFolders, sidebarWidth]);

  useEffect(() => {
    if (selectedProvider === "auto" || isModelAllowedForProvider(selectedProvider, selectedModel)) return;
    setSelectedModel(DEFAULT_MODEL_BY_PROVIDER[selectedProvider] || "gpt-5.4-mini");
  }, [selectedProvider, selectedModel]);

  useEffect(() => {
    if (!toast) return;

    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!loading) {
      setThinkingElapsedSeconds(0);
      return;
    }

    setThinkingElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setThinkingElapsedSeconds((current) => current + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [loading]);

  useEffect(() => {
    if (!isResizingSidebar) return;

    const handleMouseMove = (event: MouseEvent) => {
      setSidebarWidth(clamp(event.clientX, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH));
    };

    const stopResize = () => {
      setIsResizingSidebar(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopResize);

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopResize);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    if (!draftItem) return;
    draftInputRef.current?.focus();
    draftInputRef.current?.select();
  }, [draftItem?.parentPath, draftItem?.type]);

  function createProject() {
    if (!projectName.trim()) return;
    setProjectCreated(true);
    setToast("Project created");
  }

  function fullPath(name: string) {
    const cleanName = cleanPath(name.trim());
    if (!selectedFolder) return cleanName;
    return cleanPath(`${selectedFolder}/${cleanName}`);
  }

  function upsertFiles(incoming: ProjectFile[]) {
    const validFiles = incoming.filter((file) => file.path && !file.path.endsWith("/"));

    setFiles((current) => {
      const map = new Map<string, ProjectFile>();

      for (const file of current) {
        map.set(cleanPath(file.path), file);
      }

      for (const file of validFiles) {
        map.set(cleanPath(file.path), {
          path: cleanPath(file.path),
          content: file.content
        });
      }

      return Array.from(map.values()).sort((a, b) => a.path.localeCompare(b.path));
    });

    const firstRealFile = validFiles.find((file) => !file.path.endsWith("/.keep"));

    if (firstRealFile?.path) {
      setActivePath(cleanPath(firstRealFile.path));
    }
  }

  function createUntitledFile() {
    let index = 1;
    let path = fullPath("untitled.txt");

    while (files.some((file) => file.path === path)) {
      index += 1;
      path = fullPath(`untitled-${index}.txt`);
    }

    upsertFiles([{ path, content: "" }]);
    setToast(`Created ${path}`);
  }

  function startDraft(type: DraftItem["type"]) {
    const parentPath = cleanPath(selectedFolder);
    const defaultName = type === "file" ? "untitled.txt" : "new-folder";

    if (parentPath) {
      setCollapsedFolders((current) => current.filter((item) => item !== parentPath));
    }

    setFileSearch("");
    setDraftItem({
      type,
      parentPath,
      name: defaultName
    });
  }

  function getDraftPath(draft: DraftItem) {
    const cleanName = cleanPath(draft.name.trim()).replace(/\/+$/, "");
    if (!cleanName) return "";
    return draft.parentPath ? cleanPath(`${draft.parentPath}/${cleanName}`) : cleanName;
  }

  function commitDraft() {
    if (!draftItem) return;

    const path = getDraftPath(draftItem);

    if (!path) {
      setDraftItem(null);
      return;
    }

    if (draftItem.type === "folder") {
      const folderPath = path.replace(/\/+$/, "");
      const keepPath = `${folderPath}/.keep`;

      if (files.some((file) => file.path === keepPath || file.path.startsWith(`${folderPath}/`))) {
        setToast("A folder with that name already exists");
        draftInputRef.current?.focus();
        return;
      }

      upsertFiles([{ path: keepPath, content: "" }]);
      setSelectedFolder(folderPath);
      setDraftItem(null);
      setToast(`Created folder ${folderPath}`);
      return;
    }

    if (files.some((file) => file.path === path)) {
      setToast("A file with that name already exists");
      draftInputRef.current?.focus();
      return;
    }

    upsertFiles([{ path, content: "" }]);
    setDraftItem(null);
    setToast(`Created ${path}`);
  }

  function cancelDraft() {
    setDraftItem(null);
  }

  function updateActiveFile(content: string) {
    if (previewChange) return;

    setFiles((current) =>
      current.map((file) => {
        if (file.path !== activePath) return file;
        return { ...file, content };
      })
    );
  }

  function deleteFile(path: string) {
    const ok = window.confirm(`Are you sure you want to delete "${path}"?`);
    if (!ok) return;

    setFiles((current) => current.filter((file) => file.path !== path));

    if (activePath === path) {
      setActivePath("");
    }

    setPreviewChangeIndex(null);
    setToast(`Deleted ${path}`);
  }

  function deleteFolder(path: string) {
    const clean = cleanPath(path);
    const affected = files.filter((file) => file.path === `${clean}/.keep` || file.path.startsWith(`${clean}/`));

    const ok = window.confirm(
      `Are you sure you want to delete folder "${clean}" and ${affected.length} file/item${affected.length === 1 ? "" : "s"} inside it?`
    );

    if (!ok) return;

    setFiles((current) => current.filter((file) => !(file.path === `${clean}/.keep` || file.path.startsWith(`${clean}/`))));

    if (activePath.startsWith(`${clean}/`)) {
      setActivePath("");
    }

    if (selectedFolder === clean || selectedFolder.startsWith(`${clean}/`)) {
      setSelectedFolder("");
    }

    setPreviewChangeIndex(null);
    setToast(`Deleted folder ${clean}`);
  }

  function moveFileToFolder(sourcePath: string, targetFolder: string) {
    const source = cleanPath(sourcePath);
    const target = cleanPath(targetFolder);
    const newPath = target ? cleanPath(`${target}/${fileName(source)}`) : fileName(source);

    if (source === newPath) return;

    if (files.some((file) => file.path === newPath)) {
      setToast("A file with that name already exists there");
      return;
    }

    setFiles((current) =>
      current.map((file) => {
        if (file.path !== source) return file;
        return {
          ...file,
          path: newPath
        };
      })
    );

    if (activePath === source) {
      setActivePath(newPath);
    }

    setToast(`Moved to ${target || "/"}`);
  }

  async function importFilesFromInput(selectedFiles: FileList | null) {
    if (!selectedFiles) return;

    const groups = await Promise.all(
      Array.from(selectedFiles).map(async (file) => {
        const relativePath = cleanPath((file as any).webkitRelativePath || file.name);

        if (file.name.toLowerCase().endsWith(".zip")) {
          return importZipFile(file, selectedFolder);
        }

        const path = selectedFolder ? cleanPath(`${selectedFolder}/${relativePath}`) : relativePath;
        const content = await readFileAsText(file);

        return [
          {
            path,
            content
          }
        ];
      })
    );

    const imported = groups.flat();

    upsertFiles(imported);
    setPreviewChangeIndex(null);
    setToast(`Imported ${imported.length} file/item${imported.length === 1 ? "" : "s"}`);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  async function handleExternalDrop(e: DragEvent<HTMLElement>) {
    e.preventDefault();
    setDraggingExternal(false);

    if (draggedPath) return;

    const items = Array.from(e.dataTransfer.items || []);
    const entries = items
      .map((item: any) => item.webkitGetAsEntry?.())
      .filter(Boolean);

    if (entries.length > 0) {
      const groups = await Promise.all(entries.map((entry) => walkEntry(entry, selectedFolder)));
      const imported = groups.flat();

      upsertFiles(imported);
      setPreviewChangeIndex(null);
      setToast(`Imported ${imported.length} file/item${imported.length === 1 ? "" : "s"}`);
      return;
    }

    const droppedFiles = e.dataTransfer.files;

    if (droppedFiles.length > 0) {
      await importFilesFromInput(droppedFiles);
    }
  }

  async function exportProject() {
    const zip = new JSZip();
    const visibleFiles = files.filter((file) => !file.path.endsWith("/.keep"));

    for (const file of visibleFiles) {
      if (file.content.startsWith("[Binary file imported from ZIP:")) continue;
      zip.file(file.path, file.content);
    }

    const blob = await zip.generateAsync({ type: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `${projectName || "home-codex-project"}.zip`;
    link.click();

    URL.revokeObjectURL(url);
    setToast("Project exported");
  }

  function getActiveModel() {
    return selectedModel;
  }

  function applyModelPreset(preset: ModelPreset) {
    setSelectedProvider(preset.provider);
    setSelectedModel(preset.model);
    setToast(`${preset.label}: ${preset.provider} / ${preset.model}`);
  }

  async function askAi() {
    if (loading) return;
    if (!message.trim()) return;

    const userMessage = message;
    const compactHistory = buildCompactHistory(chat, userMessage);
    const payload = {
      password,
      provider: selectedProvider,
      model: getActiveModel(),
      messages: compactHistory,
      message: userMessage,
      activePath,
      selectedFolder,
      files,
      mode: "code-edit",
      proceedLargeRequest: false
    };
    let requestBody = JSON.stringify(payload);

    if (requestBody.length > LARGE_REQUEST_CONFIRM_CHARS) {
      const shouldProceed = window.confirm(
        `This request is ${formatCharacterCount(requestBody.length)} characters. Would you like to proceed?`
      );

      if (!shouldProceed) {
        setToast("Large request cancelled");
        return;
      }

      payload.proceedLargeRequest = true;
      requestBody = JSON.stringify(payload);
    }

    const controller = new AbortController();
    aiAbortRef.current = controller;

    setLoading(true);
    setPendingChanges([]);
    setPreviewChangeIndex(null);
    setProposalBaseline(null);
    setChat((current) => [
      ...current,
      createChatEntry("user", userMessage),
      createChatEntry("system", `${selectedProvider} / ${getActiveModel()} is thinking`, true)
    ]);

    try {
      let res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: requestBody,
        signal: controller.signal
      });

      let data = await safeJson(res);

      if (res.status === 413 && data.requiresConfirmation) {
        const inputChars = data.inputChars || requestBody.length;
        const shouldProceed = window.confirm(
          `This request is ${formatCharacterCount(inputChars)} characters. Would you like to proceed?`
        );

        if (!shouldProceed) {
          setChat((current) => [
            ...current.filter((item) => !item.transient),
            createChatEntry("system", "Large request cancelled.")
          ]);
          setToast("Large request cancelled");
          return;
        }

        payload.proceedLargeRequest = true;
        requestBody = JSON.stringify(payload);
        res = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: requestBody,
          signal: controller.signal
        });
        data = await safeJson(res);
      }

      const responseProvider = data.provider || selectedProvider;
      const responseModel = data.model || getActiveModel();
      const inputTokens = Math.max(0, Math.round(data.estimatedTokens || 0));
      const outputTextForEstimate =
        data.text ||
        data.message ||
        data.error ||
        (data.changes?.length ? JSON.stringify(data.changes) : "");
      const outputTokens = outputTextForEstimate ? estimateTokens(outputTextForEstimate) : 0;

      setChat((current) => current.filter((item) => !item.transient));
      setUsageStats((current) => ({
        lastInputTokens: inputTokens,
        lastOutputTokens: outputTokens,
        totalInputTokens: current.totalInputTokens + inputTokens,
        totalOutputTokens: current.totalOutputTokens + outputTokens,
        provider: responseProvider,
        model: responseModel
      }));

      if (!res.ok) {
        setChat((current) => [
          ...current,
          createChatEntry("ai", data.error || `Request failed with status ${res.status}.`)
        ]);

        setToast("Request failed");
        return;
      }

      setChat((current) => [...current, createChatEntry("ai", data.message || "Done.", false, data.usedFiles || [])]);

      if (data.type === "edit" && data.changes?.length) {
        setProposalBaseline(files.map((file) => ({ ...file })));
        setPendingChanges(data.changes);
        const firstPreviewIndex = data.changes.findIndex((change) => change.action !== "delete");
        setPreviewChangeIndex(firstPreviewIndex >= 0 ? firstPreviewIndex : null);
        setRightPanelTab("changes");
        setToast("AI prepared file changes");
      } else {
        setRightPanelTab("chat");
        setToast("AI answered");
      }
    } catch (error) {
      setChat((current) => current.filter((item) => !item.transient));

      if (error instanceof DOMException && error.name === "AbortError") {
        setChat((current) => [...current, createChatEntry("system", "AI stopped.")]);
        setToast("AI stopped");
      } else {
        setChat((current) => [...current, createChatEntry("ai", "Connection failed.")]);
        setToast("Connection failed");
      }
    } finally {
      setMessage("");
      setLoading(false);
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
      }
    }
  }

  function stopAi() {
    aiAbortRef.current?.abort();
  }

  function applyChangeSet(changes: AiChange[]) {
    setFiles((current) => {
      let next = [...current];

      for (const change of changes) {
        const path = cleanPath(change.path);

        if (change.action === "delete") {
          next = next.filter((file) => file.path !== path);
        }

        if (change.action === "update") {
          const exists = next.some((file) => file.path === path);

          if (exists) {
            next = next.map((file) => {
              if (file.path !== path) return file;
              return { ...file, content: change.content || "" };
            });
          } else {
            next.push({
              path,
              content: change.content || ""
            });
          }
        }

        if (change.action === "create") {
          const exists = next.some((file) => file.path === path);

          if (!exists) {
            next.push({
              path,
              content: change.content || ""
            });
          } else {
            next = next.map((file) => {
              if (file.path !== path) return file;
              return { ...file, content: change.content || file.content };
            });
          }
        }
      }

      return next.sort((a, b) => a.path.localeCompare(b.path));
    });
  }

  function removePendingChangePaths(paths: Set<string>) {
    setPendingChanges((current) => current.filter((change) => !paths.has(cleanPath(change.path))));
    setPreviewChangeIndex(null);
  }

  function restoreChangeSet(changes: AiChange[]) {
    const affectedPaths = new Set(changes.map((change) => cleanPath(change.path)));
    const baselineMap = new Map((proposalBaseline || []).map((file) => [cleanPath(file.path), file]));

    if (affectedPaths.size > 0 && proposalBaseline) {
      setFiles((current) => {
        const restored = current
          .filter((file) => {
            const path = cleanPath(file.path);
            return !affectedPaths.has(path) || baselineMap.has(path);
          })
          .map((file) => {
            const path = cleanPath(file.path);
            const baselineFile = baselineMap.get(path);

            if (!affectedPaths.has(path) || !baselineFile) return file;
            return { ...file, content: baselineFile.content };
          });

        for (const path of affectedPaths) {
          if (restored.some((file) => cleanPath(file.path) === path)) continue;

          const baselineFile = baselineMap.get(path);
          if (baselineFile) restored.push({ ...baselineFile });
        }

        return restored.sort((a, b) => a.path.localeCompare(b.path));
      });

      if (activePath && affectedPaths.has(cleanPath(activePath)) && !baselineMap.has(cleanPath(activePath))) {
        setActivePath("");
      }
    }
  }

  function applySingleChange(index: number) {
    const change = pendingChanges[index];
    if (!change) return;

    applyChangeSet([change]);
    removePendingChangePaths(new Set([cleanPath(change.path)]));
    setToast(`Applied ${change.path}`);
  }

  function discardSingleChange(index: number) {
    const change = pendingChanges[index];
    if (!change) return;

    restoreChangeSet([change]);
    removePendingChangePaths(new Set([cleanPath(change.path)]));
    setToast(`Discarded ${change.path}`);
  }

  function previewNextChange() {
    if (pendingChanges.length === 0) return;
    setPreviewChangeIndex((current) => {
      if (current === null) return 0;
      return (current + 1) % pendingChanges.length;
    });
  }

  function applyChanges() {
    applyChangeSet(pendingChanges);

    const firstChange = pendingChanges.find((change) => change.action !== "delete");

    if (firstChange?.path) {
      setActivePath(cleanPath(firstChange.path));
    }

    setPendingChanges([]);
    setPreviewChangeIndex(null);
    setProposalBaseline(null);
    setToast("Changes applied successfully");
  }

  function discardChanges() {
    restoreChangeSet(pendingChanges);

    setPendingChanges([]);
    setPreviewChangeIndex(null);
    setProposalBaseline(null);
    setToast("Changes discarded");
  }

  function toggleFolder(path: string) {
    setCollapsedFolders((current) =>
      current.includes(path) ? current.filter((item) => item !== path) : [...current, path]
    );
  }

  function startSidebarResize(e: ReactMouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    setIsResizingSidebar(true);
  }

  function renderDraftRow(parentPath: string, depth: number) {
    if (!draftItem || draftItem.parentPath !== parentPath) return null;

    return (
      <div className="treeItem draftTreeItem" style={{ paddingLeft: `${12 + depth * 16}px` }}>
        <span className={draftItem.type === "folder" ? "folderEmoji" : "fileIcon"}>
          {draftItem.type === "folder" ? "DIR" : getFileIcon(draftItem.name)}
        </span>
        <input
          ref={draftInputRef}
          value={draftItem.name}
          onChange={(e) => setDraftItem((current) => current ? { ...current, name: e.target.value } : current)}
          onBlur={commitDraft}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitDraft();
            }

            if (e.key === "Escape") {
              e.preventDefault();
              cancelDraft();
            }
          }}
        />
      </div>
    );
  }

  function renderTree(nodes: TreeNode[], depth = 0) {
    return nodes.map((node) => {
      if (node.type === "folder") {
        const isSearchingFiles = Boolean(fileSearch.trim());
        const isCollapsed = !isSearchingFiles && collapsedFolders.includes(node.path);

        return (
          <div key={node.path}>
            <div
              className={
                selectedFolder === node.path || dropFolder === node.path
                  ? `treeItem folderItem selectedFolder${isCollapsed ? " collapsedFolder" : ""}`
                  : `treeItem folderItem${isCollapsed ? " collapsedFolder" : ""}`
              }
              style={{ paddingLeft: `${12 + depth * 16}px` }}
              role="button"
              tabIndex={0}
              onClick={() => {
                setSelectedFolder(node.path);
                setPreviewChangeIndex(null);
                toggleFolder(node.path);
              }}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                setSelectedFolder(node.path);
                setPreviewChangeIndex(null);
                toggleFolder(node.path);
              }}
              onDragOver={(e) => {
                if (!draggedPath) return;
                e.preventDefault();
                setDropFolder(node.path);
              }}
              onDragLeave={() => setDropFolder("")}
              onDrop={(e) => {
                if (!draggedPath) return;
                e.preventDefault();
                e.stopPropagation();
                moveFileToFolder(draggedPath, node.path);
                setDraggedPath("");
                setDropFolder("");
              }}
            >
              <span className={isCollapsed ? "folderIcon" : "folderIcon open"}>&gt;</span>
              <span className="folderEmoji">DIR</span>
              <span className="treeLabel" title={node.path}>{node.name}</span>
              <span
                className="deleteIcon"
                title="Delete folder"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteFolder(node.path);
                }}
              >
                x
              </span>
            </div>

            {!isCollapsed && (
              <div className="treeBranch">
                {renderDraftRow(node.path, depth + 1)}
                {renderTree(node.children, depth + 1)}
              </div>
            )}
          </div>
        );
      }

      if (node.name === ".keep") return null;

      return (
        <button
          key={node.path}
          draggable
          className={activePath === node.path && !previewChange ? "treeItem fileItem activeFile" : "treeItem fileItem"}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => {
            setActivePath(node.path);
            setPreviewChangeIndex(null);
          }}
          onDragStart={(e) => {
            setDraggedPath(node.path);
            e.dataTransfer.setData("text/plain", node.path);
            e.dataTransfer.effectAllowed = "move";
          }}
          onDragEnd={() => {
            setDraggedPath("");
            setDropFolder("");
          }}
        >
          <span className="fileIcon">{getFileIcon(node.path)}</span>
          <span className="treeLabel" title={node.path}>{node.name}</span>
          <span
            className="deleteIcon"
            title="Delete file"
            onClick={(e) => {
              e.stopPropagation();
              deleteFile(node.path);
            }}
          >
            x
          </span>
        </button>
      );
    });
  }

  if (!projectCreated) {
    return (
      <main className="startScreen">
        {toast && <div className="toast">{toast}</div>}

        <div className="startCard">
          <div className="brand">Home Codex</div>
          <h1>Create a project</h1>
          <p>Import files or ZIPs, edit code, ask questions, and let AI create or update files.</p>

          <input
            value={projectName}
            onChange={(e) => setProjectName(e.target.value)}
            placeholder="my-python-app"
          />

          <button onClick={createProject}>Create Project</button>
        </div>
      </main>
    );
  }

  return (
    <main
      className={`${draggingExternal ? "appShell dragging" : "appShell"}${isResizingSidebar ? " resizingSidebar" : ""}`}
      style={appStyle}
      onDragOver={(e) => {
        e.preventDefault();

        if (!draggedPath) {
          setDraggingExternal(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) {
          setDraggingExternal(false);
        }
      }}
      onDrop={handleExternalDrop}
    >
      {toast && <div className="toast">{toast}</div>}

      {draggingExternal && !draggedPath && (
        <div className="dropOverlay">
          <div>Drop files, folders, or ZIPs to import</div>
        </div>
      )}

      <aside className="sidebar">
        <div className="sidebarTop">
          <div>
            <div className="label">PROJECT</div>
            <div className="projectTitle">{projectName}</div>
          </div>
        </div>

        <div className="toolbar">
          <button onClick={() => fileInputRef.current?.click()}>Import / ZIP</button>
          <button onClick={exportProject}>Export ZIP</button>
        </div>

        <input
          ref={fileInputRef}
          className="hiddenInput"
          type="file"
          multiple
          accept=".zip,.txt,.js,.jsx,.ts,.tsx,.py,.html,.css,.json,.md,.env"
          onChange={(e) => importFilesFromInput(e.target.files)}
        />

        <div className="selectedFolderBox">
          <span>Current folder</span>
          <strong>{selectedFolder || "/"}</strong>
        </div>

        <div className="treeRoot">
          <div className="treeActionBar">
            <button type="button" onClick={() => startDraft("file")}>+ File</button>
            <button type="button" onClick={() => startDraft("folder")}>+ Folder</button>
          </div>

          <div className="fileSearchBox">
            <input
              value={fileSearch}
              onChange={(e) => setFileSearch(e.target.value)}
              placeholder="Search files"
            />
            {fileSearch && (
              <button
                type="button"
                onClick={() => setFileSearch("")}
                aria-label="Clear file search"
                title="Clear file search"
              >
                x
              </button>
            )}
          </div>

          <div className="treeSectionTitle">
            <span>{fileSearch.trim() ? "Search results" : "Files"}</span>
            <strong>{visibleFileCount}</strong>
          </div>

          <button
            className={
              selectedFolder === "" || dropFolder === "__root__"
                ? "treeItem folderItem rootItem selectedFolder"
                : "treeItem folderItem rootItem"
            }
            onClick={() => {
              setSelectedFolder("");
              setPreviewChangeIndex(null);
            }}
            onDragOver={(e) => {
              if (!draggedPath) return;
              e.preventDefault();
              setDropFolder("__root__");
            }}
            onDragLeave={() => setDropFolder("")}
            onDrop={(e) => {
              if (!draggedPath) return;
              e.preventDefault();
              e.stopPropagation();
              moveFileToFolder(draggedPath, "");
              setDraggedPath("");
              setDropFolder("");
            }}
          >
            <span className="folderEmoji">DIR</span>
            <span className="treeLabel" title="/">/</span>
          </button>

          {renderDraftRow("", 0)}

          {visibleFileCount === 0 && fileSearch.trim() ? (
            <div className="emptySearch">No matching files</div>
          ) : (
            renderTree(filteredTree)
          )}
        </div>
      </aside>

      <button
        className="sidebarResizeHandle"
        type="button"
        aria-label="Resize files sidebar"
        title="Drag to resize files sidebar"
        onMouseDown={startSidebarResize}
      />

      <section className="editor">
        {pendingFileCount > 0 && (
          <div className="proposalBar">
            <div>
              <strong>AI proposal ready</strong>
              <span>{pendingFileCount} file{pendingFileCount === 1 ? "" : "s"} pending</span>
            </div>
            <div className="proposalActions">
              <button type="button" onClick={previewNextChange}>Next</button>
              <button type="button" onClick={() => setRightPanelTab("changes")}>Review</button>
              <button type="button" className="proposalApply" onClick={applyChanges}>Apply all</button>
              <button type="button" className="proposalDiscard" onClick={discardChanges}>Discard all</button>
            </div>
          </div>
        )}

        {editorPath ? (
          <>
            <div className={previewChange ? "editorHeader previewHeader" : "editorHeader"}>
              <div className="editorTitle">
                <span className="fileIcon large">{getFileIcon(editorPath)}</span>
                <span>
                  {previewChange ? `Preview: ${previewChange.action.toUpperCase()} ${editorPath}` : editorPath}
                </span>
              </div>
              <div className="editorToolbar">
                {previewChange ? (
                  <>
                    <button type="button" onClick={applyChanges}>Apply all</button>
                    <button type="button" onClick={discardChanges}>Discard all</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => navigator.clipboard?.writeText(editorPath)}>Copy path</button>
                    <button type="button" onClick={exportProject}>Export ZIP</button>
                  </>
                )}
              </div>
            </div>

            <div className="monacoWrap">
              {previewChange ? (
                <div className="diffEditorShell">
                  <div className="diffPaneLabels">
                    <span>Original</span>
                    <span>AI proposal</span>
                  </div>
                  <MonacoDiffEditor
                    height="100%"
                    theme="vs-dark"
                    language={getLanguage(editorPath)}
                    original={previewOriginalContent}
                    modified={previewContent}
                    options={{
                      readOnly: true,
                      renderSideBySide: true,
                      minimap: { enabled: false },
                      fontSize: 14,
                      lineNumbers: "on",
                      wordWrap: "on",
                      scrollBeyondLastLine: false,
                      automaticLayout: true
                    }}
                  />
                </div>
              ) : (
                <MonacoEditor
                  height="100%"
                  theme="vs-dark"
                  language={getLanguage(editorPath)}
                  value={previewContent}
                  onChange={(value) => updateActiveFile(value || "")}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    lineNumbers: "on",
                    wordWrap: "on",
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    tabSize: 2
                  }}
                />
              )}
            </div>
          </>
        ) : (
          <div className="emptyEditor">
            <div>
              <h2>No file selected</h2>
              <p>Choose a file, create one, or drag files/ZIPs into the app.</p>
              <div className="emptyActions">
                <button type="button" onClick={createUntitledFile}>Create file</button>
                <button type="button" onClick={() => fileInputRef.current?.click()}>Import files</button>
                <button type="button" onClick={() => setMessage("Create a simple app in this project.")}>Ask AI</button>
              </div>
            </div>
          </div>
        )}

        <div className="editorStatusBar">
          <span>{editorPath || "No file selected"}</span>
          <span>{activeLanguage}</span>
          <span>{activeLineCount.toLocaleString()} lines</span>
          <span>{previewChange ? "Previewing AI proposal" : pendingFileCount > 0 ? "Proposal pending" : "Ready"}</span>
          <span>{selectedProvider} / {selectedModel}</span>
        </div>
      </section>

      <aside className="chatPanel">
        <div className="chatHeader">
          <div>
            <div className="label">ASSISTANT</div>
            <h2>AI Editor</h2>
          </div>
          <span>{files.filter((file) => !file.path.endsWith("/.keep")).length} files</span>
        </div>

        <div className="assistantControls">
          <details className="passwordDropdown">
            <summary>
              <span>App password</span>
              <strong>{password ? "Set" : "Required"}</strong>
            </summary>

            <input
              className="passwordInput"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter app password"
              type="password"
            />
          </details>

          <div className="modelBox">
            <div className="presetBox">
              {MODEL_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={activePresetId === preset.id ? "presetButton activePreset" : "presetButton"}
                  onClick={() => applyModelPreset(preset)}
                  title={`${preset.provider} / ${preset.model}`}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <div className="modelField">
              <label>Provider</label>

              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
              >
                {PROVIDER_OPTIONS.map((provider) => (
                  <option key={provider.value} value={provider.value}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </div>

            <div className="modelField">
              <label>Model</label>

              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
              >
                {MODEL_GROUPS.map((group) => (
                  <optgroup key={group.provider} label={group.label}>
                    {group.models.map((model) => (
                      <option
                        key={model.value}
                        value={model.value}
                        disabled={selectedProvider !== "auto" && selectedProvider !== group.provider}
                      >
                        {model.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="rightTabs" role="tablist" aria-label="Assistant panel">
          <button
            type="button"
            className={rightPanelTab === "chat" ? "activeTab" : ""}
            onClick={() => setRightPanelTab("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            className={rightPanelTab === "changes" ? "activeTab" : ""}
            onClick={() => setRightPanelTab("changes")}
          >
            Changes{pendingFileCount > 0 ? ` ${pendingFileCount}` : ""}
          </button>
          <button
            type="button"
            className={rightPanelTab === "usage" ? "activeTab" : ""}
            onClick={() => setRightPanelTab("usage")}
          >
            Usage
          </button>
        </div>

        {rightPanelTab === "chat" && (
          <section className="conversation">
            <div className="panelTitle">
              <span>Conversation</span>
              <strong>{selectedProvider} / {selectedModel}</strong>
            </div>

            <div className="chatBox">
              {chat.length === 0 ? (
                <div className="chatEmpty">
                  <strong>Ready when you are.</strong>
                  <span>Ask for a file, a refactor, a bug fix, or an explanation.</span>
                </div>
              ) : (
                chat.map((item, index) => {
                  const displayText =
                    item.transient && loading
                      ? `${item.text} (thinking for ${thinkingElapsedSeconds} seconds)`
                      : item.text;

                  return (
                    <div
                      key={index}
                      className={
                        item.role === "user"
                          ? "bubble user"
                          : item.role === "system"
                            ? "bubble system"
                            : "bubble ai"
                      }
                    >
                      <div className="bubbleMeta">
                        <span>{item.role === "user" ? "You" : item.role === "system" ? "System" : "AI"}</span>
                        <span className="bubbleStats">
                          <span>{item.estimatedTokens.toLocaleString()} tokens</span>
                          <time dateTime={item.createdAt}>{formatChatTime(item.createdAt)}</time>
                        </span>
                      </div>
                      <div className="bubbleText">{displayText}</div>
                      {item.usedFiles && item.usedFiles.length > 0 && (
                        <details className="usedFiles">
                          <summary>Context used</summary>
                          <div>
                            {item.usedFiles.map((path) => (
                              <code key={path}>{path}</code>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        )}

        {rightPanelTab === "changes" && (
          <div className={pendingChanges.length > 0 ? "changesBox changesPanel" : "changesBox changesPanel emptyChangesPanel"}>
            <div className="changesHeader">
              <strong>Pending changes</strong>
              {pendingChanges.length > 0 && (
                <div className="changesHeaderActions">
                  <button onClick={applyChanges}>Apply all</button>
                  <button onClick={discardChanges}>Discard all</button>
                </div>
              )}
            </div>

            {pendingChanges.length === 0 ? (
              <div className="chatEmpty">
                <strong>No pending changes.</strong>
                <span>AI proposals will appear here with per-file controls.</span>
              </div>
            ) : (
              pendingChanges.map((change, index) => (
                <div key={index} className={previewChangeIndex === index ? "changeItem activeChangeItem" : "changeItem"}>
                  <span>{change.action}</span>
                  <code>{change.path}</code>
                  <div className="changeActions">
                    <button className="previewButton" onClick={() => setPreviewChangeIndex(index)}>Preview</button>
                    <button className="previewButton applyMini" onClick={() => applySingleChange(index)}>Apply</button>
                    <button className="previewButton dangerMini" onClick={() => discardSingleChange(index)}>Discard</button>
                  </div>
                </div>
              ))
            )}

            {previewChange && (
              <div className="diffPreview">
                <div className="diffHeader">
                  <span>{previewChange.action.toUpperCase()}</span>
                  <code>{previewChange.path}</code>
                </div>

                <div className="diffLines">
                  {previewDiff.map((line, index) => {
                    if (line.type === "gap") {
                      return (
                        <div key={index} className="diffLine diffGap">
                          ...
                        </div>
                      );
                    }

                    const marker = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
                    const lineNumber = line.type === "add" ? line.newLine : line.oldLine;

                    return (
                      <div key={index} className={`diffLine ${line.type === "add" ? "diffAdd" : line.type === "remove" ? "diffRemove" : "diffContext"}`}>
                        <span className="diffMarker">{marker}</span>
                        <span className="diffNumber">{lineNumber || ""}</span>
                        <code>{line.text || " "}</code>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {rightPanelTab === "usage" && (
          <section className="usagePanel usagePanelFull">
            <div className="panelTitle compactTitle">
              <span>Token Usage</span>
              <strong>{usageStats.model || selectedModel}</strong>
            </div>

            <div className="usageGrid">
              <div>
                <span>Last input</span>
                <strong>{usageStats.lastInputTokens.toLocaleString()}</strong>
              </div>
              <div>
                <span>Last output</span>
                <strong>{usageStats.lastOutputTokens.toLocaleString()}</strong>
              </div>
              <div>
                <span>Conversation</span>
                <strong>{conversationTokens.toLocaleString()}</strong>
              </div>
              <div>
                <span>Total API</span>
                <strong>{(usageStats.totalInputTokens + usageStats.totalOutputTokens).toLocaleString()}</strong>
              </div>
              <div>
                <span>Last cost</span>
                <strong>{formatUsd(lastCostUsd)}</strong>
              </div>
              <div>
                <span>Session cost</span>
                <strong>{formatUsd(totalCostUsd)}</strong>
              </div>
            </div>
          </section>
        )}

        <div className="composer">
          <textarea
            className="messageBox"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Ask AI to explain, refactor, fix bugs, or create files..."
          />

          <button
            className={loading ? "sendButton stopButton" : "sendButton"}
            onClick={loading ? stopAi : askAi}
          >
            {loading ? "Stop" : "Send"}
          </button>
        </div>
      </aside>
    </main>
  );
}
