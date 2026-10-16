import React, { useState } from 'react';
import { useLiveVoiceUsers } from '../../utils/speakingActivity';
import { getAvatarColor } from '../../utils/sound';
import { getInitials, PeerAudioPopover } from '../PeerVoiceRoster';
import { Icon } from '../icons';

/**
 * Who's watching, on the video itself (Figma "People on video"): a ring shows who is talking,
 * so nobody has to look away from the picture. Desktop: everyone; tap a friend for their volume.
 * Phone: only whoever is talking right now.
 */
export default function VideoPeopleOverlay({ connectedPeers, localUser, isPhone = false, onSetPeerVolume, onToggleMutePeer }) {
  const { peers, localUser: me } = useLiveVoiceUsers(connectedPeers, localUser);
  const [selected, setSelected] = useState(null);
  const people = [
    ...peers.map((p) => ({ key: p.peerId || p.id, name: p.username || 'Friend', speaking: Boolean(p.isSpeaking) && !p.isMuted, muted: Boolean(p.isMuted), peer: p })),
    ...(me ? [{ key: 'me', name: 'You', initialsFrom: me.username, speaking: Boolean(me.isSpeaking) && !me.isMuted, muted: Boolean(me.isMuted) }] : [])
  ];
  const shown = isPhone ? people.filter((p) => p.speaking) : people;
  if (shown.length === 0) return null;

  return (
    <ul className={`vpo ${isPhone ? 'vpo-phone' : ''}`} aria-label="People in the room">
      {shown.map((p) => (
        <li key={p.key} className="vpo-person">
          <button
            type="button"
            className={`rd-av vpo-av ${p.speaking ? 'is-speaking' : ''} ${p.muted ? 'is-quiet' : ''}`}
            style={{ '--av': getAvatarColor(p.initialsFrom || p.name) }}
            disabled={!p.peer || isPhone}
            aria-label={`${p.name}${p.speaking ? ', talking' : ''}${p.muted ? ', mic off' : ''}`}
            onClick={() => setSelected((s) => (s?.key === p.key ? null : p))}
          >
            {getInitials(p.initialsFrom || p.name)}
          </button>
          {!isPhone && (
            <span className="vpo-name">
              {p.name}
              {p.muted && <Icon name="micOff" size={11} strokeWidth={2.6} className="vpo-muted" />}
            </span>
          )}
          {selected?.key === p.key && p.peer && (
            <PeerAudioPopover peer={p.peer} onClose={() => setSelected(null)} onSetVolume={onSetPeerVolume} onToggleMute={onToggleMutePeer} />
          )}
        </li>
      ))}
    </ul>
  );
}
