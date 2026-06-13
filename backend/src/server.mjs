import express from "express";
import cookieParser from "cookie-parser";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT || "80", 10);

const {
  APP_PASSWORD,
  BRIDGE_URL,
  BRIDGE_TOKEN,
  BRIDGE_MODEL = "claude-opus-4-7",
} = process.env;

const dataDir = existsSync("/data") ? "/data" : "/tmp";
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "claude-design.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, role TEXT, content TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, prompt TEXT, html TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, api_key TEXT, model TEXT, sort_order INTEGER, enabled INTEGER DEFAULT 1, created_at TEXT);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`);

// --- Pricing / custo por mensagem ---
// Preços em CNY (¥) por 1 milhão de tokens. Editáveis via /api/pricing.
const DEFAULT_PRICING = {
  iofPct: 3.5,            // IOF câmbio (%) sobre o valor convertido
  marginPct: 0,          // margem opcional (%) por cima
  cnyToBrl: 0.75,        // fallback; atualizado ao vivo com cache
  models: {
    // modelo: { in: ¥/Mtok entrada, out: ¥/Mtok saída }
    "claude-opus-4-8": { in: 9, out: 45 },
    "claude-opus-4-7": { in: 9, out: 45 },
    "claude-sonnet-4-6": { in: 3, out: 15 },
    "default": { in: 9, out: 45 },
  },
};

const getSetting = db.prepare("SELECT value FROM settings WHERE key = ?");
const putSetting = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

function loadPricing() {
  const row = getSetting.get("pricing");
  if (!row) return { ...DEFAULT_PRICING };
  try { return { ...DEFAULT_PRICING, ...JSON.parse(row.value) }; }
  catch { return { ...DEFAULT_PRICING }; }
}
function savePricing(p) { putSetting.run("pricing", JSON.stringify(p)); }

