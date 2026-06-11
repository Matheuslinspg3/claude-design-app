import { useState, useRef, useEffect, useCallback } from "react";

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    let message = "Request failed";
    try {
      const err = await res.json();
      message = err.error || message;
    } catch {}
    throw new Error(message);
  }
  return res.json();
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function extractHtml(raw) {
  let html = raw || "";
  const mdMatch = html.match(/```html\s*\n([\s\S]*?)\n```/);
  if (mdMatch) html = mdMatch[1];
  if (html && !html.trim().startsWith("<!DOCTYPE") && !html.trim().startsWith("<html")) {
    const docIdx = html.indexOf("<!DOCTYPE");
    if (docIdx > 0) html = html.slice(docIdx);
  }
  return html;
}

function Sidebar({ chats, currentChatId, onNewChat, onSelectChat, onRenameChat, onDeleteChat }) {
  const [editingId, setEditingId] = useState(null);
  const [draftTitle, setDraftTitle] = useState("");

  function startRename(chat) {
    setEditingId(chat.id);
    setDraftTitle(chat.title || "Untitled");
  }

  async function finishRename() {
    if (!editingId) return;
    const title = draftTitle.trim();
    const id = editingId;
    setEditingId(null);
    if (title) await onRenameChat(id, title);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div>
          <div className="sidebar-kicker">Workspace</div>
          <h2>Chats</h2>
        </div>
        <button className="new-chat-btn" onClick={onNewChat}>+</button>
      </div>
      <div className="chat-list">
        {chats.map(chat => (
          <div
            key={chat.id}
            className={`chat-list-item ${chat.id === currentChatId ? "active" : ""}`}
            onClick={() => editingId !== chat.id && onSelectChat(chat.id)}
            onDoubleClick={() => startRename(chat)}
            title="Double-click to rename"
          >
            {editingId === chat.id ? (
              <input
                className="chat-title-input"
                value={draftTitle}
                autoFocus
                onClick={e => e.stopPropagation()}
                onChange={e => setDraftTitle(e.target.value)}
                onBlur={finishRename}
                onKeyDown={e => {
                  if (e.key === "Enter") finishRename();
                  if (e.key === "Escape") setEditingId(null);
                }}
              />
            ) : (
              <>
                <div className="chat-list-title">{chat.title || "Untitled"}</div>
                <div className="chat-list-meta">{formatTime(chat.updated_at)}</div>
                <button
                  className="delete-chat-btn"
                  onClick={e => { e.stopPropagation(); onDeleteChat(chat.id); }}
                  aria-label="Delete chat"
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
        {chats.length === 0 && <div className="empty-chats">No chats yet</div>}
      </div>
    </aside>
  );
}

export default function Designer() {
  const [chatList, setChatList] = useState([]);
  const [currentChatId, setCurrentChatId] = useState(null);
  const [versions, setVersions] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState("idle");
  const [messages, setMessages] = useState([]);
  const [showVersions, setShowVersions] = useState(true);
  const messagesEnd = useRef(null);
  const abortRef = useRef(null);
  const currentChatRef = useRef(null);

  const generating = status === "generating";
  const currentHtml = currentIdx >= 0 ? versions[currentIdx]?.html : "";

  const loadChats = useCallback(async () => {
    const data = await api("/api/chats");
    setChatList(data.chats || []);
    return data.chats || [];
  }, []);

  const loadChatState = useCallback(async (chatId) => {
    if (!chatId) return;
    const [messageData, versionData] = await Promise.all([
      api(`/api/chats/${chatId}/messages`),
      api(`/api/chats/${chatId}/versions`),
    ]);
    if (currentChatRef.current !== chatId) return;
    const loadedVersions = (versionData.versions || []).map(v => ({
      ...v,
      html: extractHtml(v.html),
      createdAt: v.created_at,
    }));
    setMessages(messageData.messages || []);
    setVersions(loadedVersions);
    setCurrentIdx(loadedVersions.length - 1);
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      await api("/api/auth");
      const chats = await loadChats();
      if (chats.length > 0) {
        const nextId = currentChatRef.current || chats[0].id;
        currentChatRef.current = nextId;
        setCurrentChatId(nextId);
        await loadChatState(nextId);
      }
    } catch (err) {
      setStatus("error");
      setMessages(m => [...m, { role: "error", content: err.message }]);
    }
  }, [loadChats, loadChatState]);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "visible") bootstrap();
    }
    window.addEventListener("focus", bootstrap);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", bootstrap);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [bootstrap]);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    currentChatRef.current = currentChatId;
    return () => {
      abortRef.current?.abort();
    };
  }, [currentChatId]);

  async function createChat(title = "New Chat") {
    abortRef.current?.abort();
    const chat = await api("/api/chats", { method: "POST", body: JSON.stringify({ title }) });
    currentChatRef.current = chat.id;
    setCurrentChatId(chat.id);
    setMessages([]);
    setVersions([]);
    setCurrentIdx(-1);
    setStatus("idle");
    await loadChats();
    return chat.id;
  }

  async function selectChat(chatId) {
    if (chatId === currentChatId) return;
    abortRef.current?.abort();
    currentChatRef.current = chatId;
    setCurrentChatId(chatId);
    setMessages([]);
    setVersions([]);
    setCurrentIdx(-1);
    setStatus("idle");
    await loadChatState(chatId);
  }

  async function renameChat(id, title) {
    const updated = await api(`/api/chats/${id}`, { method: "PUT", body: JSON.stringify({ title }) });
    setChatList(chats => chats.map(c => c.id === id ? { ...c, ...updated } : c));
  }

  async function deleteChat(id) {
    abortRef.current?.abort();
    await api(`/api/chats/${id}`, { method: "DELETE" });
    const chats = await loadChats();
    if (id === currentChatId) {
      const next = chats[0]?.id || null;
      currentChatRef.current = next;
      setCurrentChatId(next);
      setMessages([]);
      setVersions([]);
      setCurrentIdx(-1);
      setStatus("idle");
      if (next) await loadChatState(next);
    }
  }

  async function handleSend(e) {
    e?.preventDefault();
    const prompt = input.trim();
    if (!prompt || generating) return;

    let chatId = currentChatId;
    if (!chatId) chatId = await createChat(prompt.slice(0, 48));

    setInput("");
    setStatus("generating");
    setMessages(m => [...m, { role: "user", content: prompt, created_at: new Date().toISOString() }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          chatId,
          prompt,
          currentHtml: currentHtml || null,
          history: versions.slice(0, currentIdx + 1).map(v => ({ prompt: v.prompt, html: v.html })),
        }),
      });

      if (!res.ok) {
        let message = "Request failed";
        try {
          const err = await res.json();
          message = err.error || message;
        } catch {}
        setMessages(m => [...m, { role: "error", content: message }]);
        setStatus("error");
        await Promise.all([loadChats(), loadChatState(chatId)]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalHtml = "";
      let sawDone = false;
      let streamError = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) {
              streamError = parsed.error;
              continue;
            }
            if (parsed.done) {
              sawDone = true;
              if (parsed.html) finalHtml = parsed.html;
            } else if (parsed.partial) {
              finalHtml = parsed.partial;
            }
          } catch {}
        }
      }

      if (streamError) {
        setMessages(m => [...m, { role: "error", content: streamError }]);
        setStatus("error");
        await Promise.all([loadChats(), loadChatState(chatId)]);
        return;
      }

      if (!sawDone) {
        setMessages(m => [...m, { role: "error", content: "Generation interrupted" }]);
        setStatus("error");
        await Promise.all([loadChats(), loadChatState(chatId)]);
        return;
      }

      const html = extractHtml(finalHtml);
      if (html && html.includes("<html")) {
        const newVersion = { prompt, html, created_at: new Date().toISOString(), createdAt: new Date().toISOString() };
        const newVersions = [...versions.slice(0, currentIdx + 1), newVersion];
        setVersions(newVersions);
        setCurrentIdx(newVersions.length - 1);
        setMessages(m => [...m, { role: "assistant", content: "✓ Design updated", created_at: new Date().toISOString() }]);
        setStatus("idle");
        await Promise.all([loadChats(), loadChatState(chatId)]);
      } else {
        setMessages(m => [...m, { role: "error", content: "Failed to generate valid HTML" }]);
        setStatus("error");
      }
    } catch (err) {
      if (err.name === "AbortError") {
        setMessages(m => [...m, { role: "error", content: "Generation interrupted" }]);
      } else {
        setMessages(m => [...m, { role: "error", content: err.message }]);
      }
      setStatus("error");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  function copyCode() {
    if (currentHtml) { navigator.clipboard.writeText(currentHtml); }
  }

  function downloadHtml() {
    if (!currentHtml) return;
    const blob = new Blob([currentHtml], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "design.html";
    a.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="app">
      <Sidebar
        chats={chatList}
        currentChatId={currentChatId}
        onNewChat={() => createChat()}
        onSelectChat={selectChat}
        onRenameChat={renameChat}
        onDeleteChat={deleteChat}
      />

      <div className="chat-panel">
        <div className="chat-header">
          <h1>Claude Design</h1>
          <div className={`status-pill status-${status}`}>
            <span className="status-dot" /> {status}
          </div>
        </div>
        <div className="chat-messages">
          {messages.map((m, i) => (
            <div key={m.id || i} className={`msg msg-${m.role}`}>{m.content}</div>
          ))}
          {generating && (
            <div className="generating"><span className="dot" /> Generating...</div>
          )}
          {!currentChatId && messages.length === 0 && (
            <div className="chat-empty-note">Create or send a prompt to start a persistent chat.</div>
          )}
          <div ref={messagesEnd} />
        </div>
        <div className="chat-input-area">
          <form className="chat-input-wrap" onSubmit={handleSend}>
            <textarea className="chat-input" placeholder="Describe your design..."
              value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown} rows={1} disabled={generating} />
            <button className="send-btn" type="submit" disabled={generating || !input.trim()}>
              Send
            </button>
          </form>
        </div>
      </div>

      <div className="canvas-panel">
        <div className="canvas-toolbar">
          <button className="toolbar-btn" onClick={copyCode} disabled={!currentHtml}>Copy code</button>
          <button className="toolbar-btn" onClick={downloadHtml} disabled={!currentHtml}>Download HTML</button>
          <span className="toolbar-spacer" />
          <span className="toolbar-version">
            {currentIdx >= 0 ? `v${currentIdx + 1} / ${versions.length}` : "No design yet"}
          </span>
          <button className={`toolbar-btn ${showVersions ? "active" : ""}`}
            onClick={() => setShowVersions(!showVersions)}>History</button>
        </div>
        <div className="canvas-frame">
          {currentHtml ? (
            <iframe sandbox="allow-scripts" srcDoc={currentHtml} title="Preview" />
          ) : (
            <div className="canvas-empty">
              <div className="icon">◇</div>
              <p>Describe a design to get started</p>
            </div>
          )}
        </div>
      </div>

      {showVersions && versions.length > 0 && (
        <div className="version-panel">
          <div className="version-header">Versions</div>
          <div className="version-list">
            {versions.map((v, i) => (
              <div key={v.id || i} className={`version-item ${i === currentIdx ? "active" : ""}`}
                onClick={() => setCurrentIdx(i)}>
                <div className="v-idx">v{i + 1}</div>
                <div className="v-prompt">{v.prompt}</div>
                <div className="v-time">{formatTime(v.created_at || v.createdAt)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
