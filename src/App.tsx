import React, { useState, useEffect, useRef } from 'react';
import { Settings, Users, PlayCircle, FileText, Activity, ShieldAlert, CheckCircle2, Loader2, Volume2, Trophy, RefreshCw, Sparkles, Mic, Square, Radio } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI, Modality } from "@google/genai";

// --- Utilities ---

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

async function pcmToWavBase64(pcmBase64: string, sampleRate: number = 24000): Promise<string> {
  try {
    if (!pcmBase64) throw new Error("PCM data is empty");
    const binaryString = atob(pcmBase64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    const buffer = new ArrayBuffer(44 + len);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    view.setUint32(0, 0x52494646, false); // "RIFF"
    view.setUint32(4, 36 + len, true); // ChunkSize
    view.setUint32(8, 0x57415645, false); // "WAVE"

    // fmt sub-chunk
    view.setUint32(12, 0x666d7420, false); // "fmt "
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, 1, true); // AudioFormat (PCM)
    view.setUint16(22, 1, true); // NumChannels (Mono)
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * 2, true); // ByteRate
    view.setUint16(32, 2, true); // BlockAlign
    view.setUint16(34, 16, true); // BitsPerSample

    // data sub-chunk
    view.setUint32(36, 0x64617461, false); // "data"
    view.setUint32(40, len, true); // Subchunk2Size

    // Write PCM data
    const uint8View = new Uint8Array(buffer);
    uint8View.set(bytes, 44);

    // Convert to base64 using FileReader for robustness
    const blob = new Blob([buffer], { type: 'audio/wav' });
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64 = (reader.result as string).split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch (e: any) {
    console.error("pcmToWavBase64 error:", e);
    throw e;
  }
}

// --- Components ---

const NavItem = ({ icon: Icon, label, active, onClick }: any) => (
  <button
    onClick={onClick}
    className={cn(
      "flex items-center gap-3 px-6 py-4 transition-all duration-300 border-l-4",
      active 
        ? "bg-emerald-50 text-emerald-700 border-emerald-500" 
        : "text-slate-500 border-transparent hover:bg-slate-50"
    )}
  >
    <Icon size={20} />
    <span className="font-medium">{label}</span>
  </button>
);

