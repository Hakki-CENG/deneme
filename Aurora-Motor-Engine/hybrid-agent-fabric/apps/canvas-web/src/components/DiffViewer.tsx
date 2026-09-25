/**
 * Diff Viewer Component
 * Unified diff view with syntax highlighting, stage/unstage support.
 */

import { useState } from "react";

interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
  oldLine?: number;
  newLine?: number;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  oldPath?: string;
  hunks: DiffHunk[];
  staged: boolean;
}

interface DiffViewerProps {
  files: DiffFile[];
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
  onCommit: (message: string) => void;
}

// ─── Parse Unified Diff ───

function parseDiff(rawDiff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of rawDiff.split("\n")) {
    if (line.startsWith("@@")) {
      if (currentHunk) hunks.push(currentHunk);
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (match) {
        oldLine = parseInt(match[1]);
        newLine = parseInt(match[2]);
        currentHunk = { header: match[3]?.trim() || "", lines: [] };
      }
    } else if (currentHunk) {
      if (line.startsWith("+")) {
        currentHunk.lines.push({ type: "add", content: line.slice(1), newLine: newLine++ });
      } else if (line.startsWith("-")) {
        currentHunk.lines.push({ type: "remove", content: line.slice(1), oldLine: oldLine++ });
      } else if (line.startsWith(" ")) {
        currentHunk.lines.push({ type: "context", content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file"
        currentHunk.lines.push({ type: "context", content: line });
      }
    }
  }

  if (currentHunk) hunks.push(currentHunk);
  return hunks;
}

// ─── Diff Line Component ───

function DiffLineComponent({ line }: { line: DiffLine }) {
  const lineClass = `diff-line diff-${line.type}`;
  const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";

  return (
    <div className={lineClass}>
      <span className="diff-line-numbers">
        <span className="diff-old-num">{line.oldLine ?? ""}</span>
        <span className="diff-new-num">{line.newLine ?? ""}</span>
      </span>
      <span className="diff-prefix">{prefix}</span>
      <span className="diff-content">{line.content}</span>
    </div>
  );
}

// ─── File Diff Component ───

function FileDiff({
  file,
  onStage,
  onUnstage,
  onDiscard,
}: {
  file: DiffFile;
  onStage: (path: string) => void;
  onUnstage: (path: string) => void;
  onDiscard: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);

  const statusIcon = {
    added: "🟢",
    modified: "🟡",
    deleted: "🔴",
    renamed: "🔵",
  }[file.status];

  const statusLabel = {
    added: "Eklendi",
    modified: "Değiştirildi",
    deleted: "Silindi",
    renamed: "Yeniden adlandırıldı",
  }[file.status];

  const totalAdded = file.hunks.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.type === "add").length,
    0
  );
  const totalRemoved = file.hunks.reduce(
    (sum, h) => sum + h.lines.filter((l) => l.type === "remove").length,
    0
  );

  return (
    <div className={`diff-file ${file.staged ? "staged" : ""}`}>
      <div className="diff-file-header" onClick={() => setExpanded(!expanded)}>
        <span className="diff-expand">{expanded ? "▼" : "▶"}</span>
        <span className="diff-status-icon">{statusIcon}</span>
        <span className="diff-file-path">{file.path}</span>
        {file.oldPath && file.oldPath !== file.path && (
          <span className="diff-old-path">← {file.oldPath}</span>
        )}
        <span className="diff-stats">
          <span className="diff-added">+{totalAdded}</span>
          <span className="diff-removed">-{totalRemoved}</span>
        </span>
        <div className="diff-file-actions">
          {file.staged ? (
            <button
              className="diff-action-btn unstage"
              onClick={(e) => {
                e.stopPropagation();
                onUnstage(file.path);
              }}
            >
              Geri Al
            </button>
          ) : (
            <>
              <button
                className="diff-action-btn stage"
                onClick={(e) => {
                  e.stopPropagation();
                  onStage(file.path);
                }}
              >
                Ekle
              </button>
              <button
                className="diff-action-btn discard"
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm("Değişiklikler silinecek. Emin misiniz?")) {
                    onDiscard(file.path);
                  }
                }}
              >
                At
              </button>
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className="diff-hunks">
          {file.hunks.map((hunk, i) => (
            <div key={i} className="diff-hunk">
              {hunk.header && <div className="diff-hunk-header">{hunk.header}</div>}
              {hunk.lines.map((line, j) => (
                <DiffLineComponent key={j} line={line} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Diff Viewer ───

export function DiffViewer({ files, onStage, onUnstage, onDiscard, onCommit }: DiffViewerProps) {
  const [commitMessage, setCommitMessage] = useState("");
  const [filter, setFilter] = useState<"all" | "staged" | "unstaged">("all");

  const filteredFiles = files.filter((f) => {
    if (filter === "staged") return f.staged;
    if (filter === "unstaged") return !f.staged;
    return true;
  });

  const stagedCount = files.filter((f) => f.staged).length;
  const unstagedCount = files.filter((f) => !f.staged).length;

  return (
    <div className="diff-viewer">
      <div className="diff-header">
        <span className="diff-title">🔀 Değişiklikler</span>
        <div className="diff-filters">
          <button
            className={`filter-btn ${filter === "all" ? "active" : ""}`}
            onClick={() => setFilter("all")}
          >
            Tümü ({files.length})
          </button>
          <button
            className={`filter-btn ${filter === "staged" ? "active" : ""}`}
            onClick={() => setFilter("staged")}
          >
            Hazır ({stagedCount})
          </button>
          <button
            className={`filter-btn ${filter === "unstaged" ? "active" : ""}`}
            onClick={() => setFilter("unstaged")}
          >
            Bekleyen ({unstagedCount})
          </button>
        </div>
      </div>

      <div className="diff-files">
        {filteredFiles.length === 0 ? (
          <div className="diff-empty">
            <div className="empty-icon">✅</div>
            <div className="empty-title">Değişiklik yok</div>
            <div className="empty-desc">Tüm dosyalar güncel</div>
          </div>
        ) : (
          filteredFiles.map((file) => (
            <FileDiff
              key={file.path}
              file={file}
              onStage={onStage}
              onUnstage={onUnstage}
              onDiscard={onDiscard}
            />
          ))
        )}
      </div>

      {stagedCount > 0 && (
        <div className="commit-form">
          <textarea
            className="commit-message"
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit mesajı yazın..."
            rows={3}
          />
          <button
            className="commit-btn"
            onClick={() => {
              if (commitMessage.trim()) {
                onCommit(commitMessage.trim());
                setCommitMessage("");
              }
            }}
            disabled={!commitMessage.trim()}
          >
            📝 Commit Yap
          </button>
        </div>
      )}
    </div>
  );
}
