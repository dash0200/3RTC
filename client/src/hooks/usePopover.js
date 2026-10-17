import { useEffect, useRef, useState } from 'react';
import { useBackLayer } from '../core/backStack';

/** Open/close state for a small popover: closes on outside click, Escape and Back. */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useBackLayer(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return { open, setOpen, toggle: () => setOpen((o) => !o), close: () => setOpen(false), ref };
}
