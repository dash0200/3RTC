import { useEffect, useRef, useState, type InputHTMLAttributes } from 'react';

export const CODE_LENGTH = 5;

const toDigits = (pin?: string | null): string[] => {
  const clean = String(pin || '').replace(/\D/g, '').slice(0, CODE_LENGTH);
  return Array.from({ length: CODE_LENGTH }, (_, i) => clean[i] || '');
};

export interface RoomCodeInputProps extends InputHTMLAttributes<HTMLInputElement> {
  ref: (el: HTMLInputElement | null) => void;
  'aria-label': string;
}

export interface RoomCodeInputHook {
  digits: string[];
  code: string;
  isComplete: boolean;
  boxProps: (index: number) => RoomCodeInputProps;
}

/**
 * The five room-code boxes: typing moves to the next box, Backspace goes back,
 * a pasted or autofilled code fills them all, Enter joins once all five are in.
 */
export function useRoomCodeInput(initialPin = '', onComplete?: (code: string) => void): RoomCodeInputHook {
  const [digits, setDigits] = useState<string[]>(() => toDigits(initialPin));
  const boxRefs = useRef<Array<HTMLInputElement | null>>([]);

  // A room code from a shared link (?room=12345) fills the boxes
  useEffect(() => {
    const next = toDigits(initialPin);
    if (next.join('').length === CODE_LENGTH) setDigits(next);
  }, [initialPin]);

  const code = digits.join('');
  const isComplete = code.length === CODE_LENGTH;

  const setDigit = (index: number, value: string): void => {
    const clean = value.replace(/\D/g, '');
    if (clean.length > 1) {
      const next = clean.slice(0, CODE_LENGTH).split('');
      setDigits(Array.from({ length: CODE_LENGTH }, (_, i) => next[i] || ''));
      boxRefs.current[Math.min(next.length, CODE_LENGTH) - 1]?.focus();
      return;
    }
    setDigits((prev) => prev.map((d, i) => (i === index ? clean : d)));
    if (clean && index < CODE_LENGTH - 1) boxRefs.current[index + 1]?.focus();
  };

  const onKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Backspace' && !digits[index] && index > 0) {
      boxRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowLeft' && index > 0) {
      e.preventDefault();
      boxRefs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < CODE_LENGTH - 1) {
      e.preventDefault();
      boxRefs.current[index + 1]?.focus();
    } else if (e.key === 'Enter' && isComplete) {
      onComplete?.(code);
    }
  };

  /** Props for box i: spread onto an <input>. */
  const boxProps = (i: number): RoomCodeInputProps => ({
    ref: (el: HTMLInputElement | null) => { boxRefs.current[i] = el; },
    type: 'text',
    inputMode: 'numeric',
    autoComplete: i === 0 ? 'one-time-code' : 'off',
    maxLength: CODE_LENGTH,
    'aria-label': `Digit ${i + 1}`,
    value: digits[i],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDigit(i, e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => onKeyDown(i, e),
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => e.target.select(),
    onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, CODE_LENGTH);
      if (pasted) {
        setDigits(Array.from({ length: CODE_LENGTH }, (_, idx) => pasted[idx] || ''));
        boxRefs.current[Math.min(pasted.length, CODE_LENGTH) - 1]?.focus();
      }
    }
  });

  return { digits, code, isComplete, boxProps };
}
