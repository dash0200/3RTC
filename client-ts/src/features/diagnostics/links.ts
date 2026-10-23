import type { MutableRefObject } from 'react';
import type { PeerEntryRecord } from '../../webrtc/peerEntry';
import type { PeerLinks } from './speedTest';

/** The connection and the bulk channel to each peer, for the stream test */
export function peerLinks(peersRef: MutableRefObject<Map<string, PeerEntryRecord>>): PeerLinks {
  return {
    pc: (id) => peersRef.current.get(id)?.pc ?? null,
    bulk: (id) => {
      const ch = peersRef.current.get(id)?.bulkChannel;
      return ch && ch.readyState === 'open' ? ch : null;
    }
  };
}
