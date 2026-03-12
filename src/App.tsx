import React, { useState, useEffect } from 'react';
import { Settings, Users, PlayCircle, FileText, Activity, ShieldAlert, CheckCircle2, Loader2, Volume2, Trophy, RefreshCw, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI, Modality } from "@google/genai";

// --- Utilities ---

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
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

  const getGenAI = () => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not configured.");
    }
    return new GoogleGenAI({ apiKey });
  };

  const callLLM = async (prompt: string) => {
    try {
      const ai = getGenAI();
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: prompt + "\n\n请直接输出 JSON 字符串，不要包含任何 Markdown 代码块格式。" }] }],
      });
      
      if (response.text) {
        // Remove potential markdown formatting if the model still includes it
        const cleanedText = response.text.replace(/```json/g, "").replace(/```/g, "").trim();
        return cleanedText;
      }
      throw new Error("模型返回内容为空");
    } catch (error: any) {
      console.error("Gemini API Error:", error);
      throw new Error(`AI 服务调用失败: ${error.message || '未知错误'}`);
    }
  };

  const handleProcess = async (id: string, demoPerf: string = "", defensePerf: string = "") => {
    setLoading(true);
    try {
      const caseItem = cases.find(c => c.id === id);
      if (!caseItem) throw new Error("Case not found");

      // A. Generate Commentary & Scores
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
        
        点评规则：${config.rules.commentary_structure}，字数${config.rules.commentary_length}。
        
        评分标准（严格遵守）：
        1. 作品演示 (满分35分):
           - 35-26: 功能演示符合预期，运行稳定，无明显bug，操作便捷。
           - 25-16: 演示符合预期，解决业务痛点，数据支撑充分。
           - 15-6: 部分实现，基本稳定，少量bug，效果一般。
           - 5-0: 未实现或不稳定，bug较多，无法正常演示。
        2. 技术深度与合理性 (满分25分):
           - 25-21: 架构合理，算法选型科学，过程规范，数据严谨，符合汽车研发安全合规。
           - 20-16: 架构基本合理，算法适配需求，过程规范，基本合规。
           - 15-11: 架构少量不合理，算法基本适配，数据处理不够严谨。
           - 10-0: 架构混乱，选型不合理，不合规，有技术风险。
        3. 业务落地价值 (满分20分):
           - 20-16: 直接应用于汽车研发，显著提升效率/降本，解决长期痛点，高推广价值。
           - 15-11: 应用于部分场景，有一定提升和推广潜力。
           - 10-6: 结合不紧密，落地价值有限。
           - 5-0: 无实际落地价值。
        4. 现场答辩 (满分20分):
           - 20-16: 逻辑清晰，表达流畅，准确阐述亮点/价值，回答准确全面，反应迅速。
           - 15-11: 逻辑基本清晰，表达较流畅，能阐述核心，回答基本准确。
           - 10-6: 逻辑/表达欠佳，阐述不完整，回答不够准确。
           - 5-0: 混乱，无法阐述核心或回答基本提问。

        请输出JSON格式：
        {
          "pure_comment": "结构化文字点评",
          "voice_comment": "适合语音播报的简洁版点评（60-90秒语速）",
          "scores": { 
            "work_demonstration": 评分, 
            "technical_depth": 评分, 
            "business_value": 评分, 
            "defense_performance": 评分 
          }, 
          "total_score": 总分, 
          "score_reason": "打分依据（请结合现场表现和方案内容详细说明）"
        }
      `;

      const text = await callLLM(prompt);
      
      // Clean Markdown
      const cleanedText = text.replace(/```json/g, "").replace(/```/g, "").trim();
      const result = JSON.parse(cleanedText);

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
          audio_comment = `data:audio/wav;base64,${commentBase64}`;
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
            audio_score = `data:audio/wav;base64,${scoreBase64}`;
          }
        }
      } catch (ttsError) {
        console.warn("TTS Generation failed:", ttsError);
        // Continue without audio
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
          {activeTab === 'config' && <ConfigTab config={config} onUpdate={fetchData} callLLM={callLLM} />}
          {activeTab === 'logs' && <LogsTab />}
        </AnimatePresence>
      </main>
    </div>
  );
}

// --- Sub-components ---

const CaseCard = ({ item, onProcess, loading, stage }: any) => {
  const [playing, setPlaying] = useState<string | null>(null);
  const [demoPerf, setDemoPerf] = useState("");
  const [defensePerf, setDefensePerf] = useState("");

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

        {/* External Information Inputs */}
        {item.status !== 'completed' && item.status !== 'fallback' && (
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1">
                <Sparkles size={12} className="text-emerald-500" /> 作品演示表现
              </label>
              <textarea 
                value={demoPerf}
                onChange={(e) => setDemoPerf(e.target.value)}
                placeholder="如：演示流畅，无BUG，操作便捷..."
                className="w-full h-24 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-emerald-500 outline-none resize-none text-sm"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-1">
                <Sparkles size={12} className="text-indigo-500" /> 现场答辩表现
              </label>
              <textarea 
                value={defensePerf}
                onChange={(e) => setDefensePerf(e.target.value)}
                placeholder="如：逻辑清晰，回答准确，反应迅速..."
                className="w-full h-24 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none resize-none text-sm"
              />
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
        3. 维度 key 请使用英文小写和下划线（如：technical_innovation）。
        
        输出格式：
        {
          "weights": {
            "维度key": 0.3,
            "维度key2": 0.7
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
