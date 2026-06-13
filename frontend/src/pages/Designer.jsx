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

// Mensagem do assistente que é design vira placeholder; plano/markdown vira render legível.
function isPlanLike(content) {
  if (!content) return false;
  if (content === "\u2713 Design updated") return false;
  return true;
}

// Markdown minimalista (headings, bold, listas, code inline) seguro: escapa HTML antes.
function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let html = esc(src || "");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const lines = html.split("\n");
  let out = "";
  let inList = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    const oli = line.match(/^\s*\d+\.\s+(.*)$/);
    if (h) {
      if (inList) { out += "</ul>"; inList = false; }
      const lvl = h[1].length;
      out += `<h${lvl}>${h[2]}</h${lvl}>`;
    } else if (li || oli) {
      if (!inList) { out += "<ul>"; inList = true; }
      out += `<li>${(li || oli)[1]}</li>`;
    } else if (line.trim() === "") {
      if (inList) { out += "</ul>"; inList = false; }
    } else {
      if (inList) { out += "</ul>"; inList = false; }
      out += `<p>${line}</p>`;
    }
  }
  if (inList) out += "</ul>";
  return out;
}

// Extrai bloco ```questions {json} de uma resposta de plano. Retorna {intro, questions[]} ou null.
function parseQuestions(text) {
  if (!text) return null;
  const m = text.match(/```questions\s*([\s\S]*?)```/);
  let raw = m ? m[1] : null;
  // fallback: resposta pode vir como JSON puro
  if (!raw) {
    const t = text.trim();
    if (t.startsWith("{") && t.includes("\"questions\"")) raw = t;
  }
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw.trim());
    if (Array.isArray(obj.questions) && obj.questions.length) return obj;
  } catch {}
  return null;
}

const PLAN_FINAL_SUGGESTIONS = [
  { label: "Implementar agora", mode: "exec", tone: "primary", prompt: "Implemente o plano acima como um HTML completo, polido, responsivo e navegável." },
  { label: "Refinar direção visual", mode: "plan", prompt: "Refine o plano acima com uma direção visual mais forte: paleta, tipografia, ritmo, componentes e microinterações." },
  { label: "Adicionar estados importantes", mode: "plan", prompt: "Complete o plano com estados vazios, loading, erro, mobile e acessibilidade antes de implementar." },
];

const DESIGN_FINAL_SUGGESTIONS = [
  { label: "Melhorar mobile", mode: "exec", prompt: "Melhore a experiência mobile do design atual, mantendo a identidade visual e todos os fluxos funcionando." },
  { label: "Criar variação visual", mode: "exec", prompt: "Crie uma variação visual mais ousada do design atual, preservando conteúdo, navegação e funcionalidades." },
  { label: "Refinar copy", mode: "exec", prompt: "Refine a copy do design atual com textos mais claros, reais e persuasivos, mantendo o layout consistente." },
  { label: "Adicionar estado vazio", mode: "exec", prompt: "Adicione estados vazios, loading e erro bem desenhados onde fizer sentido no design atual." },
  { label: "Versão mais premium", mode: "exec", prompt: "Eleve o design atual para uma versão mais premium, com hierarquia, espaçamento, sombras e microinterações mais refinadas." },
];

function finalSuggestionsFor(message) {
  if (!message) return [];
  if (message.role === "assistant" && message.content === "\u2713 Design updated") return DESIGN_FINAL_SUGGESTIONS;
  if (message.role === "plan") return PLAN_FINAL_SUGGESTIONS;
  if (message.role === "assistant" && isPlanLike(message.content)) return PLAN_FINAL_SUGGESTIONS;
  return [];
}

