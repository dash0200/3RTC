/**
 * Reactions to show, as a stream instead of React state: the floating layer
 * (components/FloatingReactions.jsx) subscribes and animates each one itself, so a burst of
 * reactions never re-renders the app.
 *
 * Item: { id, emoji, sender, isSelf, lane (0-100), combo (1, 2, 3...), peerKey, mediaTime }
 */

export interface ReactionFeedItem {
  id: string;
  emoji: string;
  sender: string;
  isSelf: boolean;
  lane: number;
  combo: number;
  peerKey: string;
  mediaTime?: number;
}

export interface ReactionFeed {
  emit: (item: ReactionFeedItem) => void;
  subscribe: (listener: (item: ReactionFeedItem) => void) => () => void;
}

export function createReactionFeed(): ReactionFeed {
  const listeners = new Set<(item: ReactionFeedItem) => void>();
  return {
    emit(item: ReactionFeedItem) {
      for (const listener of [...listeners]) {
        try {
          listener(item);
        } catch {
          /* a broken layer never blocks the others */
        }
      }
    },
    subscribe(listener: (item: ReactionFeedItem) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}
