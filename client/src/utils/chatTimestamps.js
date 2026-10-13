/**
 * Video timestamps in chat messages: "12:34", "1:02:03", "0:45".
 * Clock times ("9:30 pm", "10:15am") are left as text.
 */
const TIMESTAMP = /(?<![\d:.])(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)(?![\d:.])(?!\s?[ap]\.?m\b)/gi;

/** [{ text } | { text, seconds }] pieces of `text`, in order. */
export function splitTimestamps(text) {
  const parts = [];
  let last = 0;
  for (const m of String(text).matchAll(TIMESTAMP)) {
    const [whole, h, mm, ss] = m;
    const minutes = Number(mm);
    if (h !== undefined && minutes > 59) continue;
    const seconds = (h ? Number(h) * 3600 : 0) + minutes * 60 + Number(ss);
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: whole, seconds });
    last = m.index + whole.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