function FinalSuggestions({ suggestions, disabled, onPick }) {
  if (!suggestions.length) return null;
  return (
    <div className="final-suggestions" aria-label="Sugestões finais">
      <div className="final-suggestions-title">Sugestões finais</div>
      <div className="final-suggestions-list">
        {suggestions.map((s) => (
          <button
            key={s.label}
            type="button"
            className={`final-suggestion-chip ${s.tone === "primary" ? "primary" : ""}`}
            disabled={disabled}
            onClick={() => onPick(s)}
            title={s.prompt}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
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

const emptyDraft = { name: "", base_url: "", api_key: "", model: "claude-opus-4-7" };

function ProvidersModal({ onClose }) {
  const [providers, setProviders] = useState([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    const data = await api("/api/providers");
    setProviders(data.providers || []);
  }, []);

  useEffect(() => { load(); }, [load]);

  async function addProvider(e) {
    e?.preventDefault();
    if (!draft.base_url.trim() || !draft.api_key.trim()) { setNote("Base URL e API key são obrigatórias."); return; }
    setBusy(true); setNote("");
    try {
      await api("/api/providers", { method: "POST", body: JSON.stringify(draft) });
      setDraft(emptyDraft);
      await load();
    } catch (err) { setNote(err.message); }
    finally { setBusy(false); }
  }

  async function toggleProvider(p) {
    await api(`/api/providers/${p.id}`, { method: "PUT", body: JSON.stringify({ enabled: !p.enabled }) });
    await load();
  }

  async function removeProvider(id) {
    await api(`/api/providers/${id}`, { method: "DELETE" });
    await load();
  }

  async function move(p, dir) {
    const idx = providers.findIndex(x => x.id === p.id);
    const swapWith = providers[idx + dir];
    if (!swapWith) return;
    await api(`/api/providers/${p.id}`, { method: "PUT", body: JSON.stringify({ sort_order: swapWith.sort_order }) });
    await api(`/api/providers/${swapWith.id}`, { method: "PUT", body: JSON.stringify({ sort_order: p.sort_order }) });
    await load();
  }

  async function testProvider(p) {
    setNote(`Testando "${p.name}"...`);
    const r = await api("/api/providers/test", { method: "POST", body: JSON.stringify({ id: p.id }) });
    setNote(`"${p.name}": ${r.ok ? "OK ✓" : `falhou (${r.status})`} ${r.ok ? "" : r.body}`);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Provedores</h2>
            <p className="modal-sub">Várias base URLs + API keys. O app tenta na ordem até uma responder (failover).</p>
          </div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="provider-list">
          {providers.map((p, i) => (
            <div key={p.id} className={`provider-item ${p.enabled ? "" : "disabled"}`}>
              <div className="provider-order">
                <button onClick={() => move(p, -1)} disabled={i === 0}>↑</button>
                <button onClick={() => move(p, 1)} disabled={i === providers.length - 1}>↓</button>
              </div>
              <div className="provider-info">
                <div className="provider-name">{p.name} <span className="provider-model">{p.model}</span></div>
                <div className="provider-url">{p.base_url}</div>
                <div className="provider-key">{p.api_key_masked}</div>
              </div>
              <div className="provider-actions">
                <button onClick={() => testProvider(p)}>Testar</button>
                <button onClick={() => toggleProvider(p)}>{p.enabled ? "On" : "Off"}</button>
                <button className="danger" onClick={() => removeProvider(p.id)}>×</button>
              </div>
            </div>
          ))}
          {providers.length === 0 && <div className="provider-empty">Nenhum provedor ainda. Adicione abaixo.</div>}
        </div>

        <form className="provider-form" onSubmit={addProvider}>
          <input placeholder="Nome (ex: right.codes)" value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })} />
          <input placeholder="Base URL (ex: https://right.codes/claude)" value={draft.base_url}
            onChange={e => setDraft({ ...draft, base_url: e.target.value })} />
          <input placeholder="API key" type="password" value={draft.api_key}
            onChange={e => setDraft({ ...draft, api_key: e.target.value })} />
          <input placeholder="Modelo (ex: claude-opus-4-7)" value={draft.model}
            onChange={e => setDraft({ ...draft, model: e.target.value })} />
          <button type="submit" disabled={busy}>{busy ? "Adicionando..." : "Adicionar provedor"}</button>
        </form>
        {note && <div className="provider-note">{note}</div>}
      </div>
    </div>
  );
}

// Wizard de perguntas guiadas: uma pergunta por vez, com progresso e opção "outro".
function Wizard({ data, onComplete, disabled }) {
  const questions = data.questions || [];
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [otherText, setOtherText] = useState("");
  const [done, setDone] = useState(false);

  const q = questions[step];
  const total = questions.length;
  const progress = Math.round(((done ? total : step) / total) * 100);

  function choose(value) {
    const next = { ...answers, [q.id || step]: { label: q.label, value } };
    setAnswers(next);
    setOtherText("");
    if (step + 1 < total) {
      setStep(step + 1);
    } else {
      setDone(true);
      onComplete(next);
    }
  }

  if (done) {
    return (
      <div className="wizard wizard-done">
        <div className="wizard-progress"><div className="wizard-bar" style={{ width: "100%" }} /></div>
        <div className="wizard-summary">
          {Object.values(answers).map((a, i) => (
            <div key={i} className="wizard-ans"><span>{a.label}</span><strong>{a.value}</strong></div>
          ))}
        </div>
        <div className="wizard-foot">Montando o plano com base nas suas respostas...</div>
      </div>
    );
  }

  if (!q) return null;

  return (
    <div className="wizard">
      {data.intro && step === 0 && <div className="wizard-intro">{data.intro}</div>}
      <div className="wizard-progress"><div className="wizard-bar" style={{ width: `${progress}%` }} /></div>
      <div className="wizard-step-label">Pergunta {step + 1} de {total}</div>
      <div className="wizard-q">{q.label}</div>
      <div className="wizard-options">
        {(q.options || []).map((opt, i) => (
          <button key={i} type="button" disabled={disabled}
            className={`wizard-opt ${opt === q.suggestion ? "suggested" : ""}`}
            onClick={() => choose(opt)}>
            {opt}{opt === q.suggestion && <span className="wizard-sug-tag">sugerido</span>}
          </button>
        ))}
      </div>
      {q.allowOther && (
        <form className="wizard-other" onSubmit={(e) => { e.preventDefault(); if (otherText.trim()) choose(otherText.trim()); }}>
          <input placeholder="Outro: digite sua resposta..." value={otherText}
            onChange={(e) => setOtherText(e.target.value)} disabled={disabled} />
          <button type="submit" disabled={disabled || !otherText.trim()}>OK</button>
        </form>
      )}
      {q.suggestion && (
        <button type="button" className="wizard-skip" disabled={disabled} onClick={() => choose(q.suggestion)}>
          Usar sugestão: {q.suggestion}
        </button>
      )}
    </div>
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
  const [showProviders, setShowProviders] = useState(false);
  const [mode, setMode] = useState("exec"); // "plan" | "exec"
  const [mobilePane, setMobilePane] = useState("chat"); // "chat" | "canvas" (mobile)
  const [showSidebar, setShowSidebar] = useState(false); // overlay sidebar (mobile)
  const [lastCost, setLastCost] = useState(null); // custo da ultima mensagem
  const [totalBrl, setTotalBrl] = useState(0); // custo acumulado na sessao
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
    let raw = input.trim();
    if (!raw || generating) return;

    // Comandos /plan e /exec sobrescrevem o modo para esta mensagem.
    let sendMode = mode;
    if (/^\/plan\b/i.test(raw)) { sendMode = "plan"; raw = raw.replace(/^\/plan\b\s*/i, ""); }
    else if (/^\/exec\b/i.test(raw)) { sendMode = "exec"; raw = raw.replace(/^\/exec\b\s*/i, ""); }
    const prompt = raw.trim();
    if (!prompt) return;
    setInput("");
    await runGenerate(prompt, sendMode, { userBubble: prompt });
  }

  // Consolida respostas do wizard e pede o plano completo.
  async function submitWizard(answers) {
    const lines = Object.values(answers).map(a => `- ${a.label} ${a.value}`).join("\n");
    const consolidated = `Minhas respostas:\n${lines}\n\nCom base nisso, monte o plano completo.`;
    await runGenerate(consolidated, "plan", { userBubble: "✓ Respostas enviadas" });
  }

  async function handleFinalSuggestion(suggestion) {
    if (generating || !suggestion) return;
    setMode(suggestion.mode);
    await runGenerate(suggestion.prompt, suggestion.mode, { userBubble: suggestion.label });
  }

  async function runGenerate(prompt, sendMode, opts = {}) {
    if (generating) return;
    let chatId = currentChatId;
    if (!chatId) chatId = await createChat(prompt.slice(0, 48));

    setStatus("generating");
    if (opts.userBubble) {
      setMessages(m => [...m, { role: "user", content: opts.userBubble, created_at: new Date().toISOString() }]);
    }

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
          mode: sendMode,
          currentHtml: currentHtml || null,
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
      let planText = "";
      let lastCost = null;
      let respMode = sendMode;
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
            if (parsed.info) {
              setMessages(m => [...m, { role: "info", content: parsed.info }]);
              continue;
            }
            if (parsed.mode) respMode = parsed.mode;
            if (parsed.done) {
              sawDone = true;
              if (parsed.html) finalHtml = parsed.html;
              if (parsed.text) planText = parsed.text;
              if (parsed.cost) lastCost = parsed.cost;
            } else if (parsed.delta) {
              // Acumula o delta incremental (backend envia só o trecho novo).
              if (respMode === "plan") { planText += parsed.delta; }
              else { finalHtml += parsed.delta; }
            } else if (parsed.partial) {
              // Compat: caso o backend ainda mande partial completo.
              if (respMode === "plan") planText = parsed.partial;
              else finalHtml = parsed.partial;
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
        setMessages(m => [...m, { role: "error", content: "Gera\u00e7\u00e3o interrompida" }]);
        setStatus("error");
        await Promise.all([loadChats(), loadChatState(chatId)]);
        return;
      }

      if (respMode === "plan") {
        // Detecta bloco de perguntas guiadas (wizard) vs plano em markdown.
        const q = parseQuestions(planText);
        if (q) {
          setMessages(m => [...m, { role: "wizard", questions: q, created_at: new Date().toISOString() }]);
        } else {
          setMessages(m => [...m, { role: "plan", content: planText, created_at: new Date().toISOString() }]);
        }
        if (lastCost) setCostFor(chatId, lastCost);
        setStatus("idle");
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
        if (lastCost) setCostFor(chatId, lastCost);
        setStatus("idle");
        if (window.innerWidth <= 860) setMobilePane("canvas");
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

  function setCostFor(chatId, cost) {
    setLastCost(cost);
    setTotalBrl(t => +(t + (cost?.brl || 0)).toFixed(4));
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
    <div className={`app pane-${mobilePane} ${showSidebar ? "show-sidebar" : ""}`}>
      {showSidebar && <div className="sidebar-backdrop" onClick={() => setShowSidebar(false)} />}
      <Sidebar
        chats={chatList}
        currentChatId={currentChatId}
        onNewChat={() => { createChat(); setShowSidebar(false); }}
        onSelectChat={(id) => { selectChat(id); setShowSidebar(false); }}
        onRenameChat={renameChat}
        onDeleteChat={deleteChat}
      />

      <div className="chat-panel">
        <div className="chat-header">
          <div className="chat-header-left">
            <button className="menu-btn" onClick={() => setShowSidebar(true)} title="Chats" aria-label="Abrir chats">☰</button>
            <h1>Claude Design</h1>
          </div>
          <div className="chat-header-right">
            {lastCost && (
              <div className="cost-pill" title={`Entrada ${lastCost.inputTokens} tok · Saída ${lastCost.outputTokens} tok\n¥${lastCost.cny} × ${lastCost.cnyToBrl} (CNY→BRL) + IOF ${lastCost.iofPct}%\nSessão: R$ ${totalBrl.toFixed(4)}`}>
                R$ {lastCost.brl.toFixed(4)}
                <span className="cost-sub">~{lastCost.inputTokens + lastCost.outputTokens} tok</span>
              </div>
            )}
            <button className="providers-btn" onClick={() => setShowProviders(true)} title="Provedores (base URLs + API keys)">Provedores</button>
            <div className={`status-pill status-${status}`}>
              <span className="status-dot" /> {status}
            </div>
          </div>
        </div>
        <div className="chat-messages">
          {messages.map((m, i) => {
            const isLast = i === messages.length - 1;
            // Mensagem wizard ao vivo (gerada nesta sessão)
            if (m.role === "wizard") {
              return (
                <div key={m.id || i} className="msg msg-plan msg-wizard">
                  <div className="msg-plan-tag">Perguntas</div>
                  <Wizard data={m.questions} disabled={generating || !isLast}
                    onComplete={(ans) => submitWizard(ans)} />
                </div>
              );
            }
            // Plano/assistente vindo do DB: pode conter bloco de perguntas
            if (m.role === "plan" || (m.role === "assistant" && isPlanLike(m.content))) {
              const q = parseQuestions(m.content);
              if (q) {
                return (
                  <div key={m.id || i} className="msg msg-plan msg-wizard">
                    <div className="msg-plan-tag">Perguntas</div>
                    <Wizard data={q} disabled={generating || !isLast}
                      onComplete={(ans) => submitWizard(ans)} />
                  </div>
                );
              }
              return (
                <div key={m.id || i} className="msg-stack">
                  <div className="msg msg-plan">
                    <div className="msg-plan-tag">Plano</div>
                    <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
                  </div>
                  <FinalSuggestions
                    suggestions={finalSuggestionsFor(m)}
                    disabled={generating}
                    onPick={handleFinalSuggestion}
                  />
                </div>
              );
            }
            const suggestions = finalSuggestionsFor(m);
            if (suggestions.length) {
              return (
                <div key={m.id || i} className="msg-stack">
                  <div className={`msg msg-${m.role}`}>{m.content}</div>
                  <FinalSuggestions
                    suggestions={suggestions}
                    disabled={generating}
                    onPick={handleFinalSuggestion}
                  />
                </div>
              );
            }
            return <div key={m.id || i} className={`msg msg-${m.role}`}>{m.content}</div>;
          })}
          {generating && (
            <div className="generating"><span className="dot" /> {mode === "plan" ? "Planejando..." : "Gerando..."}</div>
          )}
          {!currentChatId && messages.length === 0 && (
            <div className="chat-empty-note">Descreva um design para começar. Use o modo Planejar para refinar a ideia antes de construir.</div>
          )}
          <div ref={messagesEnd} />
        </div>
        <div className="chat-input-area">
          <div className="mode-toggle">
            <button className={`mode-opt ${mode === "plan" ? "active" : ""}`} onClick={() => setMode("plan")} type="button">Planejar</button>
            <button className={`mode-opt ${mode === "exec" ? "active" : ""}`} onClick={() => setMode("exec")} type="button">Executar</button>
            <span className="mode-hint">{mode === "plan" ? "A IA pergunta e planeja antes de construir" : "Gera o design direto do seu pedido"}</span>
          </div>
          <form className="chat-input-wrap" onSubmit={handleSend}>
            <textarea className="chat-input" placeholder={mode === "plan" ? "Descreva a ideia para planejar... (ou /exec para gerar direto)" : "Descreva seu design... (ou /plan para planejar)"}
              value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown} rows={1} disabled={generating} />
            <button className="send-btn" type="submit" disabled={generating || !input.trim()}>
              {mode === "plan" ? "Planejar" : "Enviar"}
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
      {showProviders && <ProvidersModal onClose={() => setShowProviders(false)} />}

      {/* Tab bar mobile: alterna chat / canvas */}
      <nav className="mobile-tabs">
        <button className={mobilePane === "chat" ? "active" : ""} onClick={() => setMobilePane("chat")}>Chat</button>
        <button className={mobilePane === "canvas" ? "active" : ""} onClick={() => setMobilePane("canvas")}>
          Canvas{versions.length > 0 ? ` · v${currentIdx + 1}` : ""}
        </button>
      </nav>
    </div>
  );
}
