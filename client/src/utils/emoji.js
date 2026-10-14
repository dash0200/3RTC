/** Emoji lists and checks shared by the chat emoji picker and the reactions editor. */

export const EMOJI_CATEGORIES = [
  {
    id: 'smileys',
    name: 'Smileys',
    icon: '😀',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '🥹', '😊',
      '😇', '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😗', '😙',
      '😚', '😋', '😛', '😝', '😜', '🤪', '🤨', '🧐', '🤓', '😎',
      '🥸', '🤩', '🥳', '😏', '😒', '😞', '😔', '😟', '😕', '🙁',
      '☹️', '😣', '😖', '😫', '😩', '🥺', '😢', '😭', '😮‍💨', '😤',
      '😠', '😡', '🤬', '🤯', '😳', '🥵', '🥶', '😱', '😨', '😰',
      '😥', '😓', '🤗', '🫡', '🤔', '🫣', '🤭', '🫢', '🤫', '🫠'
    ]
  },
  {
    id: 'gestures',
    name: 'Gestures',
    icon: '👋',
    emojis: [
      '👋', '🤚', '🖐️', '✋', '🖖', '🫱', '🫲', '🫳', '🫴', '👌',
      '🤌', '🤏', '✌️', '🤞', '🫰', '🤟', '🤘', '🤙', '👈', '👉',
      '👆', '🖕', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜',
      '👏', '🙌', '🫶', '👐', '🤲', '🤝', '🙏', '✍️', '💅', '🤳',
      '💪', '🦾', '🦿', '🦵', '🦶', '👂', '🦻', '👃', '👀', '👁️'
    ]
  },
  {
    id: 'hearts',
    name: 'Hearts & Vibes',
    icon: '❤️',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔',
      '❤️‍🔥', '❤️‍🩹', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝',
      '💟', '✨', '🌟', '⭐', '💫', '🔥', '💥', '⚡', '🎉', '🎊',
      '🎈', '🎁', '🏆', '🥇', '👑', '💎', '💯', '💢', '💬', '🗯️'
    ]
  },
  {
    id: 'fun',
    name: 'Fun & Food',
    icon: '🎮',
    emojis: [
      '🎮', '🕹️', '🎲', '🎯', '🎳', '🎧', '🎵', '🎶', '🎤', '🎬',
      '🍿', '🍕', '🍔', '🍟', '🌭', '🍣', '🍦', '🍩', '🍪', '🍫',
      '🍻', '🥂', '🍾', '☕', '🧃', '🥤', '🚀', '🛸', '🏎️', '🛵'
    ]
  }
];

const EMOJI_CHARS_RE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u200d\ufe0f\u20e3]+$/u;
const GRAPHEMES = typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** True for exactly one emoji (including ones built from several characters, like 👩‍🚀 or 🇮🇳). */
export function isSingleEmoji(text) {
    if (typeof text !== 'string') return false;
    const value = text.trim();
    if (!value || value.length > 16 || !EMOJI_CHARS_RE.test(value)) return false;
    if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(value)) return false;
    if (!GRAPHEMES) return [...value].length <= 4;
    let count = 0;
    for (const _ of GRAPHEMES.segment(value)) {
        if (++count > 1) return false;
    }
    return count === 1;
}

/** The emojis in `text`, one per entry (pasting "😀🔥" gives both). */
export function splitEmojis(text) {
    if (typeof text !== 'string') return [];
    const parts = GRAPHEMES ? [...GRAPHEMES.segment(text)].map((g) => g.segment) : [...text];
    return parts.filter(isSingleEmoji);
}
