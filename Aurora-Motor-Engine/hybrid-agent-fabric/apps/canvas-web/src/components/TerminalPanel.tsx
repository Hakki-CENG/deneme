/**
 * Terminal Panel Component
 * Supports ANSI colors, command history, auto-scroll lock.
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface TerminalLine {
  id: string;
  type: "command" | "output" | "error";
  text: string;
  timestamp: string;
}

interface TerminalPanelProps {
  sessionId: string;
  lines: TerminalLine[];
  onExecute: (command: string) => void;
  busy: boolean;
}

// ANSI color code mapping
const ANSI_COLORS: Record<string, string> = {
  "30": "#000", "31": "#e74c3c", "32": "#2ecc71", "33": "#f1c40f",
  "34": "#3498db", "35": "#9b59b6", "36": "#1abc9c", "37": "#ecf0f1",
  "90": "#7f8c8d", "91": "#ff6b6b", "92": "#51cf66", "93": "#ffd43b",
  "94": "#74c0fc", "95": "#da77f2", "96": "#63e6be", "97": "#f8f9fa",
};

const ANSI_BG: Record<string, string> = {
  "40": "#000", "41": "#c0392b", "42": "#27ae60", "43": "#f39c12",
  "44": "#2980b9", "45": "#8e44ad", "46": "#16a085", "47": "#bdc3c7",
};

function parseAnsiToHtml(text: string): string {
  let result = "";
  let currentStyle = "";

  // Process ANSI escape sequences
  const parts = text.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Text content
      if (currentStyle) {
        result += `<span style="${currentStyle}">${escapeHtml(parts[i])}</span>`;
      } else {
        result += escapeHtml(parts[i] || "");
      }
    } else {
      // ANSI code
      const codes = (parts[i] || "0").split(";");
      const styles: string[] = [];

      for (const code of codes) {
        if (code === "0" || code === "") {
          currentStyle = "";
          continue;
        }
        if (code === "1") styles.push("font-weight:bold");
        if (code === "2") styles.push("opacity:0.7");
        if (code === "3") styles.push("font-style:italic");
        if (code === "4") styles.push("text-decoration:underline");
        if (ANSI_COLORS[code]) styles.push(`color:${ANSI_COLORS[code]}`);
        if (ANSI_BG[code]) styles.push(`background-color:${ANSI_BG[code]}`);
      }

      if (styles.length > 0) {
        currentStyle = styles.join(";");
      }
    }
  }

  return result || escapeHtml(text);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function TerminalPanel({ sessionId, lines, onExecute, busy }: TerminalPanelProps) {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [scrollLock, setScrollLock] = useState(true);
  const outputRef = useRef<HTMLDivElement>(null);

  // Auto-scroll
  useEffect(() => {
    if (scrollLock && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [lines, scrollLock]);

  const handleSubmit = useCallback(() => {
    const trimmed = command.trim();
    if (!trimmed || busy) return;

    setHistory((prev) => [...prev, trimmed]);
    setHistoryIndex(-1);
    onExecute(trimmed);
    setCommand("");
  }, [command, busy, onExecute]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
      return;
    }

    // Command history
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (history.length > 0) {
        const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setCommand(history[newIndex] || "");
      }
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      const newIndex = historyIndex + 1;
      if (newIndex >= history.length) {
        setHistoryIndex(-1);
        setCommand("");
      } else {
        setHistoryIndex(newIndex);
        setCommand(history[newIndex] || "");
      }
    }

    // Tab completion placeholder
    if (e.key === "Tab") {
      e.preventDefault();
      // TODO: Implement tab completion
    }
  }, [command, busy, handleSubmit, history, historyIndex]);

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <span className="terminal-title">🖥️ Terminal</span>
        <div className="terminal-controls">
          <button
            className={`scroll-lock-btn ${scrollLock ? "active" : ""}`}
            onClick={() => setScrollLock(!scrollLock)}
            title={scrollLock ? "Kaydırmayı serbest bırak" : "Otomatik kaydırma"}
          >
            {scrollLock ? "🔒" : "🔓"}
          </button>
          <button
            className="clear-btn"
            onClick={() => {/* TODO: Clear terminal */}}
            title="Temizle"
          >
            🗑️
          </button>
        </div>
      </div>

      <div className="terminal-output" ref={outputRef}>
        {lines.length === 0 && (
          <div className="terminal-empty">
            <div>Terminal hazır. Komut yazın.</div>
          </div>
        )}
        {lines.map((line) => (
          <div key={line.id} className={`terminal-line terminal-${line.type}`}>
            {line.type === "command" && <span className="terminal-prompt">$ </span>}
            <span
              className="terminal-text"
              dangerouslySetInnerHTML={{ __html: parseAnsiToHtml(line.text) }}
            />
          </div>
        ))}
      </div>

      <div className="terminal-input-container">
        <span className="terminal-prompt-symbol">$</span>
        <input
          type="text"
          className="terminal-input"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Komut yazın... (↑↓ geçmiş)"
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
        />
        {busy && <span className="terminal-spinner">⏳</span>}
      </div>
    </div>
  );
}
