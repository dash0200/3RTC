/**
 * Reactions to show, as a stream instead of React state: the floating layer
 * (components/FloatingReactions.jsx) subscribes and animates each one itself, so a burst of
 * reactions never re-renders the app.
 *
 * Item: { id, emoji, sender, isSelf, lane (0-100), combo (1, 2, 3...), peerKey }
 */
export function createReactionFeed() {
    const listeners = new Set();
    return {
        emit(item) {
            for (const listener of [...listeners]) {
                try {
                    listener(item);
                } catch { /* a broken layer never blocks the others */ }
            }
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        }
    };
}
