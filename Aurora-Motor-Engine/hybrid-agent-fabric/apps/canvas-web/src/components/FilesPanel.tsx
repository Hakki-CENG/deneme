/**
 * Files Panel Component
 * File tree with icons, code editor with line numbers, syntax highlighting hints.
 */

import { useCallback, useState } from "react";

interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
  modified?: string;
  children?: FileEntry[];
}

interface FilesPanelProps {
  sessionId: string;
  files: FileEntry[];
  activeFile: string | null;
  fileContent: string | null;
  onOpenFile: (path: string) => void;
  onSaveFile: (path: string, content: string) => void;
  onCreateFile: (path: string) => void;
  onDeleteFile: (path: string) => void;
  busy: boolean;
}

// File type icons
const FILE_ICONS: Record<string, string> = {
  ts: "📘", tsx: "📘", js: "📙", jsx: "📙",
  py: "🐍", rb: "💎", go: "🔷", rs: "🦀",
  html: "🌐", css: "🎨", scss: "🎨", less: "🎨",
  json: "📋", yaml: "📋", yml: "📋", toml: "📋",
  md: "📝", txt: "📄", log: "📄",
  jpg: "🖼", jpeg: "🖼", png: "🖼", gif: "🖼", svg: "🖼",
  pdf: "📕", doc: "📘", docx: "📘",
  zip: "📦", tar: "📦", gz: "📦",
  sh: "⚙️", bash: "⚙️", zsh: "⚙️",
  dockerfile: "🐳", docker: "🐳",
  sql: "🗃", db: "🗃",
  env: "🔒", lock: "🔒",
};

function getFileIcon(name: string, type: string): string {
  if (type === "directory") return "📁";
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return FILE_ICONS[ext] || "📄";
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── File Tree Item ───

function FileTreeItem({
  entry,
  depth,
  activeFile,
  onOpen,
  onDelete,
}: {
  entry: FileEntry;
  depth: number;
  activeFile: string | null;
  onOpen: (path: string) => void;
  onDelete: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const isActive = entry.path === activeFile;
  const isDir = entry.type === "directory";

  return (
    <div className="file-tree-item">
      <div
        className={`file-tree-row ${isActive ? "active" : ""}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => {
          if (isDir) {
            setExpanded(!expanded);
          } else {
            onOpen(entry.path);
          }
        }}
      >
        {isDir && (
          <span className={`tree-arrow ${expanded ? "expanded" : ""}`}>▶</span>
        )}
        <span className="file-icon">{getFileIcon(entry.name, entry.type)}</span>
        <span className="file-name">{entry.name}</span>
        {entry.size !== undefined && (
          <span className="file-size">{formatFileSize(entry.size)}</span>
        )}
        <button
          className="file-delete-btn"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`${entry.name} silinecek. Emin misiniz?`)) {
              onDelete(entry.path);
            }
          }}
          title="Sil"
        >
          🗑
        </button>
      </div>
      {isDir && expanded && entry.children && (
        <div className="file-tree-children">
          {entry.children
            .sort((a, b) => {
              if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
              return a.name.localeCompare(b.name);
            })
            .map((child) => (
              <FileTreeItem
                key={child.path}
                entry={child}
                depth={depth + 1}
                activeFile={activeFile}
                onOpen={onOpen}
                onDelete={onDelete}
              />
            ))}
        </div>
      )}
    </div>
  );
}

// ─── Code Editor ───

function CodeEditor({
  content,
  filePath,
  onSave,
}: {
  content: string;
  filePath: string;
  onSave: (content: string) => void;
}) {
  const [editContent, setEditContent] = useState(content);
  const [modified, setModified] = useState(false);

  const lines = editContent.split("\n");
  const lineCount = lines.length;

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setEditContent(e.target.value);
    setModified(e.target.value !== content);
  };

  const handleSave = () => {
    onSave(editContent);
    setModified(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.ctrlKey && e.key === "s") {
      e.preventDefault();
      handleSave();
    }
    // Tab indentation
    if (e.key === "Tab") {
      e.preventDefault();
      const target = e.target as HTMLTextAreaElement;
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const newValue = editContent.substring(0, start) + "  " + editContent.substring(end);
      setEditContent(newValue);
      setModified(true);
      // Restore cursor position
      setTimeout(() => {
        target.selectionStart = target.selectionEnd = start + 2;
      }, 0);
    }
  };

  return (
    <div className="code-editor">
      <div className="editor-header">
        <span className="editor-file-name">{filePath.split("/").pop()}</span>
        <span className="editor-file-path">{filePath}</span>
        {modified && <span className="editor-modified">● Değiştirildi</span>}
        <button
          className="editor-save-btn"
          onClick={handleSave}
          disabled={!modified}
          title="Kaydet (Ctrl+S)"
        >
          💾 Kaydet
        </button>
      </div>
      <div className="editor-body">
        <div className="line-numbers">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i} className="line-number">{i + 1}</div>
          ))}
        </div>
        <textarea
          className="editor-textarea"
          value={editContent}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
          wrap="off"
        />
      </div>
      <div className="editor-footer">
        <span>{lineCount} satır</span>
        <span>{editContent.length} karakter</span>
        <span>UTF-8</span>
      </div>
    </div>
  );
}

// ─── Main Files Panel ───

export function FilesPanel({
  sessionId,
  files,
  activeFile,
  fileContent,
  onOpenFile,
  onSaveFile,
  onCreateFile,
  onDeleteFile,
  busy,
}: FilesPanelProps) {
  const [newFileName, setNewFileName] = useState("");
  const [showNewFile, setShowNewFile] = useState(false);

  return (
    <div className="files-panel">
      <div className="files-sidebar">
        <div className="files-sidebar-header">
          <span>📂 Dosyalar</span>
          <button
            className="new-file-btn"
            onClick={() => setShowNewFile(!showNewFile)}
            title="Yeni dosya"
          >
            ➕
          </button>
        </div>

        {showNewFile && (
          <div className="new-file-form">
            <input
              type="text"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="dosya.adı"
              className="new-file-input"
            />
            <button
              onClick={() => {
                if (newFileName.trim()) {
                  onCreateFile(newFileName.trim());
                  setNewFileName("");
                  setShowNewFile(false);
                }
              }}
              disabled={!newFileName.trim()}
            >
              Oluştur
            </button>
          </div>
        )}

        <div className="file-tree">
          {files.length === 0 ? (
            <div className="files-empty">Dosya bulunamadı</div>
          ) : (
            files.map((entry) => (
              <FileTreeItem
                key={entry.path}
                entry={entry}
                depth={0}
                activeFile={activeFile}
                onOpen={onOpenFile}
                onDelete={onDeleteFile}
              />
            ))
          )}
        </div>
      </div>

      <div className="files-editor">
        {activeFile && fileContent !== null ? (
          <CodeEditor
            content={fileContent}
            filePath={activeFile}
            onSave={(content) => onSaveFile(activeFile, content)}
          />
        ) : (
          <div className="editor-empty">
            <div className="empty-icon">📝</div>
            <div className="empty-title">Dosya seçilmedi</div>
            <div className="empty-desc">Düzenlemek için sol panelden bir dosya seçin</div>
          </div>
        )}
      </div>
    </div>
  );
}
