import { useState } from 'react';
import { getMobileJoinUrl, getServerTag } from '../../utils/joinUrl';
import { copyToClipboard } from '../../utils/clipboard';
import { Icon } from '../icons';
import { useRoom } from '../../core/RoomContext';

export interface InvitePanelProps {
  roomId?: string | null;
  onShowQr?: () => void;
  onCopied?: () => void;
  isTab?: boolean;
}

/** Desktop side panel or tab while you're alone in the room: getting friends in comes first. */
export default function InvitePanel({
  roomId = '',
  onShowQr,
  onCopied,
  isTab = false
}: InvitePanelProps) {
  const [copied, setCopied] = useState(false);
  const { username, signalUrl } = useRoom() || {};
  const link = getMobileJoinUrl(roomId || '', null, username, getServerTag(signalUrl));
  const copy = async () => {
    if (await copyToClipboard(link)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onCopied?.();
    }
  };
  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`Watch with me on 3RTC: ${link}`)}`;

  const Element = isTab ? 'div' : 'aside';

  return (
    <Element className={`ip ${isTab ? 'ip-tab' : ''}`} aria-label="Invite friends">
      <div className="ip-head">
        <h2>You’re the first one here</h2>
        <p>Send your friends the link, or have them type this code on 3rtc.me.</p>
      </div>
      <div className="ip-code" role="img" aria-label={`Room code ${String(roomId || '').split('').join(' ')}`}>
        {String(roomId || '').split('').map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <button type="button" className="rd-btn rd-btn-primary ip-copy" onClick={copy}>
        <Icon name={copied ? 'check' : 'link'} size={18} strokeWidth={2.2} />
        {copied ? 'Link copied' : 'Copy invite link'}
      </button>
      <div className="ip-row">
        <a className="rd-btn rd-btn-secondary" href={whatsapp} target="_blank" rel="noopener noreferrer">WhatsApp</a>
        <button type="button" className="rd-btn rd-btn-secondary" onClick={onShowQr}>Show QR code</button>
      </div>
      <a
        href="/desktop/3RTC-portable.zip"
        download="3RTC-portable.zip"
        className="rd-btn rd-btn-secondary ip-download"
        title="Download full 3RTC Windows Desktop app (.zip)"
      >
        <Icon name="download" size={16} strokeWidth={2.2} />
        Download Desktop app (.zip)
      </a>
      <div className="ip-foot">
        <p>{isTab ? 'Queue videos before friends arrive' : 'Chat, queue and people show up here'}</p>
        <p>{isTab ? 'Switch to the Queue tab above to add videos or search quick picks.' : 'as soon as someone joins.'}</p>
      </div>
    </Element>
  );
}
