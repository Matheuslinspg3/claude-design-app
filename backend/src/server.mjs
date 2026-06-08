import express from "express";
import cookieParser from "cookie-parser";
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

// --- System prompt for the design generator ---
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

// --- Generate endpoint (SSE streaming) ---
app.post("/api/generate", async (req, res) => {
  const { prompt, currentHtml, history } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "prompt required" });

  if (!BRIDGE_URL || !BRIDGE_TOKEN) {
    return res.status(503).json({
      error: "Bridge not configured. Set BRIDGE_URL and BRIDGE_TOKEN env vars.",
    });
  }

  // Build messages array
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  // Add history context (last 3 iterations for context)
  if (history && history.length > 0) {
    const recent = history.slice(-3);
    for (const h of recent) {
      messages.push({ role: "user", content: h.prompt });
      messages.push({ role: "assistant", content: h.html.slice(0, 500) + "\n[... truncated for context ...]" });
    }
  }

  // Current request
  let userMsg = prompt;
  if (currentHtml) {
    userMsg = `Here is the current HTML to modify:\n\n\`\`\`html\n${currentHtml}\n\`\`\`\n\nRequest: ${prompt}`;
  }
  messages.push({ role: "user", content: userMsg });

  // Set up SSE
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
        tool_choice: "none",
      }),
    });

    if (!bridgeRes.ok) {
      const errText = await bridgeRes.text();
      res.write(`data: ${JSON.stringify({ error: `Bridge error ${bridgeRes.status}: ${errText.slice(0, 200)}` })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    // Stream SSE from bridge to client
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
        if (data === "[DONE]") {
          res.write(`data: ${JSON.stringify({ done: true, html: fullContent })}\n\n`);
          res.write("data: [DONE]\n\n");
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || "";
          if (delta) {
            fullContent += delta;
            res.write(`data: ${JSON.stringify({ delta, partial: fullContent })}\n\n`);
          }
        } catch {}
      }
    }

    // If bridge didn't send [DONE], send it ourselves
    if (!fullContent.includes("[DONE]")) {
      res.write(`data: ${JSON.stringify({ done: true, html: fullContent })}\n\n`);
      res.write("data: [DONE]\n\n");
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.write("data: [DONE]\n\n");
  }
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
});
