import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.resolve("data");
const AUDIO_DIR = path.resolve("public/audio");

app.use(express.json({ limit: '50mb' }));
app.use('/audio', express.static(AUDIO_DIR));

// Ensure directories exist
async function initDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(AUDIO_DIR, { recursive: true });
}

// Data Helpers
async function readJson(filename: string) {
  try {
    const data = await fs.readFile(path.join(DATA_DIR, filename), "utf-8");
    return JSON.parse(data);
  } catch (e) {
    return [];
  }
}

async function writeJson(filename: string, data: any) {
  await fs.writeFile(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

// --- API Routes ---

// 1. Config
app.get("/api/config", async (req, res) => {
  console.log("GET /api/config");
  const config = await readJson("config.json");
  res.json(config);
});

app.post("/api/config", async (req, res) => {
  console.log("POST /api/config");
  await writeJson("config.json", req.body);
  res.json({ success: true });
});

// 2. Cases
app.get("/api/cases", async (req, res) => {
  console.log("GET /api/cases");
  const cases = await readJson("cases.json");
  res.json(cases);
});

app.post("/api/cases", async (req, res) => {
  console.log("POST /api/cases");
  const cases = await readJson("cases.json");
  const newCase = { ...req.body, id: `CASE_${Date.now()}`, status: 'pending' };
  cases.push(newCase);
  await writeJson("cases.json", cases);
  res.json(newCase);
});

// 4. Save Process Result
app.post("/api/save-process-result", async (req, res) => {
  const { id, result, status, audio_comment, audio_score } = req.body;
  console.log(`POST /api/save-process-result for ${id}`);
  const cases = await readJson("cases.json");
  const caseItem = cases.find((c: any) => c.id === id);

  if (!caseItem) return res.status(404).json({ error: "Case not found" });

  caseItem.result = result;
  caseItem.status = status;
  caseItem.audio_comment = audio_comment;
  if (audio_score) caseItem.audio_score = audio_score;

  await writeJson("cases.json", cases);

  // Log
  const logs = await readJson("logs.json");
  logs.push({ timestamp: new Date().toISOString(), action: "AI_PROCESS_SAVE", case_id: id, status: "SUCCESS" });
  await writeJson("logs.json", logs);

  res.json(caseItem);
});

// 5. Save Audio
app.post("/api/save-audio", async (req, res) => {
  const { filename, data } = req.body;
  console.log(`POST /api/save-audio: ${filename} (size: ${data?.length})`);
  if (!data) {
    return res.status(400).json({ error: "No data provided" });
  }
  try {
    const filePath = path.join(AUDIO_DIR, filename);
    await fs.writeFile(filePath, Buffer.from(data, 'base64'));
    console.log(`Saved audio to ${filePath}`);
    res.json({ success: true, url: `/audio/${filename}` });
  } catch (e: any) {
    console.error(`Failed to save audio ${filename}:`, e);
    res.status(500).json({ error: "Failed to save audio", details: e.message });
  }
});

// 6. Logs
app.get("/api/logs", async (req, res) => {
  const logs = await readJson("logs.json");
  res.json(logs);
});

// 7. LLM Proxy (To bypass CORS for local models)
app.post("/api/llm-proxy", async (req, res) => {
  const { url, method, headers, body } = req.body;
  console.log(`POST /api/llm-proxy to ${url}`);
  
  try {
    const response = await fetch(url, {
      method: method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body)
    });

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("application/json")) {
      const data = await response.json();
      console.log(`LLM Proxy response from ${url}:`, JSON.stringify(data).substring(0, 500));
      res.status(response.status).json(data);
    } else {
      const text = await response.text();
      console.error(`LLM Proxy received non-JSON response from ${url} (Status: ${response.status}):`, text.substring(0, 500));
      
      // If the target returned 200 but it's not JSON, it's a failure for our purposes
      const statusCode = response.status === 200 ? 502 : response.status;
      
      res.status(statusCode).json({ 
        error: "LLM Proxy received non-JSON response", 
        status: response.status,
        details: text.substring(0, 200),
        message: "AI 网关返回了网页内容而非数据。请检查：1. API 地址是否准确（是否漏了 /v1/chat/completions）；2. 是否需要连接公司内网；3. API Key 是否有效。"
      });
    }
  } catch (e: any) {
    console.error(`LLM Proxy Error for ${url}:`, e);
    res.status(500).json({ error: "LLM Proxy failed", details: e.message });
  }
});

// Vite Integration
async function startServer() {
  await initDirs();
  
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
