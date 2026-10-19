import { useEffect, useRef, useState, type RefObject } from 'react';
import { useBackLayer } from '../core/backStack';

export interface PopoverControls<T extends HTMLElement = HTMLDivElement> {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  toggle: () => void;
  close: () => void;
  ref: RefObject<T | null>;
}

/** Open/close state for a small popover: closes on outside click, Escape and Back. */
export function usePopover<T extends HTMLElement = HTMLDivElement>(): PopoverControls<T> {
  const [open, setOpen] = useState(false);
  const ref = useRef<T | null>(null);
  useBackLayer(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return { open, setOpen, toggle: () => setOpen((o) => !o), close: () => setOpen(false), ref };
}
