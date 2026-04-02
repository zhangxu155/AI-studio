import React, { useState, useEffect, useRef } from 'react';
import { Settings, Users, PlayCircle, FileText, Activity, ShieldAlert, CheckCircle2, Loader2, Volume2, Trophy, RefreshCw, Sparkles, Mic, Square, Radio, ChevronLeft, ChevronRight, Menu } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { GoogleGenAI, Modality } from "@google/genai";
import { NavItem } from './components/NavItem';
import { cn, extractJSON, pcmToWavBase64 } from './lib/utils';

export default function App() {
  const [activeTab, setActiveTab] = useState('judge');
  const [config, setConfig] = useState<any>({
    stage: 'final',
    llm: { provider: 'local' },
    rules: { weights: {} },
    voice_templates: { commentary: '', score: '' }
  });
  const [cases, setCases] = useState<any[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [processingId, setProcessingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };

  const playAudio = async (url: string, type: string, fallbackText?: string) => {
    console.log(`Attempting to play audio: type=${type}, url=${url}`);
    
    if (playing === type) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      window.speechSynthesis?.cancel();
      setPlaying(null);
      return;
    }

    if (audioRef.current) {
      audioRef.current.pause();
    }
    window.speechSynthesis?.cancel();

    const speakWithGemini = async (text: string) => {
      try {
        setPlaying(type);
        const ai = getGenAI();
        const response = await ai.models.generateContent({
          model: "gemini-2.5-flash-preview-tts",
          contents: [{ parts: [{ text }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
          }
        });

        const pcmBase64 = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!pcmBase64) throw new Error("No audio data from Gemini");

        const wavBase64 = await pcmToWavBase64(pcmBase64);
        const blob = await (await fetch(`data:audio/wav;base64,${wavBase64}`)).blob();
        const blobUrl = URL.createObjectURL(blob);
        const audio = new Audio(blobUrl);
        audioRef.current = audio;

        audio.onended = () => {
          setPlaying(null);
          URL.revokeObjectURL(blobUrl);
        };
        
        audio.onerror = () => {
          setPlaying(null);
          URL.revokeObjectURL(blobUrl);
          speakFallback();
        };

        await audio.play();
      } catch (err) {
        console.error("Gemini TTS fallback failed:", err);
        speakFallback();
      }
    };

    const speakWithVolc = async (text: string) => {
      try {
        setPlaying(type);
        const volcBase64 = await callVolcTTS(text);
        if (!volcBase64) {
          speakFallback();
          return;
        }
        const blob = await (await fetch(`data:audio/wav;base64,${volcBase64}`)).blob();
        const blobUrl = URL.createObjectURL(blob);
        const audio = new Audio(blobUrl);
        audioRef.current = audio;
        audio.onended = () => {
          setPlaying(null);
          URL.revokeObjectURL(blobUrl);
        };
        audio.onerror = () => {
          setPlaying(null);
          URL.revokeObjectURL(blobUrl);
          speakFallback();
        };
        await audio.play();
      } catch (err) {
        console.error("Volc TTS fallback failed:", err);
        speakFallback();
      }
    };

    const speakFallback = () => {
      if (fallbackText && 'speechSynthesis' in window) {
        setPlaying(type);
        const utterance = new SpeechSynthesisUtterance(fallbackText);
        utterance.lang = 'zh-CN';
        
        const voices = window.speechSynthesis.getVoices();
        const zhVoice = voices.find(v => v.lang.includes('zh') || v.lang.includes('CN'));
        if (zhVoice) utterance.voice = zhVoice;
        
        utterance.onend = () => setPlaying(null);
        utterance.onerror = () => setPlaying(null);
        window.speechSynthesis.speak(utterance);
      } else {
        alert("该内容暂无音频，且浏览器不支持语音合成。");
        setPlaying(null);
      }
    };

    if (!url) {
      console.warn(`No audio URL provided for type: ${type}. Falling back to runtime TTS.`);
      if (fallbackText && config?.llm?.tts_provider === 'volcengine') {
        speakWithVolc(fallbackText);
      } else if (fallbackText && config?.llm?.provider === 'gemini') {
        speakWithGemini(fallbackText);
      } else {
        speakFallback();
      }
      return;
    }

    setPlaying(type);
    
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`无法获取音频文件: ${response.status}`);
      
      const blob = await response.blob();
      if (blob.size === 0) throw new Error("音频文件为空");
      
      const blobUrl = URL.createObjectURL(blob);
      const audio = new Audio(blobUrl);
      audioRef.current = audio;

      audio.onended = () => {
        setPlaying(null);
        URL.revokeObjectURL(blobUrl);
      };
      
      audio.onerror = (e) => {
        console.error("Audio element error:", e);
        setPlaying(null);
        URL.revokeObjectURL(blobUrl);
        if (fallbackText && config?.llm?.tts_provider === 'volcengine') {
          speakWithVolc(fallbackText);
        } else if (fallbackText && config?.llm?.provider === 'gemini') {
          speakWithGemini(fallbackText);
        } else {
          speakFallback();
        }
      };

      await audio.play();
    } catch (e: any) {
      console.error("Audio play error:", e);
      setPlaying(null);
      if (e.name !== 'AbortError') {
        if (fallbackText && config?.llm?.tts_provider === 'volcengine') {
          speakWithVolc(fallbackText);
        } else if (fallbackText && config?.llm?.provider === 'gemini') {
          speakWithGemini(fallbackText);
        } else {
          speakFallback();
        }
      }
    }
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
    const apiKey = (process as any).env.GEMINI_API_KEY || (process as any).env.API_KEY;
    if (!apiKey) {
      throw new Error("Gemini API key is missing. Please check your environment variables.");
    }
    return new GoogleGenAI({ apiKey });
  };

  const callLLM = async (prompt: string) => {
    if (!config || !config.llm) {
      throw new Error("配置尚未加载，请稍后再试。");
    }
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
    if (!config || !config.llm || !config.llm.local_tts_model) return null;
    
    try {
      // Derive TTS URL from LLM URL (replace /chat/completions with /audio/speech)
      const ttsUrl = config.llm.local_url.replace(/\/chat\/completions$/, '/audio/speech');
      
      const headers: Record<string, string> = {};
      if (config.llm.local_api_key) {
        headers.Authorization = `Bearer ${config.llm.local_api_key}`;
      }

      const response = await fetch('/api/llm-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: ttsUrl,
          method: 'POST',
          headers,
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

  const callVolcTTS = async (text: string): Promise<string | null> => {
    if (!config?.llm?.volc_appid || !config?.llm?.volc_token) return null;

    try {
      const res = await fetchWithRetry('/api/volc-tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          appid: config.llm.volc_appid,
          token: config.llm.volc_token,
          cluster: config.llm.volc_tts_cluster || config.llm.volc_cluster || "volcano_tts",
          voice: config.llm.volc_voice || "zh_female_shuangchu_moon_night_f0"
        })
      });
      const data = await res.json();
      return data?.data || null;
    } catch (error) {
      console.error("Volc TTS Error:", error);
      return null;
    }
  };

  // Robust JSON extraction
  // (Moved to top level)

  const handleProcess = async (id: string, demoPerf: string = "", defensePerf: string = "") => {
    if (processingId === id) {
      alert("正在生成中，请勿重复点击。");
      return;
    }
    
    setProcessingId(id);
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
          "voice_comment": "适合语音播报的简洁版点评（60-90秒语速，语言流畅，避免重复，直接进入主题）",
          "scores": { 
            ${Object.keys(config.rules.weights).map(key => `"${key}": 评分`).join(',\n            ')}
          }, 
          "total_score": 总分（各项得分之和）, 
          "score_reason": "打分依据（请结合现场表现和方案内容详细说明各项得分理由）"
        }
      `;

      const text = await callLLM(prompt);
      const result = extractJSON(text);

      // B. Generate TTS (Gemini / Local)
      let audio_comment = "";
      let audio_score = "";
      const commentaryText = config.voice_templates.commentary
        .replace("{team_name}", caseItem.team_name)
        .replace("{case_name}", caseItem.case_name)
        .replace("{content}", result.voice_comment);
      const scoreText = config.voice_templates.score.replace("{total_score}", result.total_score || "");

      try {
        if (config.llm?.tts_provider === 'volcengine') {
          const volcComment = await callVolcTTS(commentaryText);
          if (volcComment) {
            const saveRes = await fetchWithRetry('/api/save-audio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: `comment_${id}.wav`, data: volcComment })
            });
            const saveResult = await saveRes.json();
            audio_comment = saveResult.url;
          }

          if (config.stage === 'final' && result.total_score) {
            const volcScore = await callVolcTTS(scoreText);
            if (volcScore) {
              const saveRes = await fetchWithRetry('/api/save-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: `score_${id}.wav`, data: volcScore })
              });
              const saveResult = await saveRes.json();
              audio_score = saveResult.url;
            }
          }
        } else if (config.llm?.provider === 'gemini') {
          const ai = getGenAI();
          console.log("Generating Gemini TTS for commentary...");
          const commentaryRes = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text: commentaryText }] }],
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
            }
          });

          const commentBase64 = commentaryRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (commentBase64) {
            const wavBase64 = await pcmToWavBase64(commentBase64);
            const saveRes = await fetchWithRetry('/api/save-audio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: `comment_${id}.wav`, data: wavBase64 })
            });
            const saveResult = await saveRes.json();
            audio_comment = saveResult.url;
          }

          if (config.stage === 'final' && result.total_score) {
            console.log("Generating Gemini TTS for score...");
            const scoreRes = await ai.models.generateContent({
              model: "gemini-2.5-flash-preview-tts",
              contents: [{ parts: [{ text: scoreText }] }],
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
              }
            });

            const scoreBase64 = scoreRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (scoreBase64) {
              const wavBase64 = await pcmToWavBase64(scoreBase64);
              const saveRes = await fetchWithRetry('/api/save-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: `score_${id}.wav`, data: wavBase64 })
              });
              const saveResult = await saveRes.json();
              audio_score = saveResult.url;
            }
          }
        } else {
          const localComment = await callLocalTTS(commentaryText);
          if (localComment) {
            const saveRes = await fetchWithRetry('/api/save-audio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: `comment_${id}.wav`, data: localComment })
            });
            const saveResult = await saveRes.json();
            audio_comment = saveResult.url;
          }

          if (config.stage === 'final' && result.total_score) {
            const localScore = await callLocalTTS(scoreText);
            if (localScore) {
              const saveRes = await fetchWithRetry('/api/save-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: `score_${id}.wav`, data: localScore })
              });
              const saveResult = await saveRes.json();
              audio_score = saveResult.url;
            }
          }
        }
      } catch (ttsErr) {
        console.warn("TTS generation failed, will use browser fallback:", ttsErr);
      }

      // Save Results to Server
      console.log("Saving process results to server...", { id, audio_comment, audio_score });
      await fetchWithRetry('/api/save-process-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          result,
          status: 'completed',
          audio_comment: audio_comment || "",
          audio_score: audio_score || ""
        })
      });

      await fetchData();
      
      // Auto play commentary after generation
      playAudio(audio_comment, 'comment', commentaryText);

    } catch (e: any) {
      console.error("Process error", e);
      alert("处理失败: " + e.message);
    } finally {
      setLoading(false);
      setProcessingId(null);
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
        "bg-[#020617] text-white flex flex-col border-r border-white/5 transition-all duration-300 relative flex-shrink-0 z-20",
        isSidebarCollapsed ? "w-20" : "w-64"
      )}>
        <div className={cn("p-8 mb-4 flex items-center", isSidebarCollapsed ? "justify-center" : "justify-between")}>
          {!isSidebarCollapsed && <h1 className="text-2xl font-bold text-white tracking-tighter text-glow">旗评系统</h1>}
          <button 
            onClick={toggleSidebar}
            className="p-2 hover:bg-white/5 rounded-lg transition-colors text-slate-500 hover:text-white"
          >
            {isSidebarCollapsed ? <ChevronRight size={20} /> : <ChevronLeft size={20} />}
          </button>
        </div>

        <nav className="flex-1 space-y-2 px-4">
          <NavItem icon={PlayCircle} label="现场评委席" active={activeTab === 'judge'} onClick={() => setActiveTab('judge')} collapsed={isSidebarCollapsed} />
          <NavItem icon={Users} label="案例接入" active={activeTab === 'cases'} onClick={() => setActiveTab('cases')} collapsed={isSidebarCollapsed} />
          <NavItem icon={Settings} label="赛前配置" active={activeTab === 'config'} onClick={() => setActiveTab('config')} collapsed={isSidebarCollapsed} />
          <NavItem icon={Activity} label="日志追溯" active={activeTab === 'logs'} onClick={() => setActiveTab('logs')} collapsed={isSidebarCollapsed} />
        </nav>
        
        <div className="p-8 border-t border-white/5">
          <div className={cn("flex items-center gap-4", isSidebarCollapsed && "justify-center")}>
            <div className="w-12 h-12 rounded-2xl overflow-hidden border border-white/10 shadow-xl">
              <img 
                src="https://images.unsplash.com/photo-1578632292335-df3abbb0d586?q=80&w=1000&auto=format&fit=crop" 
                alt="Judge Avatar" 
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
            </div>
            {!isSidebarCollapsed && (
              <div>
                <p className="text-sm font-bold text-white">当前评委</p>
                <p className="text-[10px] text-slate-500">智能体大赛专席</p>
              </div>
            )}
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto flex flex-col bg-[#020617] relative bg-mesh">
        {/* Decorative background elements */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          <div className="absolute bottom-0 left-0 w-full h-64 bg-gradient-to-t from-blue-600/10 to-transparent" />
          <div className="absolute -bottom-20 left-0 w-full h-40 opacity-30">
            <div className="w-full h-full animate-wave" style={{ maskImage: 'radial-gradient(ellipse at center, black, transparent 80%)' }} />
          </div>
        </div>

        {/* Header */}
        <header className="px-12 py-8 flex justify-between items-center relative z-10">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3 text-blue-400 text-sm">
              <div className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.8)] animate-pulse" />
              <span className="font-medium tracking-wide">当前阶段：</span>
              <span className="font-bold text-white text-lg">{config?.stage === 'final' ? '决赛(点评+打分)' : '复赛(仅点评)'}</span>
            </div>
          </div>
          <div className="text-right">
            <h2 className="text-2xl font-bold text-white tracking-widest text-glow">研发总院智能体大赛</h2>
          </div>
        </header>

        <div className="flex-1 p-12 relative z-10 flex flex-col">
          <AnimatePresence mode="wait">
            {activeTab === 'judge' && (
              <motion.div
                key="judge"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 flex flex-col"
              >
                {cases.length === 0 ? (
                  <div className="flex-1 flex items-center justify-center">
                    <div className="glass-card rounded-3xl p-20 text-center max-w-md">
                      <Users size={48} className="mx-auto text-blue-500/50 mb-6" />
                      <p className="text-slate-400 text-lg">暂无案例数据，请先在“案例接入”模块录入</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex flex-col">
                    {/* If we have a completed case, show the high-fidelity view for the first one or selected one */}
                    {(() => {
                      const activeCase = cases.find(c => c.id === selectedCaseId) || 
                                       cases.find(c => c.status === 'completed') || 
                                       cases[0];
                      return (
                        <HighFidelityJudgeView 
                          item={activeCase}
                          onProcess={(demo: string, defense: string) => handleProcess(activeCase.id, demo, defense)}
                          loading={loading}
                          config={config}
                          stage={config?.stage}
                          playAudio={playAudio}
                          playing={playing}
                          cases={cases}
                          setActiveTab={setActiveTab}
                          onSelectCase={(id: string) => setSelectedCaseId(id)}
                        />
                      );
                    })()}
                  </div>
                )}
              </motion.div>
            )}

            {activeTab === 'cases' && <CasesTab onUpdate={fetchData} cases={cases} onSelectCase={(id: string) => {
              setSelectedCaseId(id);
              setActiveTab('judge');
            }} />}
            {activeTab === 'config' && <ConfigTab config={config} onUpdate={fetchData} callLLM={callLLM} />}
            {activeTab === 'logs' && <LogsTab config={config} cases={cases} />}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

// --- Sub-components ---

const HighFidelityJudgeView = ({ item, onProcess, loading, config, stage, playAudio, playing, cases, setActiveTab, onSelectCase }: any) => {
  const [demoPerf, setDemoPerf] = useState("");
  const [defensePerf, setDefensePerf] = useState("");
  const [showCaseSelector, setShowCaseSelector] = useState(false);

  const isCompleted = item.status === 'completed' || item.status === 'fallback';

  return (
    <div className="flex-1 flex flex-col relative">
      {/* Case Selector Overlay */}
      <AnimatePresence>
        {showCaseSelector && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 glass-card rounded-3xl p-8 overflow-y-auto"
          >
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-bold text-white">选择案例</h3>
              <button onClick={() => setShowCaseSelector(false)} className="p-2 hover:bg-white/10 rounded-full text-white">
                <ChevronLeft size={24} />
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {cases.map((c: any) => (
                <button 
                  key={c.id}
                  onClick={() => {
                    onSelectCase(c.id);
                    setShowCaseSelector(false);
                  }}
                  className={cn(
                    "p-6 rounded-2xl text-left transition-all border-2",
                    c.id === item.id 
                      ? "bg-blue-600 border-blue-400 text-white shadow-lg shadow-blue-900/40" 
                      : "bg-slate-800/50 border-transparent text-slate-300 hover:bg-slate-700/50 hover:border-white/10"
                  )}
                >
                  <div className="flex justify-between items-start mb-2">
                    <p className="font-bold text-lg">{c.case_name}</p>
                    {c.status === 'completed' && <div className="w-2 h-2 bg-green-500 rounded-full shadow-[0_0_8px_rgba(34,197,94,0.8)]" />}
                  </div>
                  <p className="text-sm opacity-70">{c.team_name}</p>
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Layout */}
      <div className="flex-1 grid grid-cols-12 gap-12 items-center">
        {/* Left: Avatar */}
        <div className="col-span-4 flex flex-col items-center">
          <div className="relative group">
            <div className="absolute -inset-4 bg-blue-500/20 blur-3xl rounded-full opacity-50 group-hover:opacity-100 transition-opacity" />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="relative w-80 h-[480px] rounded-[40px] overflow-hidden border-4 border-white/10 shadow-2xl"
            >
              <img 
                src="https://images.unsplash.com/photo-1578632292335-df3abbb0d586?q=80&w=1000&auto=format&fit=crop" 
                alt="AI Judge" 
                className="w-full h-full object-cover"
                referrerPolicy="no-referrer"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-blue-900/40 to-transparent" />
            </motion.div>
            
            {/* Label */}
            <div className="mt-8 relative">
              <div className="absolute inset-0 bg-blue-400/40 blur-xl rounded-full" />
              <div className="relative px-16 py-4 bg-gradient-to-r from-blue-600/80 to-blue-400/80 backdrop-blur-md rounded-lg shadow-lg overflow-hidden">
                {/* Brush stroke effect simulation */}
                <div className="absolute inset-0 opacity-20 bg-[url('https://www.transparenttextures.com/patterns/carbon-fibre.png')]" />
                <span className="text-white font-bold text-2xl tracking-[0.2em] relative z-10">AI评委</span>
              </div>
            </div>
          </div>
        </div>

        {/* Middle: Info & Scores */}
        <div className="col-span-5 space-y-10">
          {/* Team Info */}
          <div className="flex items-center gap-6">
            <div className="w-16 h-16 bg-blue-600 rounded-2xl flex items-center justify-center text-white font-bold text-2xl shadow-lg shadow-blue-900/40">
              {item.team_name[0] === 'A' ? '电' : item.team_name[0]}
            </div>
            <div>
              <h3 className="text-4xl font-bold text-white mb-2 tracking-tight">{item.case_name}</h3>
              <p className="text-slate-400 text-lg font-medium opacity-80">
                {item.team_name} · 团队ID:{item.id}
              </p>
            </div>
          </div>

          {/* Scores List */}
          <div className="space-y-4">
            {isCompleted && item.result?.scores ? (
              Object.entries(item.result.scores).map(([k, v]: any) => (
                <motion.div 
                  key={k}
                  initial={{ x: -20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  className="glass-card rounded-xl p-4 flex justify-between items-center group hover:bg-white/5 transition-colors"
                >
                  <span className="text-white text-lg font-medium">{k}</span>
                  <span className="text-blue-400 text-2xl font-bold font-mono text-glow">{v}</span>
                </motion.div>
              ))
            ) : (
              <div className="glass-card rounded-2xl p-8 text-center space-y-6">
                <p className="text-slate-400">准备好开始评测了吗？</p>
                <div className="flex gap-4">
                  <input 
                    value={demoPerf}
                    onChange={(e) => setDemoPerf(e.target.value)}
                    placeholder="补充演示细节..."
                    className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  />
                  <input 
                    value={defensePerf}
                    onChange={(e) => setDefensePerf(e.target.value)}
                    placeholder="补充答辩细节..."
                    className="flex-1 px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  />
                </div>
                <button 
                  onClick={() => onProcess(demoPerf, defensePerf)}
                  disabled={loading}
                  className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-900/40 flex items-center justify-center gap-2"
                >
                  {loading ? <Loader2 className="animate-spin" size={20} /> : <PlayCircle size={20} />}
                  开始 AI 智能评测
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Right: Total Score Badge */}
        <div className="col-span-3 flex justify-center">
          {isCompleted ? (
            <motion.div 
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="relative"
            >
              {/* Hexagon Badge */}
              <div className="relative w-64 h-64 flex items-center justify-center">
                {/* Decorative ribbons/glow */}
                <div className="absolute -top-10 left-1/2 -translate-x-1/2 w-48 h-20 bg-blue-500/30 blur-2xl rounded-full" />
                <div className="absolute inset-0 bg-blue-500/10 blur-3xl rounded-full" />
                
                {/* The Hexagon Shape */}
                <div className="absolute inset-0 bg-gradient-to-br from-white/20 to-white/5 backdrop-blur-xl border border-white/30 shadow-2xl" 
                     style={{ clipPath: 'polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)' }} />
                
                <div className="relative z-10 flex flex-col items-center">
                  <span className="text-[120px] font-bold text-blue-500 leading-none tracking-tighter drop-shadow-[0_0_15px_rgba(59,130,246,0.5)]">
                    {item.result?.total_score || 0}
                  </span>
                </div>
              </div>
              
              {/* Playback Buttons */}
              <div className="mt-12 flex flex-col gap-3">
                <button 
                  onClick={() => {
                    const fallbackText = config.voice_templates.commentary
                      .replace("{team_name}", item.team_name)
                      .replace("{case_name}", item.case_name)
                      .replace("{content}", item.result?.voice_comment || "");
                    playAudio(item.audio_comment, 'comment', fallbackText);
                  }}
                  disabled={playing !== null && playing !== 'comment'}
                  className="w-full py-3 glass-card rounded-xl text-white font-bold hover:bg-white/10 transition-all flex items-center justify-center gap-2"
                >
                  {playing === 'comment' ? <Loader2 className="animate-spin" size={18} /> : <Volume2 size={18} />}
                  {playing === 'comment' ? '停止播放' : '播放点评'}
                </button>
                {stage === 'final' && (
                  <button 
                    onClick={() => {
                      const fallbackText = config.voice_templates.score
                        .replace("{total_score}", item.result?.total_score || "0");
                      playAudio(item.audio_score, 'score', fallbackText);
                    }}
                    disabled={playing !== null && playing !== 'score'}
                    className="w-full py-3 glass-card rounded-xl text-white font-bold hover:bg-white/10 transition-all flex items-center justify-center gap-2"
                  >
                    {playing === 'score' ? <Loader2 className="animate-spin" size={18} /> : <Trophy size={18} />}
                    {playing === 'score' ? '停止播放' : '播放报分'}
                  </button>
                )}
                <button 
                  onClick={() => onProcess(demoPerf, defensePerf)}
                  disabled={loading}
                  className="w-full py-3 text-slate-400 text-sm hover:text-white transition-colors disabled:opacity-50"
                >
                  重新评测
                </button>
              </div>
            </motion.div>
          ) : (
            <div className="text-center space-y-4 opacity-30">
              <div className="w-64 h-64 glass-card rounded-[40px] flex items-center justify-center border-dashed border-2">
                <Trophy size={80} className="text-slate-500" />
              </div>
              <p className="text-slate-500 font-medium">评分待生成</p>
            </div>
          )}
        </div>
      </div>

      {/* Bottom: AI Comments */}
      {isCompleted && (
        <motion.div 
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          className="mt-12 space-y-4"
        >
          <div className="flex items-center gap-3">
            <div className="w-1 h-6 bg-blue-500 rounded-full" />
            <h4 className="text-2xl font-bold text-white tracking-wide">AI 评语：</h4>
          </div>
          <div className="glass-card rounded-3xl p-8">
            <p className="text-slate-300 text-xl leading-relaxed font-light">
              {item.result?.pure_comment}
            </p>
          </div>
        </motion.div>
      )}

      {/* Floating Action: Switch Case */}
      <button 
        onClick={() => setShowCaseSelector(true)}
        className="fixed bottom-12 right-12 w-16 h-16 bg-blue-600 text-white rounded-full shadow-2xl flex items-center justify-center hover:scale-110 transition-transform z-40"
      >
        <Menu size={24} />
      </button>
    </div>
  );
};

const CaseCard = ({ item, onProcess, loading, config, stage, callLLM, playAudio, playing }: any) => {
  const [demoPerf, setDemoPerf] = useState("");
  const [defensePerf, setDefensePerf] = useState("");
  
  // Live Perception State
  const [isListening, setIsListening] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startListening = async () => {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      alert("您的浏览器不支持麦克风访问，或者当前处于非安全环境（请使用 localhost 或 HTTPS 访问）。");
      return;
    }

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
    } catch (err: any) {
      console.error("Failed to start listening", err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        alert("麦克风权限被拒绝，请在浏览器地址栏左侧开启权限。");
      } else {
        alert(`无法开启麦克风: ${err.message}`);
      }
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

      const summaryPromptFromText = (transcript: string) => `
        你是一个专业的赛事观察员。请根据以下现场转写内容（包含选手的演示说明和评委的答辩对话），总结选手的现场表现。
        转写内容：
        ${transcript}
        
        请输出JSON格式：
        {
          "demo_summary": "作品演示表现总结（如：演示过程是否流畅，是否有技术故障，操作是否便捷等）",
          "defense_summary": "现场答辩表现总结（如：逻辑是否清晰，回答问题是否准确，反应速度等）"
        }
      `;

      let result: any = null;

      if (config?.llm?.tts_provider === 'volcengine') {
        const asrResponse = await fetch('/api/volc-asr', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audio: base64Audio,
            appid: config?.llm?.volc_appid,
            token: config?.llm?.volc_token,
            cluster: config?.llm?.volc_asr_cluster || "volcano_asr"
          })
        });
        const asrJson = asrResponse.ok ? await asrResponse.json() : null;
        const transcript = asrJson?.text;
        if (transcript) {
          const summarized = await callLLM(summaryPromptFromText(transcript));
          result = extractJSON(summarized || "{}");
        }
      }

      if (!result && config?.llm?.provider === 'gemini') {
        const prompt = `
          你是一个专业的赛事观察员。请根据这段现场录音（包含选手的演示说明和评委的答辩对话），总结选手的现场表现。
          
          请输出JSON格式：
          {
            "demo_summary": "作品演示表现总结（如：演示过程是否流畅，是否有技术故障，操作是否便捷等）",
            "defense_summary": "现场答辩表现总结（如：逻辑是否清晰，回答问题是否准确，反应速度等）"
          }
        `;

        const ai = new GoogleGenAI({ apiKey: (process as any).env.GEMINI_API_KEY || (process as any).env.API_KEY });
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
        result = extractJSON(response.text || "{}");
      }

      if (!result) {
        alert("自动总结失败：请检查火山引擎配置（ASR）或切换到 Gemini 后重试。");
        return;
      }

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
              onClick={() => {
                const fallbackText = config.voice_templates.commentary
                  .replace("{team_name}", item.team_name)
                  .replace("{case_name}", item.case_name)
                  .replace("{content}", item.result?.voice_comment || "");
                playAudio(item.audio_comment, 'comment', fallbackText);
              }}
              disabled={playing !== null && playing !== 'comment'}
              className="flex items-center justify-center gap-2 py-4 bg-[#3B71ED] text-white rounded-xl font-bold hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {playing === 'comment' ? <Loader2 className="animate-spin" size={20} /> : null}
              {playing === 'comment' ? '停止播放点评' : '一键播放点评'}
            </button>
            {stage === 'final' && (
              <button 
                onClick={() => {
                  const fallbackText = config.voice_templates.score
                    .replace("{total_score}", item.result?.total_score || "0");
                  playAudio(item.audio_score, 'score', fallbackText);
                }}
                disabled={playing !== null && playing !== 'score'}
                className="flex items-center justify-center gap-2 py-4 bg-[#EBB04F] text-white rounded-xl font-bold hover:bg-orange-600 transition-colors disabled:opacity-50"
              >
                {playing === 'score' ? <Loader2 className="animate-spin" size={20} /> : null}
                {playing === 'score' ? '停止播放报分' : '一键播放报分'}
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

const CasesTab = ({ onUpdate, cases, onSelectCase }: any) => {
  const [formData, setFormData] = useState({ team_name: '', case_name: '', content: '' });

  const handleSubmit = async (e: any) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/cases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData)
      });
      if (res.ok) {
        const newCase = await res.json();
        setFormData({ team_name: '', case_name: '', content: '' });
        onUpdate();
        onSelectCase(newCase.id);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteCase = async (id: string, caseName: string) => {
    const confirmed = window.confirm(`确定删除案例「${caseName}」吗？此操作不可撤销。`);
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/cases/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `删除失败（${res.status}）`);
      }
      onUpdate();
    } catch (e: any) {
      console.error(e);
      alert(`删除失败: ${e.message || '未知错误'}`);
    }
  };

  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="glass-card rounded-3xl p-8">
        <h3 className="text-2xl font-bold mb-8 flex items-center gap-3 text-white">
          <FileText className="text-blue-500" /> 录入新案例
        </h3>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-400">团队名称</label>
              <input 
                required
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white focus:border-blue-500 outline-none transition-all"
                value={formData.team_name}
                onChange={e => setFormData({ ...formData, team_name: e.target.value })}
                placeholder="如：极客先锋队"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-400">案例名称</label>
              <input 
                required
                className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white focus:border-blue-500 outline-none transition-all"
                value={formData.case_name}
                onChange={e => setFormData({ ...formData, case_name: e.target.value })}
                placeholder="如：智能代码助手"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-slate-400">核心内容 (建议 500-1000 字)</label>
            <textarea 
              required
              rows={6}
              className="w-full px-4 py-3 rounded-xl bg-white/5 border border-white/10 text-white focus:border-blue-500 outline-none transition-all resize-none"
              value={formData.content}
              onChange={e => setFormData({ ...formData, content: e.target.value })}
              placeholder="请输入项目背景、技术架构、创新点及应用价值..."
            />
          </div>
          <button type="submit" className="w-full py-4 bg-blue-600 text-white rounded-xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-900/40">
            确认录入案例
          </button>
        </form>
      </div>

      <div className="glass-card rounded-3xl p-8">
        <h3 className="text-2xl font-bold mb-8 text-white">已录入列表 ({cases.length})</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {cases.map((c: any) => (
            <div key={c.id} className="p-6 rounded-2xl bg-white/5 border border-white/5 flex justify-between items-center hover:bg-white/10 transition-colors group">
              <div>
                <p className="font-bold text-white text-lg">{c.case_name}</p>
                <p className="text-xs text-slate-500 uppercase tracking-widest mt-1">{c.team_name}</p>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-xs font-mono text-slate-600">{c.id}</span>
                <button
                  onClick={() => handleDeleteCase(c.id, c.case_name)}
                  className="px-4 py-2 bg-red-500/15 text-red-300 rounded-lg text-sm font-bold hover:bg-red-600 hover:text-white transition-all opacity-0 group-hover:opacity-100"
                >
                  删除
                </button>
                <button 
                  onClick={() => onSelectCase(c.id)}
                  className="px-4 py-2 bg-blue-600/20 text-blue-400 rounded-lg text-sm font-bold hover:bg-blue-600 hover:text-white transition-all opacity-0 group-hover:opacity-100"
                >
                  进入评测
                </button>
              </div>
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
    provider: 'local',
    local_url: 'http://localhost:11434/v1/chat/completions',
    local_model: 'qwen2.5:7b-instruct',
    local_api_key: '',
    local_tts_model: '',
    tts_provider: 'volcengine',
    volc_appid: '',
    volc_token: '',
    volc_tts_cluster: 'volcano_tts',
    volc_asr_cluster: 'volcano_asr',
    volc_voice: 'zh_female_shuangchu_moon_night_f0',
    ...config.llm 
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setEditingWeights({ ...config.rules.weights });
    setEditingTemplates({ ...config.voice_templates });
    setEditingLLM({ 
      provider: 'local',
      local_url: 'http://localhost:11434/v1/chat/completions',
      local_model: 'qwen2.5:7b-instruct',
      local_api_key: '',
      local_tts_model: '',
      tts_provider: 'volcengine',
      volc_appid: '',
      volc_token: '',
      volc_tts_cluster: 'volcano_tts',
      volc_asr_cluster: 'volcano_asr',
      volc_voice: 'zh_female_shuangchu_moon_night_f0',
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
    <div className="max-w-4xl mx-auto space-y-8 pb-20">
      <div className="glass-card rounded-3xl p-8">
        <h3 className="text-2xl font-bold mb-8 text-white">AI 评分标准提取</h3>
        <div className="space-y-6">
          <p className="text-slate-400">
            你可以直接粘贴一段文字描述（例如：“技术创新占40%，商业价值30%，现场演示20%，文档完整性10%”），AI 将自动解析并构建评分规则。
          </p>
          <textarea 
            value={standardText}
            onChange={(e) => setStandardText(e.target.value)}
            placeholder="在此输入评分标准描述..."
            className="w-full h-40 px-4 py-4 bg-white/5 border border-white/10 rounded-2xl text-white outline-none focus:border-blue-500 transition-all resize-none"
          />
          <div className="flex justify-end">
            <button 
              onClick={handleExtractRules}
              disabled={extracting}
              className={cn(
                "px-8 py-3 rounded-xl font-bold flex items-center gap-3 transition-all shadow-lg",
                extracting ? "bg-white/5 text-slate-500 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700 shadow-blue-900/40"
              )}
            >
              {extracting ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  正在解析...
                </>
              ) : (
                <>
                  <Sparkles className="w-5 h-5" />
                  AI 自动提取规则
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-3xl p-8">
        <h3 className="text-2xl font-bold mb-8 text-white">AI 模型引擎配置</h3>
        <div className="space-y-8">
          <div className="flex gap-2 p-1.5 bg-white/5 rounded-2xl w-fit">
            <button 
              onClick={() => setEditingLLM({ ...editingLLM, provider: 'local' })}
              className={cn(
                "px-8 py-2.5 rounded-xl font-bold transition-all",
                editingLLM.provider === 'local' ? "bg-blue-600 text-white shadow-lg shadow-blue-900/40" : "text-slate-400 hover:text-white"
              )}
            >
              本地大模型（推荐）
            </button>
            <button 
              onClick={() => setEditingLLM({ ...editingLLM, provider: 'gemini' })}
              className={cn(
                "px-8 py-2.5 rounded-xl font-bold transition-all",
                editingLLM.provider === 'gemini' ? "bg-blue-600 text-white shadow-lg shadow-blue-900/40" : "text-slate-400 hover:text-white"
              )}
            >
              Gemini (可选)
            </button>
          </div>

          {editingLLM.provider === 'local' ? (
            <div className="grid grid-cols-2 gap-8 p-8 bg-white/5 rounded-3xl border border-white/5">
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-400">API 地址</label>
                <input 
                  type="text"
                  value={editingLLM.local_url}
                  onChange={e => setEditingLLM({ ...editingLLM, local_url: e.target.value })}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  placeholder="http://localhost:11434/v1/chat/completions"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-400">模型名称</label>
                <input 
                  type="text"
                  value={editingLLM.local_model}
                  onChange={e => setEditingLLM({ ...editingLLM, local_model: e.target.value })}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  placeholder="llama3 / qwen2"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-400">API Key (可选)</label>
                <input 
                  type="password"
                  value={editingLLM.local_api_key}
                  onChange={e => setEditingLLM({ ...editingLLM, local_api_key: e.target.value })}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  placeholder="如果本地服务需要鉴权请填写"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-400">TTS 模型名称 (可选)</label>
                <input 
                  type="text"
                  value={editingLLM.local_tts_model || ""}
                  onChange={e => setEditingLLM({ ...editingLLM, local_tts_model: e.target.value })}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  placeholder="例如: qwen-tts / cosyvoice"
                />
              </div>
            </div>
          ) : (
            <div className="p-8 bg-blue-500/10 rounded-3xl border border-blue-500/20">
              <p className="text-blue-400 font-medium">当前正在使用 Google Gemini 引擎。若处于公司内网不可访问外网环境，建议切换到“本地大模型（推荐）”。</p>
            </div>
          )}

          <div className="p-8 bg-white/5 rounded-3xl border border-white/5 space-y-6">
            <div className="flex items-center justify-between">
              <h4 className="text-xl font-bold text-white">语音服务配置（火山引擎）</h4>
              <button
                onClick={() => setEditingLLM({ ...editingLLM, tts_provider: editingLLM.tts_provider === 'volcengine' ? 'local' : 'volcengine' })}
                className={cn(
                  "px-4 py-2 rounded-lg text-sm font-bold transition-all",
                  editingLLM.tts_provider === 'volcengine' ? "bg-blue-600 text-white" : "bg-white/10 text-slate-300"
                )}
              >
                {editingLLM.tts_provider === 'volcengine' ? '已启用火山语音' : '使用本地语音'}
              </button>
            </div>

            <div className="grid grid-cols-2 gap-8">
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-400">Volc AppID</label>
                <input
                  type="text"
                  value={editingLLM.volc_appid || ""}
                  onChange={e => setEditingLLM({ ...editingLLM, volc_appid: e.target.value })}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  placeholder="火山引擎 AppID"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-400">Volc Token</label>
                <input
                  type="password"
                  value={editingLLM.volc_token || ""}
                  onChange={e => setEditingLLM({ ...editingLLM, volc_token: e.target.value })}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  placeholder="火山引擎 Access Token"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-400">TTS Cluster</label>
                <input
                  type="text"
                  value={editingLLM.volc_tts_cluster || "volcano_tts"}
                  onChange={e => setEditingLLM({ ...editingLLM, volc_tts_cluster: e.target.value })}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  placeholder="volcano_tts"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-bold text-slate-400">ASR Cluster</label>
                <input
                  type="text"
                  value={editingLLM.volc_asr_cluster || "volcano_asr"}
                  onChange={e => setEditingLLM({ ...editingLLM, volc_asr_cluster: e.target.value })}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  placeholder="volcano_asr"
                />
              </div>
              <div className="space-y-2 col-span-2">
                <label className="text-sm font-bold text-slate-400">发音人 Voice</label>
                <input
                  type="text"
                  value={editingLLM.volc_voice || ""}
                  onChange={e => setEditingLLM({ ...editingLLM, volc_voice: e.target.value })}
                  className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-white outline-none focus:border-blue-500"
                  placeholder="zh_female_shuangchu_moon_night_f0"
                />
              </div>
            </div>
          </div>
          
          <div className="flex justify-end">
            <button 
              onClick={handleSaveConfig}
              disabled={saving}
              className="px-12 py-4 bg-white text-slate-900 rounded-2xl font-bold hover:bg-slate-200 disabled:opacity-50 transition-all shadow-xl"
            >
              {saving ? '正在保存...' : '保存模型配置'}
            </button>
          </div>
        </div>
      </div>

      <div className="glass-card rounded-3xl p-8">
        <h3 className="text-2xl font-bold mb-8 text-white">赛事阶段切换</h3>
        <div className="flex items-center justify-between p-8 bg-white/5 rounded-3xl border border-white/5">
          <div>
            <p className="text-2xl font-bold text-white mb-2">
              当前模式：{config.stage === 'final' ? '决赛 (点评+打分)' : '复赛 (仅点评)'}
            </p>
            <p className="text-slate-400">切换模式将自动调整 AI 评委的输出逻辑与打分权重</p>
          </div>
          <button 
            onClick={handleToggleStage}
            className="px-10 py-4 bg-blue-600 text-white rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-900/40"
          >
            切换到 {config.stage === 'final' ? '复赛' : '决赛'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-8">
        <div className="glass-card rounded-3xl p-8">
          <div className="flex justify-between items-center mb-8">
            <h3 className="text-2xl font-bold text-white">打分权重配置</h3>
            <button 
              onClick={handleSaveConfig}
              disabled={saving}
              className="px-6 py-2 bg-white/10 text-white rounded-xl hover:bg-white/20 disabled:opacity-50 transition-all"
            >
              {saving ? '保存中...' : '保存权重'}
            </button>
          </div>
          <div className="space-y-8">
            {Object.entries(editingWeights).map(([key, val]: any) => (
              <div key={key} className="space-y-4">
                <div className="flex justify-between items-center">
                  <label className="text-lg font-medium text-slate-300">{key}</label>
                  <span className="text-xl font-bold text-blue-400">{(val * 100).toFixed(0)}%</span>
                </div>
                <input 
                  type="range"
                  min="0"
                  max="1"
                  step="0.05"
                  value={val}
                  onChange={(e) => setEditingWeights({ ...editingWeights, [key]: parseFloat(e.target.value) })}
                  className="w-full h-2 bg-white/10 rounded-lg appearance-none cursor-pointer accent-blue-500"
                />
              </div>
            ))}
            <div className="pt-6 border-t border-white/10">
              <div className="flex justify-between items-center">
                <span className="text-slate-400">权重总和</span>
                <span className={cn(
                  "text-2xl font-bold",
                  Math.abs((Object.values(editingWeights).reduce((a: any, b: any) => a + b, 0) as number) - 1) < 0.01 ? "text-blue-400" : "text-rose-500"
                )}>
                  {((Object.values(editingWeights).reduce((a: any, b: any) => a + b, 0) as number) * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="glass-card rounded-3xl p-8">
          <div className="flex justify-between items-center mb-8">
            <h3 className="text-2xl font-bold text-white">语音播报模板</h3>
            <button 
              onClick={handleSaveConfig}
              disabled={saving}
              className="px-6 py-2 bg-white/10 text-white rounded-xl hover:bg-white/20 disabled:opacity-50 transition-all"
            >
              {saving ? '保存中...' : '保存模板'}
            </button>
          </div>
          <div className="space-y-8">
            <div className="space-y-3">
              <label className="text-lg font-medium text-slate-300">点评语音模板</label>
              <textarea 
                value={editingTemplates.commentary}
                onChange={(e) => setEditingTemplates({ ...editingTemplates, commentary: e.target.value })}
                rows={5}
                className="w-full px-4 py-4 bg-white/5 border border-white/10 rounded-2xl text-white outline-none focus:border-blue-500 transition-all resize-none"
                placeholder="可用变量: {team_name}, {case_name}, {content}"
              />
            </div>
            <div className="space-y-3">
              <label className="text-lg font-medium text-slate-300">报分语音模板</label>
              <textarea 
                value={editingTemplates.score}
                onChange={(e) => setEditingTemplates({ ...editingTemplates, score: e.target.value })}
                rows={3}
                className="w-full px-4 py-4 bg-white/5 border border-white/10 rounded-2xl text-white outline-none focus:border-blue-500 transition-all resize-none"
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
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="glass-card rounded-3xl overflow-hidden">
        <div className="p-8 border-b border-white/10 flex justify-between items-center">
          <h3 className="text-2xl font-bold text-white">操作日志追溯</h3>
          <div className="flex gap-4">
            <button 
              onClick={handleDownloadData}
              className="px-6 py-2.5 bg-white text-slate-900 rounded-xl font-bold hover:bg-slate-200 flex items-center gap-2 transition-all"
            >
              <FileText size={18} />
              导出全量数据
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-white/5 text-slate-400 text-xs uppercase tracking-widest font-bold">
              <tr>
                <th className="px-8 py-5">时间戳</th>
                <th className="px-8 py-5">操作类型</th>
                <th className="px-8 py-5">案例 ID</th>
                <th className="px-8 py-5">状态</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {logs.map((log: any, i) => (
                <tr key={i} className="hover:bg-white/5 transition-colors">
                  <td className="px-8 py-5 text-sm text-slate-400">{new Date(log.timestamp).toLocaleString()}</td>
                  <td className="px-8 py-5 text-sm font-bold text-white">{log.action}</td>
                  <td className="px-8 py-5 text-sm font-mono text-slate-500">{log.case_id}</td>
                  <td className="px-8 py-5">
                    <span className="px-3 py-1 bg-blue-500/20 text-blue-400 rounded-full text-[10px] font-bold uppercase tracking-wider">
                      {log.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
