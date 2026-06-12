"use client";

import dynamic from "next/dynamic";
import { DragEvent, useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import "./globals.css";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

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
  error?: string;
};

type TreeNode = {
  name: string;
  path: string;
  type: "folder" | "file";
  children: TreeNode[];
};

function cleanPath(path: string) {
  return path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+/g, "/");
}

function fileName(path: string) {
  return cleanPath(path).split("/").filter(Boolean).pop() || path;
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

function getFileIcon(path: string) {
  if (path.endsWith(".py")) return "🐍";
  if (path.endsWith(".tsx") || path.endsWith(".ts")) return "TS";
  if (path.endsWith(".jsx") || path.endsWith(".js")) return "JS";
  if (path.endsWith(".html")) return "🌐";
  if (path.endsWith(".css")) return "#";
  if (path.endsWith(".json")) return "{}";
  if (path.endsWith(".md")) return "MD";
  if (path.endsWith(".env")) return "🔐";
  return "📄";
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

async function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function walkEntry(entry: any, basePath = ""): Promise<ProjectFile[]> {
  if (entry.isFile) {
    return new Promise((resolve) => {
      entry.file(async (file: File) => {
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
    return JSON.parse(text);
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
  const [newItemName, setNewItemName] = useState("");
  const [message, setMessage] = useState("");
  const [password, setPassword] = useState("");
  const [chat, setChat] = useState<{ role: "user" | "ai" | "system"; text: string }[]>([]);
  const [pendingChanges, setPendingChanges] = useState<AiChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [draggingExternal, setDraggingExternal] = useState(false);
  const [draggedPath, setDraggedPath] = useState("");
  const [dropFolder, setDropFolder] = useState("");
  const [toast, setToast] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const tree = useMemo(() => buildTree(files), [files]);

  const activeFile = useMemo(() => {
    return files.find((file) => file.path === activePath) || null;
  }, [files, activePath]);

  useEffect(() => {
    const saved = localStorage.getItem("home-codex-project");
    if (!saved) return;

    const data = JSON.parse(saved);
    setProjectName(data.projectName || "");
    setProjectCreated(data.projectCreated || false);
    setFiles(data.files || []);
    setActivePath(data.activePath || "");
    setSelectedFolder(data.selectedFolder || "");
  }, []);

  useEffect(() => {
    localStorage.setItem(
      "home-codex-project",
      JSON.stringify({
        projectName,
        projectCreated,
        files,
        activePath,
        selectedFolder
      })
    );
  }, [projectName, projectCreated, files, activePath, selectedFolder]);

  useEffect(() => {
    if (!toast) return;

    const timer = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timer);
  }, [toast]);

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

    if (validFiles[0]?.path) {
      setActivePath(cleanPath(validFiles[0].path));
    }
  }

  function addFile() {
    const name = newItemName.trim();
    if (!name) return;

    const path = fullPath(name);
    if (files.some((file) => file.path === path)) return;

    upsertFiles([{ path, content: "" }]);
    setNewItemName("");
    setToast(`Created ${path}`);
  }

  function addFolder() {
    const name = newItemName.trim().replace(/\/+$/, "");
    if (!name) return;

    const folderPath = fullPath(name);
    const keepPath = `${folderPath}/.keep`;

    if (files.some((file) => file.path === keepPath)) return;

    upsertFiles([{ path: keepPath, content: "" }]);
    setSelectedFolder(folderPath);
    setNewItemName("");
    setToast(`Created folder ${folderPath}`);
  }

  function updateActiveFile(content: string) {
    setFiles((current) =>
      current.map((file) => {
        if (file.path !== activePath) return file;
        return { ...file, content };
      })
    );
  }

  function deleteFile(path: string) {
    setFiles((current) => current.filter((file) => file.path !== path));

    if (activePath === path) {
      setActivePath("");
    }

    setToast(`Deleted ${path}`);
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

    const imported = await Promise.all(
      Array.from(selectedFiles).map(async (file) => {
        const relativePath = cleanPath((file as any).webkitRelativePath || file.name);
        const path = selectedFolder ? cleanPath(`${selectedFolder}/${relativePath}`) : relativePath;
        const content = await readFileAsText(file);

        return {
          path,
          content
        };
      })
    );

    upsertFiles(imported);
    setToast(`Imported ${imported.length} file${imported.length === 1 ? "" : "s"}`);

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
      setToast(`Imported ${imported.length} file${imported.length === 1 ? "" : "s"}`);
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

  async function askAi() {
    if (!message.trim()) return;

    const userMessage = message;

    setLoading(true);
    setPendingChanges([]);
    setChat((current) => [
      ...current,
      { role: "user", text: userMessage },
      { role: "system", text: "Model is thinking..." }
    ]);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          password,
          message: userMessage,
          files
        })
      });

      const data = await safeJson(res);

      setChat((current) => current.filter((item) => item.text !== "Model is thinking..."));

      if (!res.ok) {
        setChat((current) => [
          ...current,
          {
            role: "ai",
            text: data.error || `Request failed with status ${res.status}.`
          }
        ]);

        setToast("Request failed");
        return;
      }

      setChat((current) => [...current, { role: "ai", text: data.message || "Done." }]);

      if (data.type === "edit" && data.changes?.length) {
        setPendingChanges(data.changes);
        setToast("AI prepared file changes");
      } else {
        setToast("AI answered");
      }
    } catch {
      setChat((current) => current.filter((item) => item.text !== "Model is thinking..."));
      setChat((current) => [...current, { role: "ai", text: "Connection failed." }]);
      setToast("Connection failed");
    } finally {
      setMessage("");
      setLoading(false);
    }
  }

  function applyChanges() {
    setFiles((current) => {
      let next = [...current];

      for (const change of pendingChanges) {
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

    const firstChange = pendingChanges.find((change) => change.action !== "delete");

    if (firstChange?.path) {
      setActivePath(cleanPath(firstChange.path));
    }

    setPendingChanges([]);
    setToast("Changes applied successfully");
  }

  function renderTree(nodes: TreeNode[], depth = 0) {
    return nodes.map((node) => {
      if (node.type === "folder") {
        return (
          <div key={node.path}>
            <button
              className={
                selectedFolder === node.path || dropFolder === node.path
                  ? "treeItem selectedFolder"
                  : "treeItem"
              }
              style={{ paddingLeft: `${12 + depth * 16}px` }}
              onClick={() => setSelectedFolder(node.path)}
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
              <span className="folderIcon">▸</span>
              <span className="folderEmoji">📁</span>
              <span>{node.name}</span>
            </button>

            {renderTree(node.children, depth + 1)}
          </div>
        );
      }

      if (node.name === ".keep") return null;

      return (
        <button
          key={node.path}
          draggable
          className={activePath === node.path ? "treeItem activeFile" : "treeItem"}
          style={{ paddingLeft: `${12 + depth * 16}px` }}
          onClick={() => setActivePath(node.path)}
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
          <span>{node.name}</span>
          <span
            className="deleteIcon"
            onClick={(e) => {
              e.stopPropagation();
              deleteFile(node.path);
            }}
          >
            ×
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
          <p>Import files, edit code, ask questions, and let AI create or update files.</p>

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
      className={draggingExternal ? "appShell dragging" : "appShell"}
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
          <div>Drop files or folders to import</div>
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
          <button onClick={() => fileInputRef.current?.click()}>Import</button>
          <button onClick={exportProject}>Export ZIP</button>
        </div>

        <input
          ref={fileInputRef}
          className="hiddenInput"
          type="file"
          multiple
          onChange={(e) => importFilesFromInput(e.target.files)}
        />

        <div className="selectedFolderBox">
          <span>Current folder</span>
          <strong>{selectedFolder || "/"}</strong>
        </div>

        <div className="newItemBox">
          <input
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            placeholder="main.py or src"
          />

          <div className="newButtons">
            <button onClick={addFile}>＋ File</button>
            <button onClick={addFolder}>＋ Folder</button>
          </div>
        </div>

        <div className="treeRoot">
          <button
            className={
              selectedFolder === "" || dropFolder === "__root__"
                ? "treeItem selectedFolder"
                : "treeItem"
            }
            onClick={() => setSelectedFolder("")}
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
            <span className="folderEmoji">📁</span>
            <span>/</span>
          </button>

          {renderTree(tree)}
        </div>
      </aside>

      <section className="editor">
        {activeFile ? (
          <>
            <div className="editorHeader">
              <span className="fileIcon large">{getFileIcon(activeFile.path)}</span>
              <span>{activeFile.path}</span>
            </div>

            <div className="monacoWrap">
              <MonacoEditor
                height="100%"
                theme="vs-dark"
                language={getLanguage(activeFile.path)}
                value={activeFile.content}
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
            </div>
          </>
        ) : (
          <div className="emptyEditor">
            <div>
              <h2>No file selected</h2>
              <p>Choose a file, create one, or drag files into the app.</p>
            </div>
          </div>
        )}
      </section>

      <aside className="chatPanel">
        <div className="chatHeader">
          <h2>AI Editor</h2>
          <span>{files.filter((file) => !file.path.endsWith("/.keep")).length} files</span>
        </div>

        <input
          className="passwordInput"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="App password"
          type="password"
        />

        <div className="chatBox">
          {chat.map((item, index) => (
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
              {item.text}
            </div>
          ))}
        </div>

        {pendingChanges.length > 0 && (
          <div className="changesBox">
            <strong>Pending changes</strong>

            {pendingChanges.map((change, index) => (
              <div key={index} className="changeItem">
                <span>{change.action}</span>
                <code>{change.path}</code>
              </div>
            ))}

            <button onClick={applyChanges}>Apply Changes</button>
          </div>
        )}

        <textarea
          className="messageBox"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Ask AI to explain, refactor, fix bugs, or create files..."
        />

        <button className="sendButton" onClick={askAi} disabled={loading}>
          {loading ? "Thinking..." : "Send"}
        </button>
      </aside>
    </main>
  );
}
