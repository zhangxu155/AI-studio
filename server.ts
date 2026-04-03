import express from "express";
import { createServer as createViteServer } from "vite";
import fs from "fs/promises";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;

const DATA_DIR = path.resolve("data");
const AUDIO_DIR = path.resolve("data/audio");

app.use(express.json({ limit: '50mb' }));
app.use('/audio', express.static(AUDIO_DIR));

// Ensure directories exist
async function initDirs() {
  console.log("Initializing directories...");
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(AUDIO_DIR, { recursive: true });
  console.log(`DATA_DIR: ${DATA_DIR}`);
  console.log(`AUDIO_DIR: ${AUDIO_DIR}`);
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

app.delete("/api/cases/:id", async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/cases/${id}`);
  let cases = await readJson("cases.json");
  const initialLength = cases.length;
  cases = cases.filter((c: any) => c.id !== id);
  
  if (cases.length === initialLength) {
    return res.status(404).json({ error: "Case not found" });
  }
  
  await writeJson("cases.json", cases);
  res.json({ success: true });
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
    // Ensure directory exists again just in case
    await fs.mkdir(AUDIO_DIR, { recursive: true });
    
    const filePath = path.join(AUDIO_DIR, filename);
    
    // Strip base64 prefix if present
    let base64Data = data;
    if (data.includes(',')) {
      base64Data = data.split(',')[1];
    }
    
    await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'));
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

// 7. Volcengine TTS Proxy
app.post('/api/volc-tts', async (req, res) => {
  const {
    text,
    appid,
    token,
    access_token,
    accessKey,
    access_key,
    resource_id,
    speaker,
    format
  } = req.body;
  const authToken = token || access_token || accessKey || access_key;
  
  if (!appid || !authToken) {
    return res.status(400).json({ error: "Missing Volcengine AppID or Access Token" });
  }
  if (!text) {
    return res.status(400).json({ error: "Missing text for TTS" });
  }

  try {
    const response = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional/sse', {
      method: 'POST',
      headers: {
        'X-Api-App-Id': appid,
        'X-Api-Access-Key': authToken,
        'X-Api-Resource-Id': resource_id || "seed-tts-1.0",
        'Content-Type': 'application/json',
        'Connection': 'keep-alive'
      },
      body: JSON.stringify({
        user: { uid: "judge_system" },
        req_params: {
          text,
          speaker: speaker || "zh_female_cancan_mars_bigtts",
          audio_params: {
            format: format || "mp3",
            sample_rate: 24000
          },
          additions: JSON.stringify({
            explicit_language: "zh",
            disable_markdown_filter: true
          })
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Volcengine TTS failed: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      throw new Error("Volcengine TTS response has no body stream");
    }

    const decoder = new TextDecoder("utf-8");
    const reader = response.body.getReader();
    const audioChunks: Buffer[] = [];
    let gotAnyEvent = false;
    let gotBusinessError = false;
    let sseBuffer = "";
    let eventName = "";
    let eventData = "";

    const handleEvent = (evt: { event: string; data: string }) => {
      gotAnyEvent = true;
      try {
        const payload = JSON.parse(evt.data);
        if (payload.code === 0 && payload.data) {
          audioChunks.push(Buffer.from(payload.data, "base64"));
          return;
        }
        if (payload.code > 0 && payload.code !== 20000000) {
          gotBusinessError = true;
          console.error("Volcengine TTS business error:", payload);
        }
      } catch {
        console.warn("Failed to parse Volcengine SSE event:", evt.data?.slice(0, 120));
      }
    };

    const flushLineBuffer = () => {
      while (true) {
        const newlineIndex = sseBuffer.indexOf("\n");
        if (newlineIndex === -1) break;
        let line = sseBuffer.slice(0, newlineIndex);
        sseBuffer = sseBuffer.slice(newlineIndex + 1);
        line = line.replace(/\r$/, "");

        if (line === "") {
          if (eventData) {
            handleEvent({ event: eventName || "message", data: eventData.replace(/\n$/, "") });
          }
          eventName = "";
          eventData = "";
          continue;
        }
        if (line.startsWith(":")) continue;
        const colonIndex = line.indexOf(":");
        if (colonIndex === -1) continue;
        const field = line.slice(0, colonIndex);
        const value = line.slice(colonIndex + 1).trimStart();
        if (field === "event") eventName = value;
        if (field === "data") eventData += value + "\n";
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      flushLineBuffer();
    }
    sseBuffer += decoder.decode();
    flushLineBuffer();

    if (!gotAnyEvent) {
      throw new Error("No SSE events received from Volcengine TTS");
    }
    if (gotBusinessError) {
      throw new Error("Volcengine TTS returned business error events");
    }
    const finalBuffer = Buffer.concat(audioChunks);
    if (!finalBuffer.length) {
      throw new Error("Volcengine TTS returned empty audio");
    }
    res.json({ data: finalBuffer.toString("base64") });
  } catch (error: any) {
    console.error("Volcengine TTS Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 8. Volcengine ASR Proxy (One-sentence recognition)
app.post('/api/volc-asr', async (req, res) => {
  const { audio, appid, token, access_token, accessKey, access_key, cluster } = req.body;
  const authToken = token || access_token || accessKey || access_key;
  
  if (!appid || !authToken) {
    return res.status(400).json({ error: "Missing Volcengine AppID or Access Token" });
  }

  try {
    const response = await fetch('https://openspeech.bytedance.com/api/v1/asr', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer;${authToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        app: { appid, token: authToken, cluster: cluster || "volcano_asr" },
        user: { uid: "judge_system" },
        audio: {
          format: "wav",
          codec: "pcm",
          rate: 16000,
          bits: 16,
          channel: 1
        },
        request: {
          reqid: Math.random().toString(36).substring(7),
          workflow: "audio_asr",
          show_utterances: true,
          result_type: "full",
          sequence: 1,
          operation: "query"
        },
        audio_data: audio // Base64 encoded audio
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Volcengine ASR failed: ${response.status} ${errorText}`);
    }

    const data: any = await response.json();
    if (data.result && data.result.length > 0) {
      res.json({ text: data.result[0].text });
    } else {
      res.status(500).json({ error: "Volcengine ASR failed", details: data });
    }
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// 9. LLM Proxy (To bypass CORS for local models)
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
    }).catch(err => {
      // Handle fetch errors (like ECONNREFUSED)
      console.error(`Fetch error to ${url}:`, err);
      if (err.message.includes('ECONNREFUSED') && (url.includes('localhost') || url.includes('127.0.0.1'))) {
        throw new Error(`无法连接到本地模型 (${url})。请注意：在云端预览环境中，'localhost' 指向服务器容器而非您的电脑。请使用公网 URL (如 Ngrok) 或切换到 Gemini 模型。`);
      }
      throw err;
    });

    const contentType = response.headers.get("content-type");
    
    if (contentType && contentType.includes("application/json")) {
      const data = await response.json();
      console.log(`LLM Proxy response from ${url}:`, JSON.stringify(data).substring(0, 500));
      res.status(response.status).json(data);
    } else if (contentType && (contentType.includes("audio/") || contentType.includes("application/octet-stream"))) {
      // Handle binary audio data
      const buffer = await response.arrayBuffer();
      console.log(`LLM Proxy received audio data from ${url} (Size: ${buffer.byteLength})`);
      res.setHeader("Content-Type", contentType);
      res.status(response.status).send(Buffer.from(buffer));
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
    let errorMessage = "LLM Proxy failed";
    if (e.code === 'ECONNREFUSED' || e.message.includes('ECONNREFUSED')) {
      if (url.includes('localhost') || url.includes('127.0.0.1')) {
        errorMessage = `连接被拒绝：程序运行在云端，无法直接访问您本地的 localhost。请使用公网 IP 或 ngrok 等穿透工具，并将地址填入配置中。`;
      } else {
        errorMessage = `无法连接到目标服务器 (${url})，请检查地址是否正确或服务是否已启动。`;
      }
    }
    res.status(500).json({ error: errorMessage, details: e.message });
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
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
