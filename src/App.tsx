import React, { useState, useEffect, useRef } from 'react';
import { Settings, Users, PlayCircle, FileText, Activity, ShieldAlert, CheckCircle2, Loader2, Volume2, Trophy, RefreshCw, Sparkles, Mic, Square, Radio, ChevronLeft, ChevronRight, Menu } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI, Modality } from "@google/genai";

// --- Utilities ---

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

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

const NavItem = ({ icon: Icon, label, active, onClick, collapsed }: any) => (
  <button
    onClick={onClick}
    className={cn(
      "w-full flex items-center gap-3 px-4 py-3 transition-all duration-300 rounded-xl relative group",
      active 
        ? "bg-blue-600 text-white shadow-lg shadow-blue-900/20" 
        : "text-slate-400 hover:bg-slate-800 hover:text-white",
      collapsed && "justify-center px-0"
    )}
  >
    <Icon size={20} />
    {!collapsed && <span className="font-medium">{label}</span>}
    {collapsed && (
      <div className="absolute left-full ml-4 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 whitespace-nowrap">
        {label}
      </div>
    )}
  </button>
);

export default function App() {
  const [activeTab, setActiveTab] = useState('judge');
  const [config, setConfig] = useState<any>(null);
  const [cases, setCases] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };

  const playAudio = (url: string, type: string) => {
    if (!url) return;
    
    if (playing === type) {
      audioRef.current?.pause();
      setPlaying(null);
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
    }

    const audio = new Audio(`${url}?t=${Date.now()}`);
    audioRef.current = audio;
    setPlaying(type);

    audio.onended = () => setPlaying(null);
    audio.onerror = () => {
      setPlaying(null);
      alert("音频播放失败，请稍后重试");
    };
    audio.play().catch(e => {
      console.error("Audio play error:", e);
      setPlaying(null);
    });
  };

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

  const callLocalTTS = async (text: string): Promise<string | null> => {
    if (!config.llm.local_tts_model) return null;
    
    try {
      // Derive TTS URL from LLM URL (replace /chat/completions with /audio/speech)
      const ttsUrl = config.llm.local_url.replace(/\/chat\/completions$/, '/audio/speech');
      
      const response = await fetch('/api/llm-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ttsUrl,
          apiKey: config.llm.local_api_key,
          body: {
            model: config.llm.local_tts_model,
            input: text,
            voice: 'alloy' // Default voice
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Local TTS failed: ${response.status} ${errorText}`);
      }

      const blob = await response.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64data = reader.result as string;
          // Remove data:audio/mpeg;base64, prefix or similar
          const commaIndex = base64data.indexOf(',');
          if (commaIndex !== -1) {
            resolve(base64data.substring(commaIndex + 1));
          } else {
            resolve(base64data);
          }
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch (error) {
      console.error("Local TTS Error:", error);
      return null;
    }
  };

  // Robust JSON extraction
  // (Moved to top level)

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
      
      const speakLocal = (text: string) => {
        if ('speechSynthesis' in window) {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = 'zh-CN';
          utterance.rate = 1.0;
          utterance.pitch = 1.0;
          window.speechSynthesis.speak(utterance);
        }
      };

      try {
        const apiKey = process.env.GEMINI_API_KEY;
        const localTtsModel = config.llm.local_tts_model;

        if (!apiKey && !localTtsModel) {
          console.warn("No TTS service configured (Gemini or Local). Using browser local TTS.");
          
          // Play local TTS immediately for feedback
          const commentaryText = config.voice_templates.commentary
            .replace("{team_name}", caseItem.team_name)
            .replace("{case_name}", caseItem.case_name)
            .replace("{content}", result.voice_comment);
          
          speakLocal(commentaryText);
          
          if (config.stage === 'final' && result.total_score) {
            const scoreText = config.voice_templates.score.replace("{total_score}", result.total_score);
            // Delay score a bit to not overlap
            setTimeout(() => speakLocal(scoreText), 2000);
          }
        } else if (localTtsModel) {
          // Use Local TTS (Qwen/OpenAI compatible)
          console.log("Using local TTS model:", localTtsModel);
          
          const commentaryText = config.voice_templates.commentary
            .replace("{team_name}", caseItem.team_name)
            .replace("{case_name}", caseItem.case_name)
            .replace("{content}", result.voice_comment);
          
          const commentBase64 = await callLocalTTS(commentaryText);
          if (commentBase64) {
            const saveRes = await fetchWithRetry('/api/save-audio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: `comment_${id}.wav`, data: commentBase64 })
            });
            const saveResult = await saveRes.json();
            audio_comment = saveResult.url;
          }

          if (config.stage === 'final' && result.total_score) {
            const scoreText = config.voice_templates.score.replace("{total_score}", result.total_score);
            const scoreBase64 = await callLocalTTS(scoreText);
            if (scoreBase64) {
              const saveRes = await fetchWithRetry('/api/save-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: `score_${id}.wav`, data: scoreBase64 })
              });
              const saveResult = await saveRes.json();
              audio_score = saveResult.url;
            }
          }
        } else {
          // Use Gemini TTS
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
      {/* Sidebar */}
      <aside className={cn(
        "bg-[#0D1425] text-white flex flex-col shadow-xl transition-all duration-300 relative flex-shrink-0 z-20",
        isSidebarCollapsed ? "w-20" : "w-64"
      )}>
        <div className={cn("p-6 mb-4 flex items-center", isSidebarCollapsed ? "justify-center" : "justify-between")}>
          {!isSidebarCollapsed && <h1 className="text-2xl font-bold text-white tracking-tight">旗评系统</h1>}
          <button 
            onClick={toggleSidebar}
            className="p-2 hover:bg-slate-800 rounded-lg transition-colors text-slate-400 hover:text-white"
            title={isSidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            {isSidebarCollapsed ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
          </button>
        </div>

        <nav className="flex-1 space-y-2 px-3">
          <NavItem icon={PlayCircle} label="现场评委席" active={activeTab === 'judge'} onClick={() => setActiveTab('judge')} collapsed={isSidebarCollapsed} />
          <NavItem icon={Users} label="案例接入" active={activeTab === 'cases'} onClick={() => setActiveTab('cases')} collapsed={isSidebarCollapsed} />
          <NavItem icon={Settings} label="赛前配置" active={activeTab === 'config'} onClick={() => setActiveTab('config')} collapsed={isSidebarCollapsed} />
          <NavItem icon={Activity} label="日志追溯" active={activeTab === 'logs'} onClick={() => setActiveTab('logs')} collapsed={isSidebarCollapsed} />
        </nav>
        
        <div className="p-6 border-t border-slate-800">
          {!isSidebarCollapsed && (
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-blue-600 shadow-lg">
                <img 
                  src="https://images.unsplash.com/photo-1578632292335-df3abbb0d586?q=80&w=1000&auto=format&fit=crop" 
                  alt="Judge Avatar" 
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              </div>
              <div>
                <p className="text-xs font-bold">当前评委</p>
                <p className="text-[10px] text-slate-400">智能体大赛专席</p>
              </div>
            </div>
          )}
          {isSidebarCollapsed && (
            <div className="w-10 h-10 rounded-full overflow-hidden border-2 border-blue-600 shadow-lg mx-auto">
              <img 
                src="https://images.unsplash.com/photo-1578632292335-df3abbb0d586?q=80&w=1000&auto=format&fit=crop" 
                alt="Judge Avatar" 
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto flex flex-col bg-white">
        {/* Header */}
        <header className="bg-white border-b border-slate-100 px-8 py-4 flex justify-between items-center sticky top-0 z-10 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <span className="w-2 h-2 rounded-full bg-blue-600 animate-pulse" />
              <span>当前阶段：</span>
              <span className="font-bold text-slate-900">{config?.stage === 'final' ? '决赛 (点评+打分)' : '复赛 (仅点评)'}</span>
            </div>
          </div>
          <div className="flex gap-4">
            <div className="px-3 py-1.5 bg-emerald-50 rounded-lg border border-emerald-100 flex items-center gap-2">
              <CheckCircle2 size={14} className="text-emerald-500" />
              <span className="text-xs font-bold text-emerald-700">已完成: {cases.filter(c => c.status === 'completed').length}</span>
            </div>
            <div className="px-3 py-1.5 bg-amber-50 rounded-lg border border-amber-100 flex items-center gap-2">
              <Loader2 size={14} className="text-amber-500 animate-spin" />
              <span className="text-xs font-bold text-amber-700">待处理: {cases.filter(c => c.status === 'pending').length}</span>
            </div>
          </div>
        </header>

        <div className="p-8">
          <AnimatePresence mode="wait">
            {activeTab === 'judge' && (
              <motion.div
                key="judge"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-6xl mx-auto space-y-6"
              >
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
                        playAudio={playAudio}
                        playing={playing}
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
        </div>
      </main>
    </div>
  );
}

// --- Sub-components ---

const CaseCard = ({ item, onProcess, loading, stage, callLLM, playAudio, playing }: any) => {
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
        model: "gemini-3-flash-preview",
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

      const result = extractJSON(response.text || "{}");
      if (result.demo_summary) setDemoPerf(result.demo_summary);
      if (result.defense_summary) setDefensePerf(result.defense_summary);
      
    } catch (err) {
      console.error("Summarization failed", err);
      alert("现场表现自动总结失败，您可以手动输入。");
    } finally {
      setIsSummarizing(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden hover:shadow-md transition-shadow">
      <div className="p-6 flex justify-between items-start">
        <div className="flex gap-4">
          <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center text-white font-bold text-xl">
            {item.team_name[0] === 'A' ? '电' : item.team_name[0]}
          </div>
          <div>
            <h3 className="text-xl font-bold text-slate-900">{item.case_name}</h3>
            <p className="text-slate-400 text-sm">{item.team_name} · 团队 ID: {item.id}</p>
          </div>
        </div>
        <div className={cn(
          "px-3 py-1 rounded-full text-xs font-bold",
          item.status === 'completed' ? "bg-emerald-50 text-emerald-600" : "bg-slate-100 text-slate-500"
        )}>
          {item.status === 'completed' ? '已生成' : '待处理'}
        </div>
      </div>

      <div className="px-6 pb-6 space-y-6">
        {/* Action Buttons */}
        {(item.status === 'completed' || item.status === 'fallback') && (
          <div className="grid grid-cols-2 gap-4">
            <button 
              onClick={() => playAudio(item.audio_comment, 'comment')}
              disabled={playing !== null}
              className="flex items-center justify-center gap-2 py-4 bg-[#3B71ED] text-white rounded-xl font-bold hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {playing === 'comment' ? <Loader2 className="animate-spin" size={20} /> : null}
              一键播放点评
            </button>
            {stage === 'final' && (
              <button 
                onClick={() => playAudio(item.audio_score, 'score')}
                disabled={playing !== null}
                className="flex items-center justify-center gap-2 py-4 bg-[#EBB04F] text-white rounded-xl font-bold hover:bg-orange-600 transition-colors disabled:opacity-50"
              >
                {playing === 'score' ? <Loader2 className="animate-spin" size={20} /> : null}
                一键播放报分
              </button>
            )}
          </div>
        )}

        {item.status === 'completed' || item.status === 'fallback' ? (
          <div className="space-y-6">
            <h4 className="text-3xl font-bold text-slate-900 flex items-center gap-2">
              <Sparkles className="text-blue-600" /> AI 评委打分
            </h4>
            
            <div className="relative flex items-end gap-8 bg-slate-50 p-8 rounded-[40px] border border-slate-100">
              {/* Avatar */}
              <div className="flex-shrink-0 w-72 h-96 overflow-hidden rounded-3xl shadow-2xl border-4 border-white relative group">
                <img 
                  src="https://images.unsplash.com/photo-1578632292335-df3abbb0d586?q=80&w=1000&auto=format&fit=crop" 
                  alt="Judge Avatar" 
                  className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                  referrerPolicy="no-referrer"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex items-end p-6">
                  <p className="text-white text-sm font-bold">AI 智能评委</p>
                </div>
              </div>

              {/* Score Box */}
              <div className="flex-1 bg-[#0D1425] rounded-[40px] p-10 text-white min-h-[380px] relative overflow-hidden shadow-2xl border border-slate-800">
                {/* Background Decoration */}
                <div className="absolute top-0 right-0 w-64 h-64 bg-blue-600/10 rounded-full blur-3xl -mr-32 -mt-32" />
                <div className="absolute bottom-0 left-0 w-48 h-48 bg-blue-900/20 rounded-full blur-3xl -ml-24 -mb-24" />
                
                <div className="relative z-10">
                  <div className="flex justify-between items-start mb-10">
                    <div className="flex items-baseline gap-2">
                      <span className="text-9xl font-bold text-[#EBB04F] tracking-tighter drop-shadow-[0_0_20px_rgba(235,176,79,0.3)]">
                        {item.result?.total_score || 0}
                      </span>
                      <span className="text-2xl text-slate-400 font-bold">分</span>
                    </div>
                    
                    {stage === 'final' && item.result?.scores && (
                      <div className="grid grid-cols-1 gap-y-3 text-right">
                        {Object.entries(item.result.scores).map(([k, v]: any) => (
                          <div key={k} className="flex items-center justify-end gap-4 group">
                            <span className="text-slate-500 text-sm group-hover:text-slate-300 transition-colors">{k}</span>
                            <span className="text-blue-400 text-3xl font-bold w-12 drop-shadow-[0_0_10px_rgba(96,165,250,0.3)]">{v}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="space-y-6">
                    <div className="flex items-center gap-2 text-[#EBB04F]">
                      <FileText size={20} />
                      <h5 className="text-2xl font-bold">AI 评语</h5>
                    </div>
                    <p className="text-slate-300 leading-relaxed text-xl line-clamp-5 font-light italic">
                      “{item.result?.pure_comment}”
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Re-process section */}
            <div className="pt-6 border-t border-slate-100 flex gap-4">
              <div className="flex-1 space-y-2">
                <input 
                  value={demoPerf}
                  onChange={(e) => setDemoPerf(e.target.value)}
                  placeholder="补充演示细节..."
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-blue-500 text-sm"
                />
              </div>
              <div className="flex-1 space-y-2">
                <input 
                  value={defensePerf}
                  onChange={(e) => setDefensePerf(e.target.value)}
                  placeholder="补充答辩细节..."
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg outline-none focus:border-blue-500 text-sm"
                />
              </div>
              <button 
                onClick={() => onProcess(demoPerf, defensePerf)}
                disabled={loading}
                className="px-6 py-2 bg-slate-100 text-slate-600 rounded-lg font-bold hover:bg-slate-200 transition-all flex items-center gap-2 whitespace-nowrap"
              >
                {loading ? <Loader2 className="animate-spin" size={16} /> : <RefreshCw size={16} />}
                重新生成
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Perception Assistant */}
            <div className="p-6 bg-blue-50 rounded-2xl border border-blue-100">
              <div className="flex justify-between items-center mb-4">
                <div className="flex items-center gap-2">
                  <div className={cn("w-2 h-2 rounded-full", isListening ? "bg-red-500 animate-pulse" : "bg-slate-300")} />
                  <span className="font-bold text-slate-700">现场智能感知助手</span>
                </div>
                <button
                  onClick={isListening ? stopListening : startListening}
                  disabled={isSummarizing}
                  className={cn(
                    "px-4 py-2 rounded-lg font-bold text-xs flex items-center gap-2 transition-all",
                    isListening ? "bg-red-500 text-white" : "bg-blue-600 text-white"
                  )}
                >
                  {isSummarizing ? <Loader2 className="animate-spin" size={14} /> : isListening ? <Square size={14} fill="currentColor" /> : <Mic size={14} />}
                  {isSummarizing ? "正在总结..." : isListening ? "停止并总结" : "开启现场监听"}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <textarea 
                  value={demoPerf}
                  onChange={(e) => setDemoPerf(e.target.value)}
                  placeholder="作品演示表现..."
                  className="w-full h-24 p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none"
                />
                <textarea 
                  value={defensePerf}
                  onChange={(e) => setDefensePerf(e.target.value)}
                  placeholder="现场答辩表现..."
                  className="w-full h-24 p-3 bg-white border border-slate-200 rounded-xl text-sm resize-none"
                />
              </div>
            </div>

            <button 
              onClick={() => onProcess(demoPerf, defensePerf)}
              disabled={loading}
              className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
            >
              {loading ? <Loader2 className="animate-spin" size={20} /> : <PlayCircle size={20} />}
              开始 AI 智能评测
            </button>
          </div>
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
        <h3 className="text-xl font-bold mb-6 flex items-center gap-2 text-slate-800">
          <FileText className="text-blue-600" /> 录入新案例
        </h3>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-700">团队名称</label>
              <input 
                required
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
                value={formData.team_name}
                onChange={e => setFormData({ ...formData, team_name: e.target.value })}
                placeholder="如：极客先锋队"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-700">案例名称</label>
              <input 
                required
                className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
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
              className="w-full px-4 py-3 rounded-xl border border-slate-200 focus:ring-2 focus:ring-blue-500 outline-none"
              value={formData.content}
              onChange={e => setFormData({ ...formData, content: e.target.value })}
              placeholder="请输入项目背景、技术架构、创新点及应用价值..."
            />
          </div>
          <button type="submit" className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all">
            确认录入案例
          </button>
        </form>
      </div>

      <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
        <h3 className="text-xl font-bold mb-6 text-slate-800">已录入列表 ({cases.length})</h3>
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
    local_tts_model: '',
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
      local_tts_model: '',
      ...config.llm 
    });
  }, [config]);

  const handleSaveConfig = async () => {
    setSaving(true);
    try {
      const sum = Object.values(editingWeights).reduce((a: any, b: any) => a + b, 0) as number;
      if (Math.abs(sum - 1) > 0.05) {
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
        <h3 className="text-xl font-bold mb-6 text-slate-800">AI 评分标准提取</h3>
        <div className="space-y-4">
          <p className="text-sm text-slate-500">
            你可以直接粘贴一段文字描述（例如：“技术创新占40%，商业价值30%，现场演示20%，文档完整性10%”），AI 将自动解析并构建评分规则。
          </p>
          <textarea 
            value={standardText}
            onChange={(e) => setStandardText(e.target.value)}
            placeholder="在此输入评分标准描述..."
            className="w-full h-32 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none resize-none text-sm"
          />
          <div className="flex justify-end">
            <button 
              onClick={handleExtractRules}
              disabled={extracting}
              className={cn(
                "px-6 py-2 rounded-xl font-bold flex items-center gap-2 transition-all",
                extracting ? "bg-slate-100 text-slate-400 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"
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
        <h3 className="text-xl font-bold mb-8 text-slate-800">AI 模型引擎配置</h3>
        <div className="space-y-6">
          <div className="flex gap-4 p-1 bg-slate-100 rounded-xl w-fit">
            <button 
              onClick={() => setEditingLLM({ ...editingLLM, provider: 'gemini' })}
              className={cn(
                "px-6 py-2 rounded-lg font-bold transition-all",
                editingLLM.provider === 'gemini' ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              Gemini (云端)
            </button>
            <button 
              onClick={() => setEditingLLM({ ...editingLLM, provider: 'local' })}
              className={cn(
                "px-6 py-2 rounded-lg font-bold transition-all",
                editingLLM.provider === 'local' ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
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
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="http://localhost:11434/v1/chat/completions"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-700">模型名称</label>
                <input 
                  type="text"
                  value={editingLLM.local_model}
                  onChange={e => setEditingLLM({ ...editingLLM, local_model: e.target.value })}
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="llama3 / qwen2"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-700">API Key (可选)</label>
                <input 
                  type="password"
                  value={editingLLM.local_api_key}
                  onChange={e => setEditingLLM({ ...editingLLM, local_api_key: e.target.value })}
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="如果本地服务需要鉴权请填写"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-700">TTS 模型名称 (可选)</label>
                <input 
                  type="text"
                  value={editingLLM.local_tts_model || ""}
                  onChange={e => setEditingLLM({ ...editingLLM, local_tts_model: e.target.value })}
                  className="w-full px-4 py-2 bg-white border border-slate-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="例如: qwen-tts / cosyvoice"
                />
              </div>
            </div>
          ) : (
            <div className="p-6 bg-blue-50 rounded-2xl border border-blue-100">
              <p className="text-sm text-blue-800 font-medium">当前正在使用 Google Gemini 引擎，提供极速且智能的评审体验。</p>
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
        <h3 className="text-xl font-bold mb-8 text-slate-800">赛事阶段切换</h3>
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
              config.stage === 'final' ? "bg-blue-600 text-white" : "bg-blue-600 text-white"
            )}
          >
            切换到 {config.stage === 'final' ? '复赛' : '决赛'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8">
        <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold text-slate-800">打分权重配置</h3>
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
                  <span className="text-xs font-mono text-blue-600">{(val * 100).toFixed(0)}%</span>
                </div>
                <input 
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={val}
                  onChange={(e) => setEditingWeights({ ...editingWeights, [key]: parseFloat(e.target.value) })}
                  className="w-full h-2 bg-slate-100 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>
            ))}
            <div className="pt-4 border-t border-slate-100">
              <div className="flex justify-between items-center text-sm">
                <span className="text-slate-500">权重总和</span>
                <span className={cn(
                  "font-bold",
                  Math.abs((Object.values(editingWeights).reduce((a: any, b: any) => a + b, 0) as number) - 1) < 0.01 ? "text-blue-600" : "text-rose-500"
                )}>
                  {((Object.values(editingWeights).reduce((a: any, b: any) => a + b, 0) as number) * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
          <div className="flex justify-between items-center mb-6">
            <h3 className="text-xl font-bold text-slate-800">语音播报模板</h3>
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
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                placeholder="可用变量: {team_name}, {case_name}, {content}"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-700">报分语音模板</label>
              <textarea 
                value={editingTemplates.score}
                onChange={(e) => setEditingTemplates({ ...editingTemplates, score: e.target.value })}
                rows={2}
                className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                placeholder="可用变量: {total_score}"
              />
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
