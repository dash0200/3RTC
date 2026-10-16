import React, { useState } from 'react';
import { getMobileJoinUrl } from '../../utils/qrCode';
import { copyToClipboard } from '../../utils/clipboard';
import { Icon } from '../icons';
import { useRoom } from '../../core/RoomContext';

/** Desktop side panel while you're alone in the room (Figma): getting friends in comes first. */
export default function InvitePanel({ roomId, onShowQr, onCopied }) {
  const [copied, setCopied] = useState(false);
  const { username } = useRoom() || {};
  const link = getMobileJoinUrl(roomId, null, username);
  const copy = async () => {
    if (await copyToClipboard(link)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onCopied?.();
    }
  };
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`Watch with me on 3RTC: ${link}`)}`;

  return (
    <aside className="ip" aria-label="Invite friends">
      <div className="ip-head">
        <h2>You’re the first one here</h2>
        <p>Send your friends the link, or have them type this code on 3rtc.me.</p>
      </div>
      <div className="ip-code" role="img" aria-label={`Room code ${String(roomId).split('').join(' ')}`}>
        {String(roomId).split('').map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <button type="button" className="rd-btn rd-btn-primary ip-copy" onClick={copy}>
        <Icon name={copied ? 'check' : 'link'} size={18} strokeWidth={2.2} />
        {copied ? 'Link copied' : 'Copy invite link'}
      </button>
      <div className="ip-row">
        <a className="rd-btn rd-btn-secondary" href={whatsapp} target="_blank" rel="noopener noreferrer">WhatsApp</a>
        <button type="button" className="rd-btn rd-btn-secondary" onClick={onShowQr}>Show QR code</button>
      </div>
      <div className="ip-foot">
        <p>Chat, queue and people show up here</p>
        <p>as soon as someone joins.</p>
      </div>
    </aside>
  );
}