export default function App() {
  const [activeTab, setActiveTab] = useState('judge');
  const [config, setConfig] = useState<any>(null);
  const [cases, setCases] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const fetchWithRetry = async (url: string, options: any = {}, retries: number = 3) => {
    for (let i = 0; i < retries; i++) {
      try {
        const res = await fetch(url, options);
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || `HTTP error! status: ${res.status}`);
        }
        return res;
      } catch (e: any) {
        console.warn(`Fetch attempt ${i + 1} failed for ${url}:`, e);
        if (i === retries - 1) throw e;
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      }
    }
    throw new Error(`Failed to fetch ${url} after ${retries} attempts`);
  };

  const fetchData = async () => {
    try {
      const [configRes, casesRes] = await Promise.all([
        fetchWithRetry('/api/config'),
        fetchWithRetry('/api/cases')
      ]);
      setConfig(await configRes.json());
      setCases(await casesRes.json());
    } catch (e: any) {
      console.error("Fetch error", e);
      alert(`数据加载失败: ${e.message}`);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const getGenAI = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    return new GoogleGenAI({ apiKey });
  };

  const callLLM = async (prompt: string) => {
    try {
      if (config.llm?.provider === 'local') {
        // Automatically append /chat/completions if missing for OpenAI-compatible APIs
        let targetUrl = config.llm.local_url;
        if (targetUrl && !targetUrl.endsWith('/chat/completions') && !targetUrl.endsWith('/completions')) {
          targetUrl = targetUrl.endsWith('/') ? targetUrl + 'chat/completions' : targetUrl + '/chat/completions';
        }

        const response = await fetch('/api/llm-proxy', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            url: targetUrl,
            method: 'POST',
            headers: config.llm.local_api_key ? { 'Authorization': `Bearer ${config.llm.local_api_key}` } : {},
            body: {
              model: config.llm.local_model,
              messages: [
                { role: 'user', content: prompt + "\n\n请直接输出 JSON 字符串，不要包含任何 Markdown 代码块格式。" }
              ],
              temperature: 0.7
            }
          })
        });

        const contentType = response.headers.get("content-type");
        let result;
        if (contentType && contentType.includes("application/json")) {
          result = await response.json();
        } else {
          const text = await response.text();
          throw new Error(`服务器返回了非 JSON 响应 (状态码: ${response.status})。内容片段: ${text.substring(0, 100)}`);
        }
        
        if (!response.ok || result.error) {
          const errMsg = result.message || result.error || JSON.stringify(result);
          throw new Error(`本地模型调用失败: ${response.status} ${errMsg}`);
        }

        // Try different common response paths (OpenAI, Ollama, Anthropic, etc.)
        let content = result.choices?.[0]?.message?.content ?? 
                      result.choices?.[0]?.text ?? 
                      result.content ?? 
                      result.message ??
                      result.data?.choices?.[0]?.message?.content;
        
        // If still not found, try to find any string property that looks like a response
        if (content === undefined || content === null) {
          if (typeof result === 'string') {
            content = result;
          } else if (result.text && typeof result.text === 'string') {
            content = result.text;
          }
        }
        
        if (content !== undefined && content !== null) {
          const processedContent = content.toString().replace(/```json/g, "").replace(/```/g, "").trim();
          if (processedContent) return processedContent;
        }
        
        console.error("LLM Response Structure:", result);
        const keys = Object.keys(result).join(', ');
        throw new Error(`本地模型返回内容为空或格式不正确。收到字段: [${keys}]。请检查终端日志查看完整响应。`);
      } else {
        const ai = getGenAI();
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: [{ parts: [{ text: prompt + "\n\n请直接输出 JSON 字符串，不要包含任何 Markdown 代码块格式。" }] }],
        });
        
        if (response.text) {
          return response.text.replace(/```json/g, "").replace(/```/g, "").trim();
        }
        throw new Error("模型返回内容为空");
      }
    } catch (error: any) {
      console.error("LLM API Error:", error);
      throw new Error(`AI 服务调用失败: ${error.message || '未知错误'}`);
    }
  };

  // Robust JSON extraction
  const extractJSON = (text: string) => {
    try {
      // 1. Try direct parse first
      return JSON.parse(text);
    } catch (e) {
      // 2. Try to find JSON block
      const start = text.indexOf('{');
      const end = text.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        const jsonStr = text.substring(start, end + 1);
        try {
          return JSON.parse(jsonStr);
        } catch (e2) {
          console.error("Failed to parse extracted JSON block:", jsonStr);
          throw new Error("模型返回的 JSON 格式不正确，请重试。");
        }
      }
      console.error("No JSON block found in text:", text);
      throw new Error("模型返回内容不包含有效的 JSON 数据。");
    }
  };

  const handleProcess = async (id: string, demoPerf: string = "", defensePerf: string = "") => {
    setLoading(true);
    try {
      const caseItem = cases.find(c => c.id === id);
      if (!caseItem) throw new Error("Case not found");

      // A. Generate Commentary & Scores
      const scoringCriteria = Object.entries(config.rules.weights)
        .map(([key, weight]: any) => {
          const maxPoints = Math.round(weight * 100);
          return `${key} (权重: ${maxPoints}%): 请根据方案内容和现场表现给出 0-${maxPoints} 之间的分数。`;
        })
        .join('\n        ');

      const prompt = `
        你是一位专业评委，正在参加「研发总院智能体大赛」。
        当前赛事阶段：${config.stage === 'final' ? '决赛' : '复赛'}。
        
        案例信息：
        团队名称：${caseItem.team_name}
        案例名称：${caseItem.case_name}
        核心方案内容：${caseItem.content}
        
        现场表现（外部输入信息）：
        作品演示表现：${demoPerf || "（未提供演示表现，请主要基于方案内容评估）"}
        现场答辩表现：${defensePerf || "（未提供答辩表现，请主要基于方案内容评估）"}
        
        点评要求：
        1. 结构：${config.rules.commentary_structure}
        2. 字数：${config.rules.commentary_length}
        3. 语言：专业、客观、具有启发性。
        
        评分标准（严格遵守权重分配）：
        ${scoringCriteria}
 
        请输出JSON格式：
        {
          "pure_comment": "结构化文字点评",
          "voice_comment": "适合语音播报的简洁版点评（60-90秒语速）",
          "scores": { 
            ${Object.keys(config.rules.weights).map(key => `"${key}": 评分`).join(',\n            ')}
          }, 
          "total_score": 总分（各项得分之和）, 
          "score_reason": "打分依据（请结合现场表现和方案内容详细说明各项得分理由）"
        }
      `;

      const text = await callLLM(prompt);
      
      // Clean and Parse JSON robustly
      const result = extractJSON(text);

      // B. Generate TTS (Optional/Best effort)
      let audio_comment = "";
      let audio_score = "";
      
      try {
        const ai = getGenAI();
        
        // Commentary Audio
        const commentaryText = config.voice_templates.commentary
          .replace("{team_name}", caseItem.team_name)
          .replace("{case_name}", caseItem.case_name)
          .replace("{content}", result.voice_comment);

        const commentaryRes = await ai.models.generateContent({
          model: "gemini-2.5-flash-preview-tts",
          contents: [{ parts: [{ text: `请用中性专业女声播报：${commentaryText}` }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
          }
        });

        const commentBase64 = commentaryRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (commentBase64) {
          try {
            const wavBase64 = await pcmToWavBase64(commentBase64);
            const saveRes = await fetchWithRetry('/api/save-audio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: `comment_${id}.wav`, data: wavBase64 })
            });
            const saveResult = await saveRes.json();
            audio_comment = saveResult.url;
          } catch (audioErr: any) {
            console.error("Failed to save commentary audio:", audioErr);
          }
        }

        // Score Audio (Final only)
        if (config.stage === 'final' && result.total_score) {
          const scoreText = config.voice_templates.score.replace("{total_score}", result.total_score);

          const scoreRes = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text: `请用中性专业女声播报：${scoreText}` }] }],
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
            }
          });

          const scoreBase64 = scoreRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (scoreBase64) {
            try {
              const wavBase64 = await pcmToWavBase64(scoreBase64);
              const saveRes = await fetchWithRetry('/api/save-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: `score_${id}.wav`, data: wavBase64 })
              });
              const saveResult = await saveRes.json();
              audio_score = saveResult.url;
            } catch (audioErr: any) {
              console.error("Failed to save score audio:", audioErr);
            }
          }
        }
      } catch (ttsError: any) {
        console.warn("TTS Generation failed:", ttsError);
      }

      // Save Results to Server
      await fetchWithRetry('/api/save-process-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          result,
          status: 'completed',
          audio_comment,
          audio_score
        })
      });

      await fetchData();
    } catch (e: any) {
      console.error("Process error", e);
      alert("处理失败: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadData = () => {
    const data = {
      config,
      cases,
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `judge_system_export_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-screen bg-slate-50 flex font-sans overflow-hidden relative">
      {/* Sidebar Toggle Button (Floating when collapsed) */}
      {isSidebarCollapsed && (
        <button 
          onClick={() => setIsSidebarCollapsed(false)}
          className="absolute top-6 left-6 z-50 p-2.5 bg-white rounded-xl border border-slate-200 shadow-lg text-emerald-600 hover:bg-slate-50 transition-all flex items-center gap-2 group"
          title="展开侧边栏"
        >
          <Trophy size={20} />
          <span className="text-xs font-bold opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap">展开菜单</span>
        </button>
      )}

      {/* Sidebar */}
      <aside className={cn(
        "bg-white border-r border-slate-200 flex flex-col shadow-sm transition-all duration-300 relative flex-shrink-0",
        isSidebarCollapsed ? "w-0 -translate-x-full overflow-hidden" : "w-64 translate-x-0"
      )}>
        <button 
          onClick={() => setIsSidebarCollapsed(true)}
          className="absolute top-6 right-4 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-colors z-10"
          title="收起侧边栏"
        >
          <Square size={16} className="rotate-90" />
        </button>

        <div className="p-8 border-bottom border-slate-100">
          <div className="flex items-center gap-2 text-emerald-600 mb-2">
            <Trophy size={32} strokeWidth={2.5} />
            <h1 className="text-2xl font-bold tracking-tight">智评系统</h1>
          </div>
          <p className="text-xs text-slate-400 uppercase tracking-widest font-semibold">AI Judge System v1.0</p>
        </div>

        <nav className="flex-1 py-4">
          <NavItem icon={PlayCircle} label="现场评委席" active={activeTab === 'judge'} onClick={() => setActiveTab('judge')} />
          <NavItem icon={Users} label="案例接入" active={activeTab === 'cases'} onClick={() => setActiveTab('cases')} />
          <NavItem icon={Settings} label="赛前配置" active={activeTab === 'config'} onClick={() => setActiveTab('config')} />
          <NavItem icon={Activity} label="日志追溯" active={activeTab === 'logs'} onClick={() => setActiveTab('logs')} />
        </nav>

        <div className="p-6 border-t border-slate-100">
          <div className="bg-slate-900 rounded-xl p-4 text-white">
            <div className="flex items-center gap-2 mb-2">
              <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              <span className="text-xs font-medium opacity-70">系统状态</span>
            </div>
            <p className="text-sm font-semibold">运行中 (正常)</p>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-10">
        <AnimatePresence mode="wait">
          {activeTab === 'judge' && (
            <motion.div
              key="judge"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-8"
            >
              <div className="flex justify-between items-end">
                <div>
                  <h2 className="text-3xl font-bold text-slate-900">现场评委席</h2>
                  <p className="text-slate-500 mt-1">当前阶段：{config?.stage === 'final' ? '决赛 (点评+打分)' : '复赛 (仅点评)'}</p>
                </div>
                <div className="flex gap-4">
                  <div className="px-4 py-2 bg-white rounded-lg border border-slate-200 shadow-sm flex items-center gap-2">
                    <CheckCircle2 size={16} className="text-emerald-500" />
                    <span className="text-sm font-medium">已完成: {cases.filter(c => c.status === 'completed').length}</span>
                  </div>
                  <div className="px-4 py-2 bg-white rounded-lg border border-slate-200 shadow-sm flex items-center gap-2">
                    <Loader2 size={16} className="text-amber-500 animate-spin" />
                    <span className="text-sm font-medium">待处理: {cases.filter(c => c.status === 'pending').length}</span>
                  </div>
                </div>
              </div>

              <div className="grid gap-6">
                {cases.length === 0 ? (
                  <div className="bg-white rounded-2xl border-2 border-dashed border-slate-200 p-20 text-center">
                    <Users size={48} className="mx-auto text-slate-300 mb-4" />
                    <p className="text-slate-500">暂无案例数据，请先在“案例接入”模块录入</p>
                  </div>
                ) : (
                  cases.map((item) => (
                    <CaseCard 
                      key={item.id} 
                      item={item} 
                      onProcess={(demo: string, defense: string) => handleProcess(item.id, demo, defense)} 
                      loading={loading}
                      stage={config?.stage}
                      callLLM={callLLM}
                    />
                  ))
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'cases' && <CasesTab onUpdate={fetchData} cases={cases} />}
          {activeTab === 'config' && <ConfigTab config={config} onUpdate={fetchData} callLLM={callLLM} />}
          {activeTab === 'logs' && <LogsTab config={config} cases={cases} />}
        </AnimatePresence>
      </main>
    </div>
  );
}

// --- Sub-components ---

const CaseCard = ({ item, onProcess, loading, stage, callLLM }: any) => {
  const [playing, setPlaying] = useState<string | null>(null);
  const [demoPerf, setDemoPerf] = useState("");
  const [defensePerf, setDefensePerf] = useState("");
  
  // Live Perception State
  const [isListening, setIsListening] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startListening = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        await handleLiveSummarization(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsListening(true);
    } catch (err) {
      console.error("Failed to start listening", err);
      alert("无法开启麦克风，请检查权限设置。");
    }
  };

  const stopListening = () => {
    if (mediaRecorderRef.current && isListening) {
      mediaRecorderRef.current.stop();
      setIsListening(false);
    }
  };

  const handleLiveSummarization = async (blob: Blob) => {
    setIsSummarizing(true);
    try {
      // Convert blob to base64
      const reader = new FileReader();
      const base64Promise = new Promise<string>((resolve) => {
        reader.onloadend = () => {
          const base64String = (reader.result as string).split(',')[1];
          resolve(base64String);
        };
      });
      reader.readAsDataURL(blob);
      const base64Audio = await base64Promise;

      const prompt = `
        你是一个专业的赛事观察员。请根据这段现场录音（包含选手的演示说明和评委的答辩对话），总结选手的现场表现。
        
        请输出JSON格式：
        {
          "demo_summary": "作品演示表现总结（如：演示过程是否流畅，是否有技术故障，操作是否便捷等）",
          "defense_summary": "现场答辩表现总结（如：逻辑是否清晰，回答问题是否准确，反应速度等）"
        }
      `;

      const ai = new GoogleGenAI({ apiKey: (process as any).env.GEMINI_API_KEY });
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          { text: prompt },
          {
            inlineData: {
              mimeType: "audio/wav",
              data: base64Audio
            }
          }
        ],
        config: { responseMimeType: "application/json" }
      });

      const result = JSON.parse(response.text || "{}");
      if (result.demo_summary) setDemoPerf(result.demo_summary);
      if (result.defense_summary) setDefensePerf(result.defense_summary);
      
    } catch (err) {
      console.error("Summarization failed", err);
      alert("现场表现自动总结失败，您可以手动输入。");
    } finally {
      setIsSummarizing(false);
    }
  };

  const playAudio = (url: string, type: string) => {
    if (!url) {
      alert("暂无语音文件，请先点击“开始 AI 智能评测”生成。");
      return;
    }
    
    console.log(`Attempting to play audio from: ${url}`);
    
    // 添加时间戳防止浏览器缓存旧的错误文件
    const audio = new Audio(`${url}?t=${Date.now()}`);
    setPlaying(type);
    
    audio.oncanplaythrough = () => {
      console.log("Audio can play through");
      audio.play().catch(e => {
        console.error("Audio play error:", e);
        setPlaying(null);
        alert(`语音播放失败: ${e.message || '浏览器限制或文件损坏'}`);
      });
    };

    audio.onended = () => {
      console.log("Audio playback ended");
      setPlaying(null);
    };

    audio.onerror = (e) => {
      console.error("Audio loading error:", e, audio.error);
      setPlaying(null);
      let msg = "语音资源加载失败";
      if (audio.error) {
        switch (audio.error.code) {
          case 1: msg += " (加载被中止)"; break;
          case 2: msg += " (网络错误)"; break;
          case 3: msg += " (解码错误)"; break;
          case 4: msg += " (资源不支持)"; break;
        }
      }
      alert(`${msg}，请检查网络或重新生成。`);
    };

    audio.load();
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
      <div className="p-6 flex justify-between items-start">
        <div className="flex gap-4">
          <div className="w-12 h-12 bg-emerald-100 rounded-xl flex items-center justify-center text-emerald-600 font-bold text-xl">
            {item.team_name[0]}
          </div>
          <div>
            <h3 className="text-xl font-bold text-slate-900">{item.case_name}</h3>
            <p className="text-slate-500 text-sm">{item.team_name} · 团队 ID: {item.id}</p>
          </div>
        </div>
        <div className={cn(
          "px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider",
          item.status === 'completed' ? "bg-emerald-100 text-emerald-700" : 
          item.status === 'fallback' ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-500"
        )}>
          {item.status === 'completed' ? '已生成' : item.status === 'fallback' ? '兜底模式' : '待处理'}
        </div>
      </div>

      <div className="px-6 pb-6">
        <div className="bg-slate-50 rounded-xl p-4 mb-6">
          <p className="text-sm text-slate-600 line-clamp-2 italic">“{item.content}”</p>
        </div>

        {/* Live Perception Section */}
        {item.status !== 'completed' && item.status !== 'fallback' && (
          <div className="mb-6 p-4 bg-emerald-50/50 border border-emerald-100 rounded-2xl">
            <div className="flex justify-between items-center mb-4">
              <div className="flex items-center gap-2">
                <div className={cn(
                  "w-2 h-2 rounded-full",
                  isListening ? "bg-red-500 animate-pulse" : "bg-slate-300"
                )} />
                <span className="text-sm font-bold text-slate-700">现场智能感知助手</span>
              </div>
              <button
                onClick={isListening ? stopListening : startListening}
                disabled={isSummarizing}
                className={cn(
                  "px-4 py-2 rounded-lg font-bold text-xs flex items-center gap-2 transition-all",
                  isListening 
                    ? "bg-red-100 text-red-600 hover:bg-red-200" 
                    : "bg-emerald-600 text-white hover:bg-emerald-700"
                )}
              >
                {isSummarizing ? (
                  <Loader2 className="animate-spin" size={14} />
                ) : isListening ? (
                  <Square size={14} fill="currentColor" />
                ) : (
                  <Mic size={14} />
                )}
                {isSummarizing ? "正在智能总结现场表现..." : isListening ? "停止监听并总结" : "开启现场监听"}
              </button>
            </div>
            
            {isListening && (
              <div className="flex items-center gap-3 py-2 px-3 bg-white rounded-xl border border-emerald-100 mb-4">
                <Radio className="text-red-500 animate-pulse" size={16} />
                <span className="text-xs text-slate-500 font-medium">正在实时感知现场演示与答辩对话...</span>
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
                  作品演示表现 (AI 自动总结)
                </label>
                <textarea 
                  value={demoPerf}
                  onChange={(e) => setDemoPerf(e.target.value)}
                  placeholder="开启监听后自动填充..."
                  className="w-full h-24 px-3 py-2 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none resize-none text-sm transition-all"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1">
                  现场答辩表现 (AI 自动总结)
                </label>
                <textarea 
                  value={defensePerf}
                  onChange={(e) => setDefensePerf(e.target.value)}
                  placeholder="开启监听后自动填充..."
                  className="w-full h-24 px-3 py-2 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none resize-none text-sm transition-all"
                />
              </div>
            </div>
          </div>
        )}

        {item.status === 'completed' || item.status === 'fallback' ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <button 
                onClick={() => playAudio(item.audio_comment, 'comment')}
                disabled={playing !== null}
                className="flex items-center justify-center gap-2 py-3 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700 transition-colors disabled:opacity-50"
              >
                {playing === 'comment' ? <Loader2 className="animate-spin" size={20} /> : <Volume2 size={20} />}
                一键播放点评
              </button>
              {stage === 'final' && (
                <button 
                  onClick={() => playAudio(item.audio_score, 'score')}
                  disabled={playing !== null}
                  className="flex items-center justify-center gap-2 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-700 transition-colors disabled:opacity-50"
                >
                  {playing === 'score' ? <Loader2 className="animate-spin" size={20} /> : <Trophy size={20} />}
                  一键播放报分
                </button>
              )}
            </div>
            
            <div className="p-4 border border-slate-100 rounded-xl bg-white">
              <div className="flex justify-between items-center mb-4">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">AI 评语摘要</span>
                {stage === 'final' && (
                  <div className="text-2xl font-black text-emerald-600">{item.result?.total_score} <span className="text-sm font-normal text-slate-400">分</span></div>
                )}
              </div>
              
              {stage === 'final' && item.result?.scores && (
                <div className="grid grid-cols-2 gap-2 mb-4 pb-4 border-b border-slate-50">
                  {Object.entries(item.result.scores).map(([k, v]: any) => (
                    <div key={k} className="flex justify-between items-center bg-slate-50 px-3 py-1.5 rounded-lg">
                      <span className="text-[10px] text-slate-500 uppercase font-bold">{k.replace('_', ' ')}</span>
                      <span className="text-xs font-black text-slate-700">{v}</span>
                    </div>
                  ))}
                </div>
              )}

              <p className="text-sm text-slate-700 leading-relaxed mb-3">{item.result?.pure_comment}</p>
              {item.result?.score_reason && (
                <div className="mt-2 p-3 bg-amber-50 rounded-lg border border-amber-100">
                  <p className="text-[10px] font-bold text-amber-600 uppercase mb-1">打分依据</p>
                  <p className="text-xs text-amber-800 leading-relaxed">{item.result.score_reason}</p>
                </div>
              )}
            </div>

            {(item.status === 'fallback' || item.status === 'completed') && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">更新演示表现</label>
                    <input 
                      value={demoPerf}
                      onChange={(e) => setDemoPerf(e.target.value)}
                      placeholder="补充演示细节..."
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-100 rounded-lg outline-none focus:border-emerald-500"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold text-slate-400 uppercase">更新答辩表现</label>
                    <input 
                      value={defensePerf}
                      onChange={(e) => setDefensePerf(e.target.value)}
                      placeholder="补充答辩细节..."
                      className="w-full px-3 py-1.5 text-xs bg-white border border-slate-100 rounded-lg outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>
                <button 
                  onClick={() => onProcess(demoPerf, defensePerf)}
                  disabled={loading}
                  className="w-full py-3 border-2 border-dashed border-slate-200 text-slate-400 rounded-xl font-bold hover:border-emerald-500 hover:text-emerald-500 transition-all flex items-center justify-center gap-2"
                >
                  {loading ? <Loader2 className="animate-spin" size={20} /> : <RefreshCw size={18} />}
                  {item.status === 'completed' ? '重新生成 AI 评语' : '重新尝试 AI 智能评测'}
                </button>
              </div>
            )}
          </div>
        ) : (
          <button 
            onClick={() => onProcess(demoPerf, defensePerf)}
            disabled={loading}
            className="w-full py-4 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition-colors flex items-center justify-center gap-2"
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : <PlayCircle size={20} />}
            开始 AI 智能评测
          </button>
        )}
      </div>
    </div>
  );
};

const CasesTab = ({ onUpdate, cases }: any) => {
  const [formData, setFormData] = useState({ team_name: '', case_name: '', content: '' });

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    await fetch('/api/cases', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(formData)
    });
    setFormData({ team_name: '', case_name: '', content: '' });
    onUpdate();
  };

  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
        <h3 className="text-xl font-bold mb-6 flex items-center gap-2">
          <FileText className="text-emerald-500" /> 录入新案例
        </h3>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-700">团队名称</label>
              <input 
                required
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none"
                value={formData.team_name}
                onChange={e => setFormData({ ...formData, team_name: e.target.value })}
                placeholder="如：极客先锋队"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-700">案例名称</label>
              <input 
                required
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none"
                value={formData.case_name}
                onChange={e => setFormData({ ...formData, case_name: e.target.value })}
                placeholder="如：智能代码助手"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-slate-700">核心内容 (建议 500-1000 字)</label>
            <textarea 
              required
              rows={6}
              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-emerald-500 outline-none"
              value={formData.content}
              onChange={e => setFormData({ ...formData, content: e.target.value })}
              placeholder="请输入项目背景、技术架构、创新点及应用价值..."
            />
          </div>
          <button type="submit" className="w-full py-4 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-700 transition-all">
            确认录入案例
          </button>
        </form>
      </div>

      <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
        <h3 className="text-xl font-bold mb-6">已录入列表 ({cases.length})</h3>
        <div className="divide-y divide-slate-100">
          {cases.map((c: any) => (
            <div key={c.id} className="py-4 flex justify-between items-center">
              <div>
                <p className="font-bold text-slate-900">{c.case_name}</p>
                <p className="text-xs text-slate-400 uppercase tracking-widest">{c.team_name}</p>
              </div>
              <span className="text-xs font-mono text-slate-300">{c.id}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const ConfigTab = ({ config, onUpdate, callLLM }: any) => {
  if (!config) return null;

  const [extracting, setExtracting] = useState(false);
  const [standardText, setStandardText] = useState('');
  const [editingWeights, setEditingWeights] = useState({ ...config.rules.weights });
  const [editingTemplates, setEditingTemplates] = useState({ ...config.voice_templates });
  const [editingLLM, setEditingLLM] = useState({ 
    provider: 'gemini',
    local_url: 'http://localhost:11434/v1/chat/completions',
    local_model: 'llama3',
    local_api_key: '',
    ...config.llm 
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditingWeights({ ...config.rules.weights });
    setEditingTemplates({ ...config.voice_templates });
    setEditingLLM({ 
      provider: 'gemini',
      local_url: 'http://localhost:11434/v1/chat/completions',
      local_model: 'llama3',
      local_api_key: '',
      ...config.llm 
    });
  }, [config]);

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      // Ensure weights sum to 1.0 (approximately)
      const sum = Object.values(editingWeights).reduce((a: any, b: any) => a + b, 0) as number;
      if (Math.abs(sum - 1) > 0.05) { // Allow some floating point variance
        if (!confirm(`当前权重总和为 ${(sum * 100).toFixed(1)}%，建议总和为 100%。是否继续保存？`)) {
          setSaving(false);
          return;
        }
      }

      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          ...config, 
          llm: editingLLM,
          rules: { 
            ...config.rules, 
            weights: editingWeights 
          },
          voice_templates: editingTemplates
        })
      });
      alert('配置已保存');
      onUpdate();
    } catch (e) {
      console.error(e);
      alert('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleExtractRules = async () => {
    if (!standardText.trim()) return alert('请输入评分标准描述');
    setExtracting(true);
    try {
      const prompt = `
        你是一个专业的赛事规则解析助手。请将以下非结构化的评分标准描述解析为结构化的 JSON 权重配置。
        
        输入描述：
        ${standardText}
        
        要求：
        1. 提取核心评分维度（如：技术创新、业务价值、现场表现等）。
        2. 为每个维度分配权重（0.0 到 1.0 之间），所有维度权重之和必须等于 1.0。
        3. 维度 key 请直接使用中文名称（如："技术创新"）。
        
        输出格式：
        {
          "weights": {
            "维度名称": 0.3,
            "维度名称2": 0.7
          }
        }
      `;

      const text = await callLLM(prompt);
      
      const cleanedText = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const result = JSON.parse(cleanedText);

      if (result.weights) {
        await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            ...config, 
            rules: { 
              ...config.rules, 
              weights: result.weights 
            } 
          })
        });
        alert('评分规则已通过 AI 成功提取并应用');
        onUpdate();
      }
    } catch (e) {
      console.error(e);
      alert('AI 提取失败，请检查模型配置或输入内容');
    } finally {
      setExtracting(false);
    }
  };

  const handleToggleStage = async () => {
    const newStage = config.stage === 'semi-final' ? 'final' : 'semi-final';
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...config, stage: newStage })
    });
    onUpdate();
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
        <h3 className="text-xl font-bold mb-6">AI 评分标准提取</h3>
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            你可以直接粘贴一段文字描述（例如：“技术创新占40%，商业价值30%，现场演示20%，文档完整性10%”），AI 将自动解析并构建评分规则。
          </p>
          <textarea 
            value={standardText}
            onChange={(e) => setStandardText(e.target.value)}
            placeholder="在此输入评分标准描述..."
            className="w-full h-32 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none resize-none text-sm"
          />
          <div className="flex justify-end">
            <button 
              onClick={handleExtractRules}
              disabled={extracting}
              className={cn(
                "px-6 py-2 rounded-xl font-bold flex items-center gap-2 transition-all",
                extracting ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-emerald-600 text-white hover:bg-emerald-700"
              )}
            >
              {extracting ? (
                <>
                  <div className="w-4 h-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                  正在解析...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  AI 自动提取规则
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
        <h3 className="text-xl font-bold mb-8">AI 模型引擎配置</h3>
        <div className="space-y-6">
          <div className="flex gap-4 p-1 bg-slate-100 rounded-xl w-fit">
            <button 
              onClick={() => setEditingLLM({ ...editingLLM, provider: 'gemini' })}
              className={cn(
                "px-6 py-2 rounded-lg font-bold transition-all",
                editingLLM.provider === 'gemini' ? "bg-white text-emerald-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              Gemini (云端)
            </button>
            <button 
              onClick={() => setEditingLLM({ ...editingLLM, provider: 'local' })}
              className={cn(
                "px-6 py-2 rounded-lg font-bold transition-all",
                editingLLM.provider === 'local' ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              本地大模型 (Ollama/LM Studio)
            </button>
          </div>

          {editingLLM.provider === 'local' ? (
            <div className="grid grid-cols-2 gap-6 p-6 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-700">API 地址</label>
                <input 
                  type="text"
                  value={editingLLM.local_url}
                  onChange={e => setEditingLLM({ ...editingLLM, local_url: e.target.value })}
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="http://localhost:11434/v1/chat/completions"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-700">模型名称</label>
                <input 
                  type="text"
                  value={editingLLM.local_model}
                  onChange={e => setEditingLLM({ ...editingLLM, local_model: e.target.value })}
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="llama3 / qwen2"
                />
              </div>
              <div className="space-y-2 col-span-2">
                <label className="text-sm font-bold text-slate-700">API Key (可选)</label>
                <input 
                  type="password"
                  value={editingLLM.local_api_key}
                  onChange={e => setEditingLLM({ ...editingLLM, local_api_key: e.target.value })}
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="如果本地服务需要鉴权请填写"
                />
              </div>
              <div className="col-span-2">
                <p className="text-xs text-slate-400">提示：本地模型需支持 OpenAI 兼容接口。Ollama 默认地址为 http://localhost:11434/v1/chat/completions</p>
              </div>
            </div>
          ) : (
            <div className="p-6 bg-emerald-50 rounded-2xl border border-emerald-100">
              <p className="text-sm text-emerald-800 font-medium">当前正在使用 Google Gemini 3.0 Flash 引擎，提供极速且智能的评审体验。</p>
            </div>
          )}
          
          <div className="flex justify-end">
            <button 
              onClick={handleSaveConfig}
              disabled={saving}
              className="px-8 py-3 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 disabled:opacity-50 transition-all"
            >
              {saving ? '正在保存...' : '保存模型配置'}
            </button>
          </div>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
        <h3 className="text-xl font-bold mb-8">赛事阶段切换</h3>
        <div className="flex items-center justify-between p-6 bg-slate-50 rounded-2xl border border-slate-100">
          <div>
            <p className="text-lg font-bold text-slate-900">
              当前模式：{config.stage === 'final' ? '决赛 (点评+打分)' : '复赛 (仅点评)'}
            </p>
            <p className="text-sm text-slate-500">切换模式将自动调整 AI 评委的输出逻辑与打分权重</p>
          </div>
          <button 
            onClick={handleToggleStage}
            className={cn(
              "px-8 py-3 rounded-xl font-bold transition-all",
              config.stage === 'final' ? "bg-indigo-600 text-white" : "bg-emerald-600 text-white"
            )}
          >
            切换到 {config.stage === 'final' ? '复赛' : '决赛'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8">
        <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold">打分权重配置</h3>
            <button 
              onClick={handleSaveConfig}
              disabled={saving}
              className="text-sm px-4 py-1.5 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存权重'}
            </button>
          </div>
          <div className="space-y-6">
            {Object.entries(editingWeights).map(([key, val]: any) => (
              <div key={key} className="space-y-2">
                <div className="flex justify-between items-center">
                  <label className="text-sm font-bold text-slate-700">{key}</label>
                  <span className="text-xs font-mono text-emerald-600">{(val * 100).toFixed(0)}%</span>
                </div>
                <input 
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={val}
                  onChange={(e) => setEditingWeights({ ...editingWeights, [key]: parseFloat(e.target.value) })}
                  className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                />
              </div>
            ))}
            <div className="pt-4 border-t border-slate-100">
              <div className="flex justify-between items-center text-sm">
                <span className="text-slate-500">权重总和</span>
                <span className={cn(
                  "font-bold",
                  Math.abs((Object.values(editingWeights).reduce((a: any, b: any) => a + b, 0) as number) - 1) < 0.01 ? "text-emerald-600" : "text-rose-500"
                )}>
                  {((Object.values(editingWeights).reduce((a: any, b: any) => a + b, 0) as number) * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold">语音播报模板</h3>
            <button 
              onClick={handleSaveConfig}
              disabled={saving}
              className="text-sm px-4 py-1.5 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50"
            >
              {saving ? '保存中...' : '保存模板'}
            </button>
          </div>
          <div className="space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-700">点评语音模板</label>
              <textarea 
                value={editingTemplates.commentary}
                onChange={(e) => setEditingTemplates({ ...editingTemplates, commentary: e.target.value })}
                rows={4}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none text-sm"
                placeholder="可用变量: {team_name}, {case_name}, {content}"
              />
              <p className="text-[10px] text-slate-400">变量说明: {'{team_name}'} 团队名, {'{case_name}'} 案例名, {'{content}'} 点评内容</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-700">报分语音模板</label>
              <textarea 
                value={editingTemplates.score}
                onChange={(e) => setEditingTemplates({ ...editingTemplates, score: e.target.value })}
                rows={2}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none text-sm"
                placeholder="可用变量: {total_score}"
              />
              <p className="text-[10px] text-slate-400">变量说明: {'{total_score}'} 最终总分</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const LogsTab = ({ config, cases }: any) => {
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    fetch('/api/logs').then(res => res.json()).then(setLogs);
  }, []);

  const handleDownloadData = () => {
    const data = {
      config,
      cases,
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `judge_system_export_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-100 flex justify-between items-center">
          <h3 className="text-xl font-bold">操作日志追溯</h3>
          <div className="flex gap-4">
            <button 
              onClick={handleDownloadData}
              className="text-sm px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-2"
            >
              <FileText size={16} />
              导出全量数据
            </button>
            <button className="text-sm text-emerald-600 font-bold hover:underline">导出为 Excel</button>
          </div>
        </div>
        <table className="w-full text-left">
          <thead className="bg-slate-50 text-slate-400 text-xs uppercase tracking-widest font-bold">
            <tr>
              <th className="px-6 py-4">时间戳</th>
              <th className="px-6 py-4">操作类型</th>
              <th className="px-6 py-4">案例 ID</th>
              <th className="px-6 py-4">状态</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {logs.map((log: any, i) => (
              <tr key={i} className="hover:bg-slate-50 transition-colors">
                <td className="px-6 py-4 text-sm text-slate-500">{new Date(log.timestamp).toLocaleString()}</td>
                <td className="px-6 py-4 text-sm font-bold text-slate-700">{log.action}</td>
                <td className="px-6 py-4 text-sm font-mono text-slate-400">{log.case_id}</td>
                <td className="px-6 py-4">
                  <span className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded text-[10px] font-bold uppercase">
                    {log.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
