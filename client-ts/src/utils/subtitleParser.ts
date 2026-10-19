/**
 * Subtitle Parser (.SRT / .VTT) for Local Video Player
 * Supports SubRip (.srt) and WebVTT (.vtt) file formats.
 * Real-time parsing, timestamp normalization, cue matching, and WebVTT conversion.
 */

export interface SubtitleCue {
  id?: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface SubtitleTrackData {
  fileName: string;
  cues: SubtitleCue[];
  vttUrl: string | null;
  vttString: string;
  rawText: string;
}

// Helper to convert timestamp string "00:01:23,456" or "01:23.456" to seconds
export function timeStringToSeconds(timeStr: string | null | undefined): number {
  if (!timeStr) return 0;
  const normalized = timeStr.trim().replace(',', '.');
  const parts = normalized.split(':');

  if (parts.length === 3) {
    const hours = parseFloat(parts[0]) || 0;
    const minutes = parseFloat(parts[1]) || 0;
    const seconds = parseFloat(parts[2]) || 0;
    return hours * 3600 + minutes * 60 + seconds;
  } else if (parts.length === 2) {
    const minutes = parseFloat(parts[0]) || 0;
    const seconds = parseFloat(parts[1]) || 0;
    return minutes * 60 + seconds;
  }
  return parseFloat(normalized) || 0;
}

// Format seconds into WebVTT timestamp "HH:MM:SS.mmm"
export function secondsToVttTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) seconds = 0;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = (seconds % 60).toFixed(3);
  return `${hrs.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.padStart(6, '0')}`;
}

/**
 * Parses raw SRT text into array of cue objects:
 * [ { id, startSec, endSec, text }, ... ]
 */
export function parseSrt(srtContent: string | null | undefined): SubtitleCue[] {
  if (!srtContent) return [];
  // Strip BOM and normalize line breaks
  const cleaned = srtContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const blocks = cleaned.split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];

  const timeRegex = /((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{2,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{2,3})/;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;
    const lines = block.split('\n');

    let timeLineIdx = -1;
    for (let j = 0; j < lines.length; j++) {
      if (timeRegex.test(lines[j])) {
        timeLineIdx = j;
        break;
      }
    }

    if (timeLineIdx === -1) continue;

    const timeMatch = lines[timeLineIdx].match(timeRegex);
    if (!timeMatch) continue;

    const startSec = timeStringToSeconds(timeMatch[1]);
    const endSec = timeStringToSeconds(timeMatch[2]);
    const textLines = lines.slice(timeLineIdx + 1).map((l) => l.trim()).filter(Boolean);
    const text = textLines.join('\n');

    if (text) {
      cues.push({
        id: i + 1,
        startSec,
        endSec,
        text
      });
    }
  }

  return cues;
}

/**
 * Parses raw WebVTT text into array of cue objects.
 */
export function parseVtt(vttContent: string | null | undefined): SubtitleCue[] {
  if (!vttContent) return [];
  const cleaned = vttContent.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const blocks = cleaned.split(/\n\s*\n/);
  const cues: SubtitleCue[] = [];

  const timeRegex = /((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{2,3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[,.]\d{2,3})/;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block || block.startsWith('WEBVTT') || block.startsWith('NOTE') || block.startsWith('STYLE')) {
      continue;
    }

    const lines = block.split('\n');
    let timeLineIdx = -1;
    for (let j = 0; j < lines.length; j++) {
      if (timeRegex.test(lines[j])) {
        timeLineIdx = j;
        break;
      }
    }

    if (timeLineIdx === -1) continue;

    const timeMatch = lines[timeLineIdx].match(timeRegex);
    if (!timeMatch) continue;

    const startSec = timeStringToSeconds(timeMatch[1]);
    const endSec = timeStringToSeconds(timeMatch[2]);
    const textLines = lines.slice(timeLineIdx + 1).map((l) => l.trim()).filter(Boolean);
    const text = textLines.join('\n');

    if (text) {
      cues.push({
        id: i + 1,
        startSec,
        endSec,
        text
      });
    }
  }

  return cues;
}

/**
 * Converts array of cue objects to a standard WebVTT string
 */
export function cuesToWebVTT(cues: SubtitleCue[], delaySec = 0): string {
  let vtt = 'WEBVTT\n\n';
  cues.forEach((cue, idx) => {
    const start = Math.max(0, cue.startSec + delaySec);
    const end = Math.max(start + 0.05, cue.endSec + delaySec);
    vtt += `${idx + 1}\n`;
    vtt += `${secondsToVttTimestamp(start)} --> ${secondsToVttTimestamp(end)}\n`;
    vtt += `${cue.text}\n\n`;
  });
  return vtt;
}

/**
 * Synchronously or asynchronously parse subtitle text content into track object
 */
export function parseSubtitleString(text: string | null | undefined, fileName = 'subtitles.vtt'): SubtitleTrackData {
  if (!text) {
    return { fileName, cues: [], vttUrl: null, vttString: '', rawText: '' };
  }
  const name = (fileName || '').toLowerCase();
  let cues: SubtitleCue[] = [];
  if (name.endsWith('.vtt') || text.trim().startsWith('WEBVTT')) {
    cues = parseVtt(text);
  } else {
    cues = parseSrt(text);
  }

  const vttString = cuesToWebVTT(cues);
  let vttUrl: string | null = null;
  if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const vttBlob = new Blob([vttString], { type: 'text/vtt' });
    vttUrl = URL.createObjectURL(vttBlob);
  }

  return {
    fileName,
    cues,
    vttUrl,
    vttString,
    rawText: text
  };
}

/**
 * Asynchronously parse any File or Blob (.srt or .vtt)
 */
export async function parseSubtitleFile(file: File | Blob): Promise<SubtitleTrackData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const fileName = file instanceof File ? file.name : 'subtitles.vtt';
        resolve(parseSubtitleString(text, fileName));
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read subtitle file'));
    reader.readAsText(file, 'UTF-8');
  });
}

/**
 * Get active cues matching the given current time with delay offset.
 */
export function getActiveCues(cues: SubtitleCue[], currentTimeSec: number, delaySec = 0): SubtitleCue[] {
  if (!Array.isArray(cues) || cues.length === 0) return [];
  const effectiveTime = currentTimeSec - delaySec;
  return cues.filter((cue) => effectiveTime >= cue.startSec && effectiveTime <= cue.endSec);
}
