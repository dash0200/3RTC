/**
 * "Your quick reactions": pick up to 10 emojis for the reaction buttons and keys 1-9, 0.
 * Tap a slot to select it, then tap an emoji to put it there; with no slot selected an emoji is
 * added at the end. Any emoji can also be typed or pasted (phone emoji keyboard). Changes save
 * straight away on this device.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { EMOJI_CATEGORIES, splitEmojis } from '../../utils/emoji';
import {
    DEFAULT_REACTIONS, MAX_REACTIONS, keyForIndex, setReactionSet, useReactionSet,
    useReactionsEditorOpen, closeReactionsEditor
} from './reactionSet';
import './reactionsEditor.css';

export default function ReactionsEditor() {
    const isOpen = useReactionsEditorOpen();
    const items = useReactionSet();
    const list = useMemo(() => items.map((i) => i.emoji), [items]);
    const [selected, setSelected] = useState(null); // index of the slot being replaced
    const [category, setCategory] = useState(EMOJI_CATEGORIES[0].id);
    const [typed, setTyped] = useState('');

    useEffect(() => {
        if (!isOpen) return undefined;
        setSelected(null);
        const onKey = (e) => {
            if (e.key === 'Escape') closeReactionsEditor();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen]);

    if (!isOpen) return null;

    const put = (emoji) => {
        const at = list.indexOf(emoji);
        const next = [...list];
        if (selected !== null) {
            if (at >= 0 && at !== selected) [next[at], next[selected]] = [next[selected], next[at]]; // already there: swap
            else next[selected] = emoji;
            setSelected(null);
        } else if (at >= 0) {
            return; // already in the set
        } else if (next.length < MAX_REACTIONS) {
            next.push(emoji);
        } else {
            return;
        }
        setReactionSet(next);
    };

    const remove = (index) => {
        if (list.length <= 1) return;
        setReactionSet(list.filter((_, i) => i !== index));
        setSelected(null);
    };

    const move = (index, delta) => {
        const to = index + delta;
        if (to < 0 || to >= list.length) return;
        const next = [...list];
        [next[index], next[to]] = [next[to], next[index]];
        setReactionSet(next);
        setSelected(to);
    };

    const addTyped = (text) => {
        const emojis = splitEmojis(text);
        if (!emojis.length) return;
        if (selected !== null) {
            put(emojis[0]);
        } else {
            setReactionSet([...list, ...emojis.filter((e) => !list.includes(e))].slice(0, MAX_REACTIONS));
        }
        setTyped('');
    };

    const full = list.length >= MAX_REACTIONS;
    const emojis = EMOJI_CATEGORIES.find((c) => c.id === category)?.emojis || [];
    const hint = selected !== null
        ? `Pick an emoji to replace ${list[selected]}`
        : full ? 'All 10 used: tap one to replace it' : `Tap an emoji to add it (${list.length}/${MAX_REACTIONS})`;

    return createPortal(
        <div className="rx-editor-backdrop" onClick={closeReactionsEditor}>
            <div className="rx-editor" role="dialog" aria-modal="true" aria-label="Your quick reactions" onClick={(e) => e.stopPropagation()}>
                <div className="rx-editor-head">
                    <h2>Your quick reactions</h2>
                    <button type="button" className="rx-editor-close" onClick={closeReactionsEditor} aria-label="Close">✕</button>
                </div>

                <div className="rx-slots" role="list">
                    {list.map((emoji, i) => (
                        <div key={`${emoji}-${i}`} role="listitem" className={`rx-slot ${selected === i ? 'is-selected' : ''}`}>
                            <button type="button" className="rx-slot-emoji" onClick={() => setSelected(selected === i ? null : i)}
                                aria-label={`Reaction ${i + 1}: ${emoji}${selected === i ? ' (selected)' : ''}`} aria-pressed={selected === i}>
                                {emoji}
                            </button>
                            <span className="rx-slot-key">{keyForIndex(i)}</span>
                            {list.length > 1 && (
                                <button type="button" className="rx-slot-remove" onClick={() => remove(i)} aria-label={`Remove ${emoji}`}>×</button>
                            )}
                        </div>
                    ))}
                    {!full && (
                        <div className="rx-slot rx-slot-empty" role="listitem" aria-hidden="true"><span>+</span></div>
                    )}
                </div>

                <div className="rx-hint" aria-live="polite">{hint}</div>
                {selected !== null && (
                    <div className="rx-move">
                        <button type="button" onClick={() => move(selected, -1)} disabled={selected === 0}>◀ Move left</button>
                        <button type="button" onClick={() => move(selected, 1)} disabled={selected === list.length - 1}>Move right ▶</button>
                    </div>
                )}

                <div className="rx-tabs" role="tablist">
                    {EMOJI_CATEGORIES.map((c) => (
                        <button key={c.id} type="button" role="tab" aria-selected={category === c.id}
                            className={`rx-tab ${category === c.id ? 'is-active' : ''}`} onClick={() => setCategory(c.id)} title={c.name}>
                            {c.icon}
                        </button>
                    ))}
                </div>
                <div className="rx-grid">
                    {emojis.map((emoji) => {
                        const used = list.includes(emoji);
                        return (
                            <button key={emoji} type="button" className={`rx-pick ${used ? 'is-used' : ''}`}
                                disabled={full && selected === null && !used} onClick={() => put(emoji)} aria-label={`${used ? 'In your set: ' : ''}${emoji}`}>
                                {emoji}
                            </button>
                        );
                    })}
                </div>

                <form className="rx-type" onSubmit={(e) => { e.preventDefault(); addTyped(typed); }}>
                    <input
                        type="text"
                        inputMode="text"
                        placeholder="Or type / paste any emoji"
                        value={typed}
                        onChange={(e) => setTyped(e.target.value)}
                        aria-label="Type or paste an emoji"
                    />
                    <button type="submit" disabled={!splitEmojis(typed).length}>{selected !== null ? 'Replace' : 'Add'}</button>
                </form>

                <div className="rx-foot">
                    <button type="button" className="rx-reset" onClick={() => { setReactionSet(DEFAULT_REACTIONS); setSelected(null); }}>Reset to default</button>
                    <button type="button" className="btn btn-primary rx-done" onClick={closeReactionsEditor}>Done</button>
                </div>
            </div>
        </div>,
        document.body
    );
}
