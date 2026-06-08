import { useState, useRef, useEffect } from "react";

export default function Designer() {
  const [versions, setVersions] = useState([]);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [messages, setMessages] = useState([]);
  const [showVersions, setShowVersions] = useState(true);
  const messagesEnd = useRef(null);

  const currentHtml = currentIdx >= 0 ? versions[currentIdx]?.html : "";

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function handleSend(e) {
    e?.preventDefault();
    const prompt = input.trim();
    if (!prompt || generating) return;
    setInput("");
    setGenerating(true);
    setMessages(m => [...m, { role: "user", content: prompt }]);

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          currentHtml: currentHtml || null,
          history: versions.slice(0, currentIdx + 1).map(v => ({ prompt: v.prompt, html: v.html })),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        setMessages(m => [...m, { role: "error", content: err.error || "Request failed" }]);
        setGenerating(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalHtml = "";

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
              setMessages(m => [...m, { role: "error", content: parsed.error }]);
              break;
            }
            if (parsed.done && parsed.html) { finalHtml = parsed.html; }
            else if (parsed.partial) { finalHtml = parsed.partial; }
          } catch {}
        }
      }

      // Extract just the HTML from possible markdown code blocks
      let html = finalHtml;
      const mdMatch = html.match(/```html\s*\n([\s\S]*?)\n```/);
      if (mdMatch) html = mdMatch[1];
      // Ensure it starts with DOCTYPE
      if (html && !html.trim().startsWith("<!DOCTYPE") && !html.trim().startsWith("<html")) {
        const docIdx = html.indexOf("<!DOCTYPE");
        if (docIdx > 0) html = html.slice(docIdx);
      }

      if (html && html.includes("<html")) {
        const newVersion = { prompt, html, createdAt: new Date().toISOString() };
        const newVersions = [...versions.slice(0, currentIdx + 1), newVersion];
        setVersions(newVersions);
        setCurrentIdx(newVersions.length - 1);
        setMessages(m => [...m, { role: "assistant", content: "✓ Design updated" }]);
      } else {
        setMessages(m => [...m, { role: "error", content: "Failed to generate valid HTML" }]);
      }
    } catch (err) {
      setMessages(m => [...m, { role: "error", content: err.message }]);
    }
    setGenerating(false);
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
      {/* Chat Panel */}
      <div className="chat-panel">
        <div className="chat-header">
          <h1>Claude Design</h1>
          <button className="toolbar-btn" onClick={() => { setVersions([]); setCurrentIdx(-1); setMessages([]); }}>New</button>
        </div>
        <div className="chat-messages">
          {messages.map((m, i) => (
            <div key={i} className={`msg msg-${m.role}`}>{m.content}</div>
          ))}
          {generating && (
            <div className="generating"><span className="dot" /> Generating...</div>
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

      {/* Canvas Panel */}
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

      {/* Version History Panel */}
      {showVersions && versions.length > 0 && (
        <div className="version-panel">
          <div className="version-header">Versions</div>
          <div className="version-list">
            {versions.map((v, i) => (
              <div key={i} className={`version-item ${i === currentIdx ? "active" : ""}`}
                onClick={() => setCurrentIdx(i)}>
                <div className="v-idx">v{i + 1}</div>
                <div className="v-prompt">{v.prompt}</div>
                <div className="v-time">{new Date(v.createdAt).toLocaleTimeString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
