import express from "express";
import cookieParser from "cookie-parser";
import initSqlJs from "sql.js";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
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

// --- Database setup (sql.js — pure JS, no native deps) ---
const dataDir = existsSync("/data") ? "/data" : "/tmp";
mkdirSync(dataDir, { recursive: true });
const dbPath = join(dataDir, "claude-design.db");

let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, role TEXT, content TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS versions (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, prompt TEXT, html TEXT, created_at TEXT);
  `);
  saveDb();
}

function saveDb() {
  try {
    const data = db.export();
    writeFileSync(dbPath, Buffer.from(data));
  } catch (e) {
    console.error("[db] save error:", e.message);
  }
}

// Debounced save (avoid writing on every single operation)
let saveTimer = null;
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDb, 500);
}

function nowIso() { return new Date().toISOString(); }

function queryAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

function run(sql, params = []) {
  db.run(sql, params);
  debouncedSave();
}

function chatExists(id) {
  return !!queryOne("SELECT id FROM chats WHERE id = ?", [id]);
}

function saveMessage(chatId, role, content) {
  if (!chatId || !chatExists(chatId)) return null;
  const createdAt = nowIso();
  run("INSERT INTO messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)", [chatId, role, content, createdAt]);
  run("UPDATE chats SET updated_at = ? WHERE id = ?", [createdAt, chatId]);
  const row = queryOne("SELECT last_insert_rowid() as id");
  return { id: row?.id, chat_id: chatId, role, content, created_at: createdAt };
}

function saveVersion(chatId, prompt, html) {
  if (!chatId || !chatExists(chatId)) return null;
  const createdAt = nowIso();
  run("INSERT INTO versions (chat_id, prompt, html, created_at) VALUES (?, ?, ?, ?)", [chatId, prompt, html, createdAt]);
  run("UPDATE chats SET updated_at = ? WHERE id = ?", [createdAt, chatId]);
  const row = queryOne("SELECT last_insert_rowid() as id");
  return { id: row?.id, chat_id: chatId, prompt, html, created_at: createdAt };
}

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

// --- Auth middleware ---
function authMiddleware(req, res, next) {
  if (!APP_PASSWORD) return next();
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

app.get("/api/auth", (req, res) => { res.json({ authenticated: true }); });

// --- Chat CRUD ---
app.get("/api/chats", (req, res) => {
  const chats = queryAll("SELECT id, title, updated_at FROM chats ORDER BY updated_at DESC");
  res.json({ chats });
});

app.post("/api/chats", (req, res) => {
  const title = String(req.body?.title || "New Chat").trim().slice(0, 120) || "New Chat";
  const id = randomUUID();
  const createdAt = nowIso();
  run("INSERT INTO chats (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [id, title, createdAt, createdAt]);
  res.status(201).json({ id, title, created_at: createdAt, updated_at: createdAt });
});

app.put("/api/chats/:id", (req, res) => {
  if (!chatExists(req.params.id)) return res.status(404).json({ error: "Chat not found" });
  const title = String(req.body?.title || "").trim().slice(0, 120);
  if (!title) return res.status(400).json({ error: "title required" });
  const updatedAt = nowIso();
  run("UPDATE chats SET title = ?, updated_at = ? WHERE id = ?", [title, updatedAt, req.params.id]);
  res.json({ id: req.params.id, title, updated_at: updatedAt });
});

app.delete("/api/chats/:id", (req, res) => {
  if (!chatExists(req.params.id)) return res.status(404).json({ error: "Chat not found" });
  run("DELETE FROM messages WHERE chat_id = ?", [req.params.id]);
  run("DELETE FROM versions WHERE chat_id = ?", [req.params.id]);
  run("DELETE FROM chats WHERE id = ?", [req.params.id]);
  res.json({ ok: true });
});

app.get("/api/chats/:id/messages", (req, res) => {
  if (!chatExists(req.params.id)) return res.status(404).json({ error: "Chat not found" });
  const messages = queryAll("SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY id ASC", [req.params.id]);
  res.json({ messages });
});

app.get("/api/chats/:id/versions", (req, res) => {
  if (!chatExists(req.params.id)) return res.status(404).json({ error: "Chat not found" });
  const versions = queryAll("SELECT id, prompt, html, created_at FROM versions WHERE chat_id = ? ORDER BY id ASC", [req.params.id]);
  res.json({ versions });
});

app.post("/api/chats/:id/messages", (req, res) => {
  if (!chatExists(req.params.id)) return res.status(404).json({ error: "Chat not found" });
  const role = String(req.body?.role || "").trim();
  const content = String(req.body?.content || "").trim();
  if (!role || !content) return res.status(400).json({ error: "role and content required" });
  const message = saveMessage(req.params.id, role, content);
  res.status(201).json(message);
});

app.post("/api/chats/:id/versions", (req, res) => {
  if (!chatExists(req.params.id)) return res.status(404).json({ error: "Chat not found" });
  const prompt = String(req.body?.prompt || "").trim();
  const html = String(req.body?.html || "");
  if (!prompt || !html) return res.status(400).json({ error: "prompt and html required" });
  const version = saveVersion(req.params.id, prompt, html);
  res.status(201).json(version);
});

// --- System prompt ---
const SYSTEM_PROMPT = `You are an expert UI designer and frontend developer. You generate beautiful, production-quality HTML interfaces.

