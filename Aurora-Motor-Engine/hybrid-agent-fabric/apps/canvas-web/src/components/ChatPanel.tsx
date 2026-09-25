/**
 * Chat Panel Component
 * Supports markdown rendering, code highlighting, copy buttons, streaming indicator.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Types ───

type Role = "system" | "user" | "assistant" | "tool";
type Message = {
  id: string;
  role: Role;
  timestamp: string;
  content: Array<{
    type: string;
    text?: string;
    alt?: string;
    path?: string;
    mimeType?: string;
    name?: string;
    arguments?: any;
    result?: any;
  }>;
};

interface ChatPanelProps {
  messages: Message[];
  busy: boolean;
  onSend: (message: string) => void;
  onStop?: () => void;
}

// ─── Simple Markdown Parser ───

function parseMarkdown(text: string): string {
  // First escape ALL HTML to prevent XSS
  let html = escapeHtml(text);

  // Code blocks with language
  html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
    const langLabel = lang ? `<span class="code-lang">${lang}</span>` : "";
    return `<div class="code-block"><div class="code-header">${langLabel}<button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-block').querySelector('code').textContent)">Kopyala</button></div><pre><code class="language-${lang || "text"}">${code}</code></pre></div>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Italic
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");

  // Strikethrough
  html = html.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // Headers
  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");

  // Unordered lists
  html = html.replace(/^[*-] (.+)$/gm, "<li>$1</li>");
  html = html.replace(/(<li>.*<\/li>\n?)+/g, "<ul>$&</ul>");

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Horizontal rule
  html = html.replace(/^---$/gm, "<hr>");

  // Line breaks
  html = html.replace(/\n/g, "<br>");

  return html;
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m] || m);
}

// ─── ANSI Color Support ───

function parseAnsi(text: string): string {
  const ansiColors: Record<string, string> = {
    "30": "#000", "31": "#e74c3c", "32": "#2ecc71", "33": "#f1c40f",
    "34": "#3498db", "35": "#9b59b6", "36": "#1abc9c", "37": "#ecf0f1",
    "90": "#7f8c8d", "91": "#e74c3c", "92": "#2ecc71", "93": "#f1c40f",
    "94": "#3498db", "95": "#9b59b6", "96": "#1abc9c", "97": "#ecf0f1",
  };

  return text.replace(/\x1b\[(\d+)m/g, (_, code) => {
    if (code === "0") return "</span>";
    const color = ansiColors[code];
    if (color) return `<span style="color:${color}">`;
    if (code === "1") return "<span style='font-weight:bold'>";
    return "";
  });
}

// ─── Copy Button Component ───

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [text]);

  return (
    <button className="copy-btn" onClick={handleCopy} title="Kopyala">
      {copied ? "✓ Kopyalandı" : "Kopyala"}
    </button>
  );
}

// ─── Message Component ───

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const isTool = message.role === "tool";

  const fullText = message.content
    .map((part) => {
      if (part.type === "text") return part.text || "";
      if (part.type === "tool_call") return `→ ${part.name}\n${JSON.stringify(part.arguments, null, 2)}`;
      if (part.type === "tool_result") return `← ${part.name}\n${JSON.stringify(part.result, null, 2)}`;
      return "";
    })
    .join("\n");

  return (
    <div className={`message message-${message.role}`}>
      <div className="message-header">
        <span className="message-role">
          {isUser ? "👤 Kullanıcı" : isAssistant ? "🤖 Asistan" : isTool ? "🔧 Araç" : "⚙️ Sistem"}
        </span>
        <span className="message-time">
          {new Date(message.timestamp).toLocaleTimeString("tr-TR")}
        </span>
        <CopyButton text={fullText} />
      </div>
      <div className="message-content">
        {message.content.map((part, i) => {
          if (part.type === "text") {
            const text = part.text || "";
            // Check if it contains ANSI codes
            if (text.includes("\x1b[")) {
              return (
                <div
                  key={i}
                  className="message-text ansi-content"
                  dangerouslySetInnerHTML={{ __html: parseAnsi(text) }}
                />
              );
            }
            // Check if it's markdown (has code blocks, headers, etc.)
            const isMarkdown = text.includes("```") || text.includes("## ") || text.includes("**") || text.includes("- ");
            if (isMarkdown && isAssistant) {
              return (
                <div
                  key={i}
                  className="message-text markdown-content"
                  dangerouslySetInnerHTML={{ __html: parseMarkdown(text) }}
                />
              );
            }
            return <div key={i} className="message-text">{text}</div>;
          }
          if (part.type === "image") {
            return (
              <div key={i} className="message-image">
                <div className="image-placeholder">🖼 {part.alt || part.path} ({part.mimeType})</div>
              </div>
            );
          }
          if (part.type === "tool_call") {
            return (
              <details key={i} className="tool-call">
                <summary>→ {part.name}</summary>
                <pre><code>{JSON.stringify(part.arguments, null, 2)}</code></pre>
              </details>
            );
          }
          if (part.type === "tool_result") {
            return (
              <details key={i} className="tool-result">
                <summary>← {part.name}</summary>
                <pre><code>{JSON.stringify(part.result, null, 2)}</code></pre>
              </details>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

// ─── Streaming Indicator ───

function StreamingIndicator() {
  return (
    <div className="streaming-indicator">
      <div className="typing-dots">
        <span></span>
        <span></span>
        <span></span>
      </div>
      <span>Yanıt yazılıyor...</span>
    </div>
  );
}

// ─── Main Chat Panel ───

export function ChatPanel({ messages, busy, onSend, onStop }: ChatPanelProps) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, autoScroll]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed || busy) return;

    setHistory((prev) => [...prev, trimmed]);
    setHistoryIndex(-1);
    onSend(trimmed);
    setInput("");
  }, [input, busy, onSend]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
      return;
    }

    // Prompt history navigation
    if (e.key === "ArrowUp" && !input) {
      e.preventDefault();
      if (history.length > 0) {
        const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(newIndex);
        setInput(history[newIndex] || "");
      }
      return;
    }

    if (e.key === "ArrowDown" && historyIndex >= 0) {
      e.preventDefault();
      const newIndex = historyIndex + 1;
      if (newIndex >= history.length) {
        setHistoryIndex(-1);
        setInput("");
      } else {
        setHistoryIndex(newIndex);
        setInput(history[newIndex] || "");
      }
    }
  }, [input, busy, handleSubmit, history, historyIndex]);

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">💬 Sohbet</span>
        <div className="chat-controls">
          <label className="auto-scroll-toggle">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            Otomatik kaydırma
          </label>
        </div>
      </div>

      <div className="messages-container">
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <div className="empty-title">Henüz mesaj yok</div>
            <div className="empty-desc">Bir mesaj yazarak sohbete başlayın</div>
          </div>
        )}
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {busy && <StreamingIndicator />}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-container">
        <textarea
          ref={inputRef}
          className="chat-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Mesajınızı yazın... (Enter ile gönder, Shift+Enter yeni satır)"
          rows={3}
          disabled={busy}
        />
        <div className="chat-actions">
          <span className="char-count">{input.length} karakter</span>
          {busy ? (
            <button className="stop-btn" onClick={onStop}>
              ■ Durdur
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={handleSubmit}
              disabled={!input.trim()}
            >
              Gönder ➤
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
