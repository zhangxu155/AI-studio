import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const extractJSON = (text: string) => {
  try {
    return JSON.parse(text);
  } catch (e) {
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

export async function pcmToWavBase64(pcmBase64: string, sampleRate: number = 24000): Promise<string> {
  try {
    if (!pcmBase64) throw new Error("PCM data is empty");

    const cleanedBase64 = pcmBase64.replace(/\s/g, '');
    const binaryString = atob(cleanedBase64);
    const len = binaryString.length;
    console.log(`[PCM2WAV] Input length: ${len} bytes, SampleRate: ${sampleRate}Hz`);

    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const buffer = new ArrayBuffer(44 + len);
    const view = new DataView(buffer);

    view.setUint32(0, 0x52494646, false);
    view.setUint32(4, 36 + len, true);
    view.setUint32(8, 0x57415645, false);
    view.setUint32(12, 0x666d7420, false);
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    view.setUint32(36, 0x64617461, false);
    view.setUint32(40, len, true);

    const uint8View = new Uint8Array(buffer);
    uint8View.set(bytes, 44);

    const blob = new Blob([buffer], { type: 'audio/wav' });
    console.log(`[PCM2WAV] Created WAV blob: ${blob.size} bytes`);

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
    console.error("[PCM2WAV] Error:", e);
    throw e;
  }
}