// Cotacao CNY->BRL com cache de 6h (busca ao vivo, fallback no valor salvo).
let fxCache = { rate: null, ts: 0 };
async function getCnyToBrl(pricing) {
  const sixH = 6 * 60 * 60 * 1000;
  if (fxCache.rate && Date.now() - fxCache.ts < sixH) return fxCache.rate;
  try {
    const r = await fetch("https://open.er-api.com/v6/latest/CNY", { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const rate = j?.rates?.BRL;
    if (rate && rate > 0) {
      fxCache = { rate, ts: Date.now() };
      const p = loadPricing(); p.cnyToBrl = rate; savePricing(p);
      return rate;
    }
  } catch {}
  return pricing.cnyToBrl || DEFAULT_PRICING.cnyToBrl;
}

// Calcula custo de uma resposta dado o usage e o modelo.
function computeCost(usage, model, pricing, cnyToBrl) {
  const inTok = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const outTok = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  const mp = pricing.models[model] || pricing.models.default || DEFAULT_PRICING.models.default;
  const cny = (inTok / 1e6) * mp.in + (outTok / 1e6) * mp.out;
  const brlBase = cny * cnyToBrl;
  const withIof = brlBase * (1 + (pricing.iofPct || 0) / 100);
  const withMargin = withIof * (1 + (pricing.marginPct || 0) / 100);
  return {
    inputTokens: inTok,
    outputTokens: outTok,
    cny: +cny.toFixed(5),
    brl: +withMargin.toFixed(4),
    cnyToBrl: +cnyToBrl.toFixed(4),
    iofPct: pricing.iofPct || 0,
    model,
  };
}

// Se o stream foi cortado pelo relay antes de fechar o documento, fecha as tags
// principais para o HTML renderizar no iframe em vez de quebrar.
function finalizeHtml(html) {
  if (!html || html.includes("</html>")) return html;
  let out = html;
  // fecha uma tag de abertura incompleta no final (ex: "<div clas")
  const lastLt = out.lastIndexOf("<");
  const lastGt = out.lastIndexOf(">");
  if (lastLt > lastGt) out = out.slice(0, lastLt);
  if (!/<\/body>/i.test(out)) out += "\n</body>";
  if (!/<\/html>/i.test(out)) out += "\n</html>";
  return out;
}

const chatExists = db.prepare("SELECT id FROM chats WHERE id = ?");
const touchChat = db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?");
const insertMessage = db.prepare("INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)");
const insertVersion = db.prepare("INSERT INTO versions (chat_id, prompt, html, created_at) VALUES (?, ?, ?, ?)");

function nowIso() {
  return new Date().toISOString();
}

// --- Provider helpers (multi base URL + key, com failover) ---
function maskKey(k) {
  if (!k) return "";
  if (k.length <= 8) return "\u2022\u2022\u2022\u2022";
  return k.slice(0, 4) + "\u2026" + k.slice(-4);
}

function listProvidersRaw() {
  return db.prepare("SELECT * FROM providers ORDER BY sort_order ASC, created_at ASC").all();
}

function listProvidersSafe() {
  return listProvidersRaw().map((p) => ({
    id: p.id,
    name: p.name,
    base_url: p.base_url,
    model: p.model,
    sort_order: p.sort_order,
    enabled: !!p.enabled,
    api_key_masked: maskKey(p.api_key),
  }));
}

// Provedores ativos na ordem de tentativa. Inclui o do env como fallback final.
function activeProviders() {
  const list = listProvidersRaw()
    .filter((p) => p.enabled)
    .map((p) => ({
      name: p.name || "provider",
      baseUrl: (p.base_url || "").replace(/\/+$/, ""),
      apiKey: p.api_key,
      model: p.model || BRIDGE_MODEL,
    }))
    .filter((p) => p.baseUrl && p.apiKey);
  if (BRIDGE_URL && BRIDGE_TOKEN) {
    list.push({
      name: "env",
      baseUrl: BRIDGE_URL.replace(/\/+$/, ""),
      apiKey: BRIDGE_TOKEN,
      model: BRIDGE_MODEL,
    });
  }
  return list;
}

function requireChat(req, res, next) {
  const { id } = req.params;
  if (!chatExists.get(id)) return res.status(404).json({ error: "Chat not found" });
  next();
}

function saveMessage(chatId, role, content) {
  if (!chatId || !chatExists.get(chatId)) return null;
  const createdAt = nowIso();
  const info = insertMessage.run(chatId, role, content, createdAt);
  touchChat.run(createdAt, chatId);
  return { id: info.lastInsertRowid, chat_id: chatId, role, content, created_at: createdAt };
}

function saveVersion(chatId, prompt, html) {
  if (!chatId || !chatExists.get(chatId)) return null;
  const createdAt = nowIso();
  const info = insertVersion.run(chatId, prompt, html, createdAt);
  touchChat.run(createdAt, chatId);
  return { id: info.lastInsertRowid, chat_id: chatId, prompt, html, created_at: createdAt };
}

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// --- Auth middleware ---
function authMiddleware(req, res, next) {
  if (!APP_PASSWORD) return next(); // no password = open (dev)
  const token = req.cookies?.auth_token || req.headers["x-auth-token"];
  if (token === APP_PASSWORD) return next();
  if (req.path === "/login" || req.originalUrl === "/api/login") return next();
  res.status(401).json({ error: "Não autorizado" });
}

app.use("/api", authMiddleware);

// --- Login ---
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!APP_PASSWORD || password === APP_PASSWORD) {
    res.cookie("auth_token", APP_PASSWORD || "open", {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Senha incorreta" });
});

// --- Check auth ---
app.get("/api/auth", (req, res) => {
  res.json({ authenticated: true });
});

// --- Chat persistence API ---
app.get("/api/chats", (req, res) => {
  const chats = db.prepare("SELECT id, title, updated_at FROM chats ORDER BY updated_at DESC").all();
  res.json({ chats });
});

app.post("/api/chats", (req, res) => {
  const title = String(req.body?.title || "New Chat").trim().slice(0, 120) || "New Chat";
  const id = randomUUID();
  const createdAt = nowIso();
  db.prepare("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, title, createdAt, createdAt);
  res.status(201).json({ id, title, created_at: createdAt, updated_at: createdAt });
});

app.put("/api/chats/:id", requireChat, (req, res) => {
  const title = String(req.body?.title || "").trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: "title required" });
  const updatedAt = nowIso();
  db.prepare("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?").run(title, updatedAt, req.params.id);
  res.json({ id: req.params.id, title, updated_at: updatedAt });
});

app.delete("/api/chats/:id", requireChat, (req, res) => {
  const remove = db.transaction((id) => {
    db.prepare("DELETE FROM messages WHERE chat_id = ?").run(id);
    db.prepare("DELETE FROM versions WHERE chat_id = ?").run(id);
    db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  });
  remove(req.params.id);
  res.json({ ok: true });
});

app.get("/api/chats/:id/messages", requireChat, (req, res) => {
  const messages = db.prepare("SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC").all(req.params.id);
  res.json({ messages });
});

app.get("/api/chats/:id/versions", requireChat, (req, res) => {
  const versions = db.prepare("SELECT id, prompt, html, created_at FROM versions WHERE chat_id = ? ORDER BY id ASC").all(req.params.id);
  res.json({ versions });
});

app.post("/api/chats/:id/messages", requireChat, (req, res) => {
  const role = String(req.body?.role || "").trim();
  const content = String(req.body?.content || "").trim();
  if (!role || !content) return res.status(400).json({ error: "role and content required" });
  const message = saveMessage(req.params.id, role, content);
  res.status(201).json(message);
});

app.post("/api/chats/:id/versions", requireChat, (req, res) => {
  const prompt = String(req.body?.prompt || "").trim();
  const html = String(req.body?.html || "");
  if (!prompt || !html) return res.status(400).json({ error: "prompt and html required" });
  const version = saveVersion(req.params.id, prompt, html);
  res.status(201).json(version);
});

// --- Providers API (multiplas base URL + api key, com failover) ---
app.get("/api/providers", (req, res) => {
  res.json({ providers: listProvidersSafe() });
});

app.post("/api/providers", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80) || "Provider";
  const base_url = String(req.body?.base_url || "").trim();
  const api_key = String(req.body?.api_key || "").trim();
  const model = String(req.body?.model || "").trim() || BRIDGE_MODEL;
  if (!base_url || !api_key) return res.status(400).json({ error: "base_url and api_key required" });
  const id = randomUUID();
  const maxOrder = db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM providers").get().m;
  db.prepare(
    "INSERT INTO providers (id, name, base_url, api_key, model, sort_order, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
  ).run(id, name, base_url, api_key, model, maxOrder + 1, nowIso());
  res.status(201).json({ id });
});