DESIGN RULES (always follow):
- Dark theme by default, inspired by Linear/Vercel aesthetic
- Typography: use Inter or Geist Mono from Google Fonts
- Spacing scale: base 8px (8, 16, 24, 32, 48, 64)
- Color palette: neutral dark background (#0a0a0b, #141416, #1c1c1f), one intentional accent color
- Clear visual hierarchy with font size/weight contrast
- Layered shadows for depth (subtle, not heavy)
- Hover states with smooth transitions (150-200ms)
- Subtle animations where appropriate
- Mobile-responsive layout

OUTPUT RULES (strict):
- IMPORTANT: Do NOT use any tools, functions, or artifacts. Respond ONLY with raw HTML text directly in your message content.
- ALWAYS output a single complete valid HTML document starting with <!DOCTYPE html>
- ALL CSS must be inline in a <style> tag in <head>
- ALL JavaScript must be inline in a <script> tag
- NO external dependencies except Google Fonts (load via <link> in <head>)
- The HTML must render perfectly in an iframe with sandbox="allow-scripts"
- If you receive existing HTML to modify, preserve everything not mentioned in the request and only change what was asked

ITERATION RULES:
- When you receive currentHtml + a new request, modify the existing design to match the request
- Keep all unrelated elements, styles, and structure intact
- Apply changes surgically, don't rewrite from scratch unless explicitly asked`;

// Build memory from chat history
function buildMemory(chatId, limit = 16) {
  if (!chatId) return [];
  const rows = queryAll("SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id ASC", [chatId]);
  const recent = rows.slice(-limit);
  return recent.filter(m => m.role === "user" || m.role === "assistant").map(m => ({
    role: m.role,
    content: m.content === "✓ Design updated" ? "[Generated a design version as requested.]" : m.content,
  }));
}

// --- Generate (SSE streaming with failover) ---
app.post("/api/generate", async (req, res) => {
  const { prompt, currentHtml, chatId } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt required" });
  if (chatId && !chatExists(chatId)) return res.status(404).json({ error: "Chat not found" });

  const memory = buildMemory(chatId);
  if (chatId) saveMessage(chatId, "user", prompt);

  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    return res.status(503).json({ error: "Bridge not configured. Set BRIDGE_URL and BRIDGE_TOKEN env vars." });
  }

  // Build messages
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];
  messages.push(...memory);
  let userMsg = prompt;
  if (currentHtml) {
    userMsg = `Here is the current HTML to modify:\n\n\`\`\`html\n${currentHtml}\n\`\`\`\n\nRequest: ${prompt}`;
  }
  userMsg += "\n\nRespond ONLY with raw HTML code starting with <!DOCTYPE html>. No tools, no artifacts.";
  messages.push({ role: "user", content: userMsg });

  // SSE setup
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BRIDGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: BRIDGE_MODEL,
        messages,
        stream: true,
        max_tokens: 16000,
      }),
    });

    if (!bridgeRes.ok) {
      const errText = await bridgeRes.text().catch(() => "");
      res.write(`data: ${JSON.stringify({ error: `Bridge error ${bridgeRes.status}: ${errText.slice(0, 200)}` })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    const reader = bridgeRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";

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
          const delta = parsed.choices?.[0]?.delta?.content || "";
          if (delta) {
            fullContent += delta;
            res.write(`data: ${JSON.stringify({ delta })}\n\n`);
          }
        } catch {}
      }
    }

    // Save and finalize
    if (fullContent) {
      if (chatId) {
        saveMessage(chatId, "assistant", "✓ Design updated");
        saveVersion(chatId, prompt, fullContent);
      }
      res.write(`data: ${JSON.stringify({ done: true, html: fullContent })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ error: "No content received from bridge" })}\n\n`);
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
  }
  res.write("data: [DONE]\n\n");
  res.end();
});

// --- Static frontend ---
const frontendPath = join(__dirname, "../../frontend/dist");
app.use(express.static(frontendPath));
app.get("*", (req, res) => {
  res.sendFile(join(frontendPath, "index.html"));
});

// --- Start ---
initDb().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Claude Design App running on port ${PORT}`);
    console.log(`Bridge: ${BRIDGE_URL || "NOT SET"}`);
    console.log(`DB: ${dbPath}`);
  });
}).catch(err => {
  console.error("Failed to init DB:", err);
  process.exit(1);
});
