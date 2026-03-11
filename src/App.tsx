import React, { useState, useEffect } from 'react';
import { Settings, Users, PlayCircle, FileText, Activity, ShieldAlert, CheckCircle2, Loader2, Volume2, Trophy, RefreshCw } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI, Modality } from "@google/genai";

// --- Utilities ---

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * 为 Gemini TTS 返回的原始 PCM 数据添加 WAV 文件头
 * Gemini TTS 默认输出: 24000Hz, 16-bit, Mono PCM
 */
async function addWavHeaderAndGetBase64(base64Data: string, sampleRate: number = 24000): Promise<string> {
  const binaryString = window.atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const wavHeader = new ArrayBuffer(44);
  const view = new DataView(wavHeader);

  // RIFF identifier "RIFF"
  view.setUint32(0, 0x52494646, false);
  // file length (36 + data_len)
  view.setUint32(4, 36 + len, true);
  // WAVE identifier "WAVE"
  view.setUint32(8, 0x57415645, false);
  // fmt chunk identifier "fmt "
  view.setUint32(12, 0x666d7420, false);
  // format chunk length
  view.setUint32(16, 16, true);
  // sample format (1 is PCM)
  view.setUint16(20, 1, true);
  // channel count (1 is Mono)
  view.setUint16(22, 1, true);
  // sample rate
  view.setUint32(24, sampleRate, true);
  // byte rate (sampleRate * blockAlign)
  view.setUint32(28, sampleRate * 2, true);
  // block align (channels * bits/8)
  view.setUint16(32, 2, true);
  // bits per sample
  view.setUint16(34, 16, true);
  // data chunk identifier "data"
  view.setUint32(36, 0x64617461, false);
  // data chunk length
  view.setUint32(40, len, true);

  const combined = new Uint8Array(44 + len);
  combined.set(new Uint8Array(wavHeader), 0);
  combined.set(bytes, 44);

  // Use Blob and FileReader for robust base64 conversion
  const blob = new Blob([combined], { type: 'audio/wav' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
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

  const fetchData = async () => {
    try {
      const [configRes, casesRes] = await Promise.all([
        fetch('/api/config'),
        fetch('/api/cases')
      ]);
      setConfig(await configRes.json());
      setCases(await casesRes.json());
    } catch (e) {
      console.error("Fetch error", e);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleProcess = async (id: string) => {
    setLoading(true);
    try {
      const caseItem = cases.find(c => c.id === id);
      if (!caseItem) throw new Error("Case not found");

      // A. Generate Commentary & Scores (Using Backend Proxy for Local/Qwen support)
      const prompt = `
        你是一位专业评委，正在参加「研发总院智能体大赛」。
        当前赛事阶段：${config.stage === 'final' ? '决赛' : '复赛'}。
        
        案例信息：
        团队名称：${caseItem.team_name}
        案例名称：${caseItem.case_name}
        核心内容：${caseItem.content}
        
        点评规则：${config.rules.commentary_structure}，字数${config.rules.commentary_length}。
        ${config.stage === 'final' ? `打分维度权重：${JSON.stringify(config.rules.weights)}。请为每个维度打分（0-10分）。` : ''}
        
        请输出JSON格式：
        {
          "pure_comment": "结构化文字点评",
          "voice_comment": "适合语音播报的简洁版点评（60-90秒语速）",
          ${config.stage === 'final' ? `"scores": { "technical_innovation": 8.5, "business_value": 8.0, "technical_difficulty": 8.2, "presentation": 9.0 }, "total_score": 8.5, "score_reason": "打分依据"` : ''}
        }
      `;

      const llmRes = await fetch('/api/llm-process', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt })
      });
      
      if (!llmRes.ok) throw new Error("LLM Processing failed");
      const llmResult = await llmRes.json();
      let text = llmResult.text || "{}";
      
      // Clean Markdown
      text = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const result = JSON.parse(text);

      // B. Generate TTS (Optional/Best effort for local deployment)
      let audio_comment = "";
      let audio_score = "";
      
      // Only attempt Gemini TTS if an API key is present (implies internet/cloud)
      if (process.env.GEMINI_API_KEY) {
        try {
          const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
          const ttsModel = "gemini-2.5-flash-preview-tts";
          
          // Commentary Audio
          const commentaryText = config.voice_templates.commentary
            .replace("{team_name}", caseItem.team_name)
            .replace("{case_name}", caseItem.case_name)
            .replace("{content}", result.voice_comment);

          const commentaryAudioResponse = await ai.models.generateContent({
            model: ttsModel,
            contents: [{ parts: [{ text: `请用中性专业女声播报：${commentaryText}` }] }],
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
            }
          });

          const commentaryBase64Raw = commentaryAudioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (commentaryBase64Raw) {
            const commentaryBase64 = await addWavHeaderAndGetBase64(commentaryBase64Raw);
            const res = await fetch('/api/save-audio', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ filename: `${id}_comment.wav`, data: commentaryBase64 })
            });
            const data = await res.json();
            audio_comment = data.url;
          }

          // Score Audio (Final only)
          if (config.stage === 'final' && result.total_score) {
            const scoreText = config.voice_templates.score.replace("{total_score}", result.total_score);
            const scoreAudioResponse = await ai.models.generateContent({
              model: ttsModel,
              contents: [{ parts: [{ text: `请用中性专业女声播报：${scoreText}` }] }],
              config: {
                responseModalities: [Modality.AUDIO],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
              }
            });
            const scoreBase64Raw = scoreAudioResponse.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
            if (scoreBase64Raw) {
              const scoreBase64 = await addWavHeaderAndGetBase64(scoreBase64Raw);
              const res = await fetch('/api/save-audio', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: `${id}_score.wav`, data: scoreBase64 })
              });
              const data = await res.json();
              audio_score = data.url;
            }
          }
        } catch (ttsError) {
          console.warn("TTS Generation failed (likely offline):", ttsError);
          // Continue without audio
        }
      }

      // Save Results to Server
      await fetch('/api/save-process-result', {
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

  return (
    <div className="h-screen bg-slate-50 flex font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col shadow-sm">
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
                      onProcess={() => handleProcess(item.id)} 
                      loading={loading}
                      stage={config?.stage}
                    />
                  ))
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'cases' && <CasesTab onUpdate={fetchData} cases={cases} />}
          {activeTab === 'config' && <ConfigTab config={config} onUpdate={fetchData} />}
          {activeTab === 'logs' && <LogsTab />}
        </AnimatePresence>
      </main>
    </div>
  );
}