app.put("/api/providers/:id", (req, res) => {
  const existing = db.prepare("SELECT * FROM providers WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Provider not found" });
  const name = req.body?.name !== undefined ? String(req.body.name).trim().slice(0, 80) : existing.name;
  const base_url = req.body?.base_url !== undefined ? String(req.body.base_url).trim() : existing.base_url;
  const model = req.body?.model !== undefined ? (String(req.body.model).trim() || BRIDGE_MODEL) : existing.model;
  const enabled = req.body?.enabled !== undefined ? (req.body.enabled ? 1 : 0) : existing.enabled;
  const sort_order = req.body?.sort_order !== undefined ? parseInt(req.body.sort_order, 10) : existing.sort_order;
  // api_key so atualiza se vier preenchida (evita sobrescrever com mascara)
  const api_key = req.body?.api_key ? String(req.body.api_key).trim() : existing.api_key;
  db.prepare(
    "UPDATE providers SET name = ?, base_url = ?, api_key = ?, model = ?, enabled = ?, sort_order = ? WHERE id = ?"
  ).run(name, base_url, api_key, model, enabled, sort_order, req.params.id);
  res.json({ ok: true });
});

app.delete("/api/providers/:id", (req, res) => {
  db.prepare("DELETE FROM providers WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// Testa um provedor especifico (ou um payload ad-hoc) sem gerar design.
app.post("/api/providers/test", async (req, res) => {
  let base_url = String(req.body?.base_url || "").trim();
  let api_key = String(req.body?.api_key || "").trim();
  let model = String(req.body?.model || "").trim() || BRIDGE_MODEL;
  if (req.body?.id) {
    const p = db.prepare("SELECT * FROM providers WHERE id = ?").get(req.body.id);
    if (!p) return res.status(404).json({ error: "Provider not found" });
    base_url = p.base_url; api_key = p.api_key; model = p.model || BRIDGE_MODEL;
  }
  if (!base_url || !api_key) return res.status(400).json({ error: "base_url and api_key required" });
  try {
    const r = await fetch(`${base_url.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${api_key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 5 }),
    });
    const text = await r.text();
    return res.json({ ok: r.ok, status: r.status, body: text.slice(0, 200) });
  } catch (err) {
    return res.json({ ok: false, status: 0, body: err.message });
  }
});

// --- Pricing API (custo por mensagem) ---
app.get("/api/pricing", async (req, res) => {
  const pricing = loadPricing();
  const cnyToBrl = await getCnyToBrl(pricing);
  res.json({ ...pricing, cnyToBrl, fxUpdatedAt: fxCache.ts || null });
});

app.put("/api/pricing", (req, res) => {
  const cur = loadPricing();
  const body = req.body || {};
  const next = {
    ...cur,
    iofPct: body.iofPct !== undefined ? Number(body.iofPct) : cur.iofPct,
    marginPct: body.marginPct !== undefined ? Number(body.marginPct) : cur.marginPct,
    cnyToBrl: body.cnyToBrl !== undefined ? Number(body.cnyToBrl) : cur.cnyToBrl,
    models: body.models && typeof body.models === "object" ? { ...cur.models, ...body.models } : cur.models,
  };
  savePricing(next);
  if (body.cnyToBrl !== undefined) fxCache = { rate: Number(body.cnyToBrl), ts: Date.now() };
  res.json(next);
});

// --- System prompt for the design generator ---
const SYSTEM_PROMPT = `You are a world-class product designer and frontend engineer. You craft distinctive, production-quality web interfaces — each one with its own personality.

## CORE PRINCIPLE: VARIETY (avoid the "AI clone" look)
Do NOT default to the same dark Linear/Vercel template every time. Before coding, pick a deliberate visual direction that fits THIS product, and commit to it fully. Vary across requests:
- Light, dark, or colored backgrounds — choose what fits the brand/mood.
- A real, intentional color palette (pick a distinctive primary + supporting tones, not always indigo/violet). Use gradients, duotones, or warm/earthy/pastel/vibrant schemes when appropriate.
- Typography with character: pair fonts from Google Fonts (e.g. a display/serif for headings + a clean sans for body). Don't always use Inter.
- Different layout systems: asymmetric grids, sidebars, split-screens, bento grids, cards, editorial layouts — not always the same centered column.
- Personality through detail: rounded vs sharp corners, borders vs shadows, flat vs glassmorphism vs neumorphism, micro-interactions, decorative shapes/blobs, illustrations via inline SVG.

Match the aesthetic to the domain: a kids app is playful and colorful; a bank is trustworthy and refined; a creative portfolio is bold and editorial; a SaaS dashboard is crisp and data-dense. Make a real choice each time.

## QUALITY BAR
- Strong visual hierarchy, generous and consistent spacing, intentional alignment.
- Real, believable content (never "Lorem ipsum"). Use plausible names, copy, numbers.
- Depth and polish: layered shadows OR crisp borders, smooth hover/focus states (150-250ms), subtle entrance animations.
- Accessible contrast and semantic HTML.
- Fully responsive (mobile-first; test mentally at 375px and 1280px).
- Use inline SVG for icons and small illustrations (no icon-font CDNs).

## MULTI-SCREEN NAVIGATION (very important)
Most apps are NOT a single screen. Unless the request is clearly one section (e.g. "a hero" or "a pricing table"), build AT LEAST 2 navigable screens/views inside the single HTML file:
- Implement navigation with show/hide of sections via JS (data-view / hash routing), NOT separate files.
- EVERY nav link, button, and tab that implies navigation MUST lead to a real, fully-designed view — never a blank/black page and never a dead link.
- Provide a clear default/home view on load, and a visible way back to it.
- Example views to consider: Home/Landing, Dashboard, Detail, List, Settings, Login/Signup, Profile. Pick the ones that fit.
- It is OK to spend more output building the extra screens — completeness beats brevity here.
- Before finishing, verify mentally: does clicking each interactive element show real content? No empty/black screens.

## OUTPUT RULES (strict)
- IMPORTANT: Do NOT use any tools, functions, or artifacts. Respond ONLY with raw HTML text directly in your message content.
- ALWAYS output a single complete valid HTML document starting with <!DOCTYPE html>.
- ALL CSS inline in a <style> tag in <head>. ALL JS inline in a <script> tag.
- NO external dependencies except Google Fonts (via <link> in <head>).
- Must render perfectly in an iframe with sandbox="allow-scripts".
- If you receive existing HTML to modify, preserve everything not mentioned and change only what was asked.

## COMPLETION (critical)
- You have a limited output budget. ALWAYS finish with a valid, closed document ending in </html>. A complete simpler design beats a truncated elaborate one.
- Be efficient: keep tables/lists to a representative handful of rows (3-6), not dozens. Reuse CSS classes instead of repeating inline styles. Don't pad with repeated content.
- Budget your output: rough out all screens first, then add detail — never run out of tokens mid-document.

## ITERATION RULES
- When you receive currentHtml + a new request, modify the existing design surgically.
- Keep all unrelated elements, styles, structure, AND existing screens/navigation intact.
- Don't rewrite from scratch unless explicitly asked.`;

// --- Planning mode system prompt ---
const PLAN_SYSTEM_PROMPT = `Você é um designer de produto sênior atuando como assistente de PLANEJAMENTO.

No modo PLANEJAMENTO você NÃO gera HTML. Seu objetivo é entender bem o pedido e produzir um plano claro.

Você tem DOIS tipos de resposta possíveis:

=== TIPO A: PERGUNTAS GUIADAS (quando falta informação essencial) ===
Se precisar entender melhor antes de planejar, responda APENAS com um bloco de código \`\`\`questions contendo um JSON válido neste formato exato:
\`\`\`questions
{
  "intro": "frase curta e animada explicando que vai fazer algumas perguntas",
  "questions": [
    {
      "id": "plataforma",
      "label": "Em qual plataforma?",
      "options": ["Web responsivo", "Só desktop", "Só mobile"],
      "suggestion": "Web responsivo",
      "allowOther": true
    }
  ]
}
\`\`\`
REGRAS das perguntas:
- Faça de 3 a 5 perguntas objetivas, cada uma com 2 a 4 opções claras.
- SEMPRE marque uma "suggestion" (uma das options) como padrão recomendado.
- "allowOther": true permite o usuário digitar uma resposta livre.
- Pergunte só o que destrava decisões de design (plataforma, público, estilo visual, telas principais, funcionalidades-chave).
- NÃO escreva nada fora do bloco \`\`\`questions quando escolher este tipo.

=== TIPO B: PLANO (quando já há contexto suficiente ou o usuário já respondeu) ===
Produza um PLANO bem descrito em markdown: visão geral, telas/seções, componentes, layout, direção de cores e tipografia, e o que será construído. Ao final, diga que o usuário pode pedir "implementar" (ou /exec) para construir.
DECISÃO:
- Se a conversa já tem respostas suficientes (o usuário respondeu perguntas ou deu um briefing detalhado), vá direto para o TIPO B (plano). NUNCA repita perguntas já respondidas.
- Se o pedido é vago e é a primeira interação, use o TIPO A (perguntas).

REGRAS GERAIS:
- NUNCA gere HTML, código de página, nem use ferramentas.
- Responda em português. Seja focado e acionável.`;

// Mapeia mensagens persistidas do chat em contexto de conversa para o modelo (memoria).
function buildMemory(chatId, limit = 16) {
  if (!chatId) return [];
  const rows = db
    .prepare("SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id ASC")
    .all(chatId);
  const recent = rows.slice(-limit);
  const mapped = [];
  for (const m of recent) {
    if (m.role === "user") {
      mapped.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      // "✓ Design updated" é placeholder de UI; vira nota curta de contexto.
      const content = m.content === "✓ Design updated" ? "[Gerei uma versão do design conforme pedido acima.]" : m.content;
      mapped.push({ role: "assistant", content });
    }
    // ignora info/error
  }
  return mapped;
}

// --- Generate endpoint (SSE streaming) — modos plan/exec + memoria ---
app.post("/api/generate", async (req, res) => {
  const { prompt, currentHtml, chatId } = req.body || {};
  const mode = req.body?.mode === "plan" ? "plan" : "exec";
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  if (chatId && !chatExists.get(chatId)) return res.status(404).json({ error: "Chat not found" });

  // Memoria: pega o historico ANTES de salvar a mensagem atual.
  const memory = buildMemory(chatId);
  if (chatId) saveMessage(chatId, "user", prompt);

  const providers = activeProviders();
  if (providers.length === 0) {
    return res.status(503).json({
      error: "Nenhum provedor configurado. Adicione base URL + API key na aba Provedores (ou configure BRIDGE_URL/BRIDGE_TOKEN).",
    });
  }

  // Monta as mensagens conforme o modo, sempre incluindo a memoria do chat.
  const messages = [];
  if (mode === "plan") {
    messages.push({ role: "system", content: PLAN_SYSTEM_PROMPT });
    if (currentHtml) {
      messages.push({ role: "system", content: "Existe um design atual nesta conversa que pode ser refinado. Leve-o em conta ao planejar." });
    }
    messages.push(...memory);
    messages.push({ role: "user", content: prompt });
  } else {
    messages.push({ role: "system", content: SYSTEM_PROMPT });
    messages.push(...memory);
    let userMsg = prompt;
    if (currentHtml) {
      userMsg = `Here is the current HTML to modify:\n\n\`\`\`html\n${currentHtml}\n\`\`\`\n\nRequest: ${prompt}`;
    }
    userMsg += "\n\nIMPORTANTE: gere AT\u00c9 onde fizer sentido m\u00faltiplas telas/visões naveg\u00e1veis (m\u00ednimo 2 quando for um app), sem nenhum link/bot\u00e3o que leve a tela preta ou vazia. Responda APENAS com o c\u00f3digo HTML cru, sem usar nenhuma ferramenta, come\u00e7ando por <!DOCTYPE html>.";
    messages.push({ role: "user", content: userMsg });
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const failures = [];
  const pricing = loadPricing();
  const cnyToBrl = await getCnyToBrl(pricing);

  // Failover: tenta cada provedor habilitado em ordem ate um responder.
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    let fullContent = "";
    let usage = null;
    try {
      const bridgeRes = await fetch(`${provider.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: mode === "plan" ? 4000 : 16000,
          tool_choice: "none",
        }),
      });

      if (!bridgeRes.ok) {
        failures.push(`${provider.name} (${bridgeRes.status})`);
        res.write(`data: ${JSON.stringify({ info: `Provedor \"${provider.name}\" falhou (${bridgeRes.status}), tentando próximo...` })}\n\n`);
        continue; // proximo provedor
      }

      // Stream SSE do provedor para o cliente
      const reader = bridgeRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") {
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed.usage) usage = parsed.usage;
            const delta = parsed.choices?.[0]?.delta?.content || "";
            if (delta) {
              fullContent += delta;
              // Envia apenas o delta incremental (o front acumula). Evita crescimento O(n^2) do SSE.
              res.write(`data: ${JSON.stringify({ delta, mode })}\n\n`);
            }
          } catch {}
        }
      }

      // Sucesso se recebeu conteudo (com ou sem [DONE] explicito)
      if (fullContent) {
        // Estima tokens se a bridge nao mandou usage (fallback ~4 chars/token).
        if (!usage) {
          const inChars = messages.reduce((a, m) => a + (m.content?.length || 0), 0);
          usage = { prompt_tokens: Math.round(inChars / 4), completion_tokens: Math.round(fullContent.length / 4) };
        }
        const cost = computeCost(usage, provider.model, pricing, cnyToBrl);
        if (mode === "plan") {
          // Plano: salva como mensagem do assistente (memoria), NAO cria versao de design.
          if (chatId) saveMessage(chatId, "assistant", fullContent);
          res.write(`data: ${JSON.stringify({ done: true, mode: "plan", text: fullContent, provider: provider.name, cost })}\n\n`);
        } else {
          const finalHtml = finalizeHtml(fullContent);
          if (chatId) {
            saveMessage(chatId, "assistant", "\u2713 Design updated");
            saveVersion(chatId, prompt, finalHtml);
          }
          res.write(`data: ${JSON.stringify({ done: true, mode: "exec", html: finalHtml, provider: provider.name, cost })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      // Sem conteudo: trata como falha e tenta o proximo
      failures.push(`${provider.name} (vazio)`);
    } catch (err) {
      // Conexao caiu no meio. Se ja temos um documento HTML iniciado, fecha e aproveita
      // (o relay derruba streams longos) em vez de perder tudo.
      if (mode === "exec" && /<html|<!DOCTYPE/i.test(fullContent) && fullContent.length > 500) {
        if (!usage) {
          const inChars = messages.reduce((a, m) => a + (m.content?.length || 0), 0);
          usage = { prompt_tokens: Math.round(inChars / 4), completion_tokens: Math.round(fullContent.length / 4) };
        }
        const cost = computeCost(usage, provider.model, pricing, cnyToBrl);
        const finalHtml = finalizeHtml(fullContent);
        if (chatId) {
          saveMessage(chatId, "assistant", "\u2713 Design updated");
          saveVersion(chatId, prompt, finalHtml);
        }
        res.write(`data: ${JSON.stringify({ done: true, mode: "exec", html: finalHtml, provider: provider.name, cost, salvaged: true })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      failures.push(`${provider.name} (${err.message})`);
      res.write(`data: ${JSON.stringify({ info: `Provedor \"${provider.name}\" caiu no meio, tentando pr\u00f3ximo...` })}\n\n`);
      continue;
    }
  }

  // Todos os provedores falharam
  res.write(`data: ${JSON.stringify({ error: `Todos os provedores falharam: ${failures.join(", ")}` })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
});

// --- Serve frontend static files ---
const frontendPath = join(__dirname, "../../frontend/dist");
app.use(express.static(frontendPath));
app.get("*", (req, res) => {
  res.sendFile(join(frontendPath, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Claude Design App running on port ${PORT}`);
  console.log(`Bridge: ${BRIDGE_URL || "NOT SET"}`);
  console.log(`DB: ${dbPath}`);
});
