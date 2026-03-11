import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = 3000;

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

// AI Service removed from backend as per guidelines

// --- API Routes ---

// 1. Config
app.get("/api/config", async (req, res) => {
  const config = await readJson("config.json");
  res.json(config);
});

app.post("/api/config", async (req, res) => {
  await writeJson("config.json", req.body);
  res.json({ success: true });
});

// 2. Cases
app.get("/api/cases", async (req, res) => {
  const cases = await readJson("cases.json");
  res.json(cases);
});

app.post("/api/cases", async (req, res) => {
  const cases = await readJson("cases.json");
  const newCase = { ...req.body, id: `CASE_${Date.now()}`, status: 'pending' };
  cases.push(newCase);
  await writeJson("cases.json", cases);
  res.json(newCase);
});

// 3. Save Process Result
app.post("/api/save-process-result", async (req, res) => {
  const { id, result, status, audio_comment, audio_score } = req.body;
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

// 4. Save Audio
app.post("/api/save-audio", async (req, res) => {
  const { filename, data } = req.body;
  try {
    await fs.writeFile(path.join(AUDIO_DIR, filename), Buffer.from(data, 'base64'));
    res.json({ success: true, url: `/audio/${filename}` });
  } catch (e: any) {
    res.status(500).json({ error: "Failed to save audio", details: e.message });
  }
});

// 5. Logs
app.get("/api/logs", async (req, res) => {
  const logs = await readJson("logs.json");
  res.json(logs);
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