// --- Sub-components ---

const CaseCard = ({ item, onProcess, loading, stage }: any) => {
  const [playing, setPlaying] = useState<string | null>(null);

  const playAudio = (url: string, type: string) => {
    if (!url) {
      alert("暂无语音文件，请先点击“开始 AI 智能评测”生成。");
      return;
    }
    // 添加时间戳防止浏览器缓存旧的错误文件
    const audio = new Audio(`${url}?t=${Date.now()}`);
    setPlaying(type);
    audio.load();
    audio.play().catch(e => {
      console.error("Audio play error", e);
      setPlaying(null);
      alert("语音播放失败。请确保您已点击“重新尝试评测”以生成正确的 WAV 格式文件。");
    });
    audio.onended = () => setPlaying(null);
    audio.onerror = () => {
      setPlaying(null);
      alert("语音资源加载失败，请检查网络或重新生成。");
    };
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
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">AI 评语摘要</span>
                {stage === 'final' && (
                  <div className="text-2xl font-black text-emerald-600">{item.result?.total_score} <span className="text-sm font-normal text-slate-400">分</span></div>
                )}
              </div>
              <p className="text-sm text-slate-700 leading-relaxed">{item.result?.pure_comment}</p>
            </div>

            {(item.status === 'fallback' || item.status === 'completed') && (
              <button 
                onClick={onProcess}
                disabled={loading}
                className="w-full py-3 border-2 border-dashed border-slate-200 text-slate-400 rounded-xl font-bold hover:border-emerald-500 hover:text-emerald-500 transition-all flex items-center justify-center gap-2"
              >
                {loading ? <Loader2 className="animate-spin" size={20} /> : <RefreshCw size={18} />}
                {item.status === 'completed' ? '重新生成 AI 评语' : '重新尝试 AI 智能评测'}
              </button>
            )}
          </div>
        ) : (
          <button 
            onClick={onProcess}
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

const ConfigTab = ({ config, onUpdate }: any) => {
  if (!config) return null;

  const handleToggleStage = async () => {
    const newStage = config.stage === 'semi-final' ? 'final' : 'semi-final';
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...config, stage: newStage })
    });
    onUpdate();
  };

  const handleUpdateAISettings = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const ai_settings = {
      provider: formData.get('provider'),
      api_key: formData.get('api_key'),
      base_url: formData.get('base_url'),
      model: formData.get('model'),
    };
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...config, ai_settings })
    });
    alert('AI 配置已更新');
    onUpdate();
  };

  const aiSettings = config.ai_settings || {
    provider: 'openai',
    api_key: '',
    base_url: 'http://localhost:11434/v1',
    model: 'qwen-plus'
  };

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
        <h3 className="text-xl font-bold mb-6">AI 模型配置 (本地部署/Qwen)</h3>
        <form onSubmit={handleUpdateAISettings} className="space-y-6">
          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-700">接口类型</label>
              <select 
                name="provider" 
                defaultValue={aiSettings.provider}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none"
              >
                <option value="openai">OpenAI 兼容接口 (Qwen/Ollama/Local)</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-700">模型名称 (Model)</label>
              <input 
                name="model" 
                defaultValue={aiSettings.model}
                placeholder="如: qwen-plus 或 ollama-model"
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none"
              />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-slate-700">API 代理地址 (Base URL)</label>
            <input 
              name="base_url" 
              defaultValue={aiSettings.base_url}
              placeholder="http://localhost:11434/v1"
              className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-bold text-slate-700">API Key</label>
            <input 
              name="api_key" 
              type="password"
              defaultValue={aiSettings.api_key}
              placeholder="本地 Ollama 通常不需要 Key"
              className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none"
            />
          </div>
          <div className="flex justify-end">
            <button type="submit" className="px-6 py-2 bg-slate-900 text-white rounded-xl font-bold hover:bg-slate-800 transition-colors">
              保存 AI 配置
            </button>
          </div>
        </form>
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
          <h3 className="text-lg font-bold mb-4">打分权重 (决赛)</h3>
          <div className="space-y-4">
            {Object.entries(config.rules.weights).map(([key, val]: any) => (
              <div key={key} className="flex justify-between items-center">
                <span className="text-sm text-slate-600 capitalize">{key.replace('_', ' ')}</span>
                <span className="font-bold text-slate-900">{val * 100}%</span>
              </div>
            ))}
          </div>
        </div>
        <div className="bg-white rounded-2xl p-8 shadow-sm border border-slate-200">
          <h3 className="text-lg font-bold mb-4">语音模板</h3>
          <div className="space-y-4">
            <div className="p-3 bg-slate-50 rounded-lg text-xs font-mono text-slate-500">
              {config.voice_templates.commentary.substring(0, 60)}...
            </div>
            <div className="p-3 bg-slate-50 rounded-lg text-xs font-mono text-slate-500">
              {config.voice_templates.score}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const LogsTab = () => {
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    fetch('/api/logs').then(res => res.json()).then(setLogs);
  }, []);

  return (
    <div className="max-w-5xl mx-auto">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-6 border-b border-slate-100 flex justify-between items-center">
          <h3 className="text-xl font-bold">操作日志追溯</h3>
          <button className="text-sm text-emerald-600 font-bold hover:underline">导出为 Excel</button>
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
