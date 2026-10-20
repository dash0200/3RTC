/**
 * Video timestamps in chat messages: "12:34", "1:02:03", "0:45".
 * Clock times ("9:30 pm", "10:15am") are left as text.
 */
const TIMESTAMP = /(?<![\d:.])(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)(?![\d:.])(?!\s?[ap]\.?m\b)/gi;

export interface ChatTimestampTextPart {
  text: string;
  seconds?: never;
}

export interface ChatTimestampLinkPart {
  text: string;
  seconds: number;
}

export type ChatTimestampPart = ChatTimestampTextPart | ChatTimestampLinkPart;

/** [{ text } | { text, seconds }] pieces of `text`, in order. */
export function splitTimestamps(text: string | null | undefined): ChatTimestampPart[] {
  const parts: ChatTimestampPart[] = [];
  const s = String(text ?? '');
  let last = 0;
  for (const m of s.matchAll(TIMESTAMP)) {
    const [whole, h, mm, ss] = m;
    const minutes = Number(mm);
    if (h !== undefined && minutes > 59) continue;
    const seconds = (h ? Number(h) * 3600 : 0) + minutes * 60 + Number(ss);
    if (m.index! > last) parts.push({ text: s.slice(last, m.index) });
    parts.push({ text: whole, seconds });
    last = m.index! + whole.length;
  }
  if (last < s.length) parts.push({ text: s.slice(last) });
  return parts;
}
