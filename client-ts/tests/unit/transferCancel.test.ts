import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ACCEPT_MIN_BYTES, TransferPeers, needsAccept } from '../../src/features/chat/transferPeers.ts';
import { FOLDER_MAX_FILES, cleanFolderOffer, cleanFolderPath, folderRows } from '../../src/features/chat/folderOffer.ts';
import {
  patchTransfer,
  setFolderCancelled,
  setTransferCancelled,
  transferStatusText,
  type ChatMessage
} from '../../src/features/chat/chatMessages.ts';

describe('chat files: accept and cancel (transferPeers)', () => {
  it('only big files wait to be accepted (8 MB, as the desktop app)', () => {
    assert.equal(ACCEPT_MIN_BYTES, 8 * 1024 * 1024);
    assert.equal(needsAccept(ACCEPT_MIN_BYTES - 1), false);
    assert.equal(needsAccept(ACCEPT_MIN_BYTES), true);
    assert.equal(needsAccept(Number.NaN), false);
  });

  it('an offered file goes only to those who accept it', () => {
    const t = new TransferPeers();
    t.sending('tx', ['bob', 'carol'], true);
    assert.deepEqual(t.status('tx'), { waiting: 2, sending: 0, sent: 0 });
    assert.equal(t.isDropped('tx', 'bob'), true, 'nothing goes to bob before he accepts');
    assert.equal(t.onAccept('tx', 'bob'), true);
    assert.equal(t.onAccept('tx', 'bob'), false, 'once');
    assert.equal(t.onAccept('tx', 'mallory'), false, 'not offered to them');
    assert.equal(t.isDropped('tx', 'bob'), false);
    assert.equal(t.delivered('tx', 'bob'), null, 'carol may still accept');
    assert.deepEqual(t.status('tx'), { waiting: 1, sending: 0, sent: 1 });
    assert.deepEqual(t.onCancel('tx', 'carol'), { kind: 'over', ended: 'finished' }, 'carol declined: over');
    assert.equal(t.isOurs('tx'), false);
  });

  it('nobody accepting stops it', () => {
    const t = new TransferPeers();
    t.sending('tx', ['bob', 'carol'], true);
    assert.deepEqual(t.onCancel('tx', 'bob'), { kind: 'stop-to', peer: 'bob' });
    assert.deepEqual(t.onCancel('tx', 'carol'), { kind: 'over', ended: 'nobody-got-it' });
  });

  it('a small file goes to everyone at once', () => {
    const t = new TransferPeers();
    t.sending('tx', ['bob', 'carol']);
    assert.equal(t.isDropped('tx', 'bob'), false);
    assert.equal(t.onAccept('tx', 'bob'), false, 'nothing to accept');
    assert.equal(t.delivered('tx', 'bob'), null);
    assert.equal(t.delivered('tx', 'carol'), 'finished');
  });

  it("a cancel from the file's sender cancels it; another receiver's does not", () => {
    const t = new TransferPeers();
    t.receiving('tx', 'alice');
    assert.equal(t.senderOf('tx'), 'alice');
    assert.deepEqual(t.onCancel('tx', 'bob'), { kind: 'ignore' });
    assert.equal(t.isTheirs('tx'), true);
    assert.deepEqual(t.onCancel('tx', 'alice'), { kind: 'cancelled' });
    assert.equal(t.isTheirs('tx'), false);
    assert.deepEqual(t.onCancel('tx', 'alice'), { kind: 'ignore' });
  });

  it('a receiver cancelling only stops the sending to them', () => {
    const t = new TransferPeers();
    t.sending('tx', ['bob', 'carol']);
    assert.deepEqual(t.onCancel('tx', 'bob'), { kind: 'stop-to', peer: 'bob' });
    assert.equal(t.isDropped('tx', 'bob'), true);
    assert.equal(t.isDropped('tx', 'carol'), false);
    assert.deepEqual(t.onCancel('tx', 'bob'), { kind: 'ignore' });
    assert.deepEqual(t.onCancel('tx', 'mallory'), { kind: 'ignore' });
  });

  it('receivers leaving count as not receiving', () => {
    const t = new TransferPeers();
    t.sending('a', ['bob', 'carol']);
    t.sending('b', ['bob'], true);
    t.sending('c', ['bob', 'dave']);
    t.delivered('c', 'dave');
    assert.deepEqual(t.peerGone('bob'), [
      ['b', 'nobody-got-it'],
      ['c', 'finished']
    ]);
    assert.equal(t.isOurs('a'), true, 'carol still gets a');
    assert.deepEqual(t.peerGone('carol'), [['a', 'nobody-got-it']]);
    assert.deepEqual(t.peerGone('eve'), []);
  });

  it('a receiver back after a reconnect receives again', () => {
    const t = new TransferPeers();
    t.sending('tx', ['bob', 'carol']);
    t.peerGone('bob');
    t.rejoin('tx', 'bob');
    assert.equal(t.isDropped('tx', 'bob'), false);
    t.onCancel('tx', 'carol');
    assert.equal(t.isOurs('tx'), true, 'bob still receives');
  });

  it('finishing and leaving the room forget everything', () => {
    const t = new TransferPeers();
    t.sending('tx', ['bob']);
    t.receiving('rx', 'alice');
    t.finish('tx');
    assert.deepEqual(t.onCancel('tx', 'bob'), { kind: 'ignore' });
    t.reset();
    assert.deepEqual(t.onCancel('rx', 'alice'), { kind: 'ignore' });
  });
});

describe('folders offered in chat (folderOffer)', () => {
  it('paths are cleaned: never above the folder', () => {
    assert.equal(cleanFolderPath('Photos/2026/a.jpg'), 'Photos/2026/a.jpg');
    assert.equal(cleanFolderPath('../../Windows/evil.dll'), 'Windows/evil.dll');
    assert.equal(cleanFolderPath('a\\b\\c.txt'), 'a/b/c.txt');
    assert.equal(cleanFolderPath('./'), null);
    assert.equal(cleanFolderPath(42), null);
  });

  it('an offer is checked like the desktop app checks it', () => {
    const offer = cleanFolderOffer({
      folderId: 'fold',
      name: '',
      files: [
        { transferId: 'b', path: 'Photos/2026/b.png', fileSize: 10, mimeType: 'image/png' },
        { transferId: 'a', path: 'Photos/a.png', fileSize: 5 },
        { transferId: '', path: 'Photos/c.png', fileSize: 1 },
        { transferId: 'fold', path: 'Photos/d.png', fileSize: 1 },
        { transferId: 'a', path: 'Photos/dup.png', fileSize: 1 },
        { transferId: 'n', path: 'Photos/neg.png', fileSize: -4 },
        'junk'
      ]
    });
    assert.ok(offer);
    assert.equal(offer.name, 'Photos', 'named after its top folder when the name is missing');
    assert.deepEqual(
      offer.files.map((f) => f.transferId),
      ['b', 'a', 'n'],
      'in path order, bad and repeated ids dropped'
    );
    assert.equal(offer.files.find((f) => f.transferId === 'n')?.fileSize, 0);
    assert.equal(offer.files.find((f) => f.transferId === 'b')?.fileName, 'b.png');
    assert.equal(cleanFolderOffer({ folderId: '', files: [{ transferId: 'a', path: 'a' }] }), null);
    assert.equal(cleanFolderOffer({ folderId: 'f', files: [] }), null);
    const many = Array.from({ length: FOLDER_MAX_FILES + 5 }, (_, i) => ({ transferId: `t${i}`, path: `F/${i}.png` }));
    assert.equal(cleanFolderOffer({ folderId: 'f', files: many })?.files.length, FOLDER_MAX_FILES);
  });

  it('the tree shows each folder level once, before its files', () => {
    const f = (path: string) => ({ transferId: path, path, fileName: path.split('/').pop() || '', fileSize: 1, mimeType: '' });
    const rows = folderRows([f('P/2026/a.jpg'), f('P/2026/b.jpg'), f('P/c.jpg'), f('P/x/2026/d.jpg')]);
    assert.deepEqual(
      rows.map((r) => (r.kind === 'dir' ? `${r.depth}:${r.name}/` : `${r.depth}:${r.file.fileName}`)),
      ['0:P/', '1:2026/', '2:a.jpg', '2:b.jpg', '1:c.jpg', '1:x/', '2:2026/', '3:d.jpg']
    );
  });
});

describe('file cards (chatMessages)', () => {
  const card = { transferId: 't', isTransferring: true, percent: 40, fileName: 'f.zip', fileSize: 1 };

  it('the status line says where the file is', () => {
    assert.equal(transferStatusText({ ...card, isOffered: true }, false, '9 MB'), '9 MB • accept to download');
    assert.equal(
      transferStatusText({ ...card, send: { waiting: 2, sending: 0, sent: 0 } }, true, '9 MB'),
      'Waiting for 2 people to accept (9 MB)'
    );
    assert.equal(
      transferStatusText({ ...card, send: { waiting: 1, sending: 1, sent: 0 } }, true, '9 MB'),
      'Sending to 1 person • 40%, 1 waiting (9 MB)'
    );
    assert.equal(transferStatusText(card, false, '1 MB'), 'Receiving • 40% (1 MB)');
    assert.equal(transferStatusText({ ...card, isCancelled: true }, true, '1 MB'), '✕ Cancelled (1 MB)');
  });

  const msgs = (): ChatMessage[] => [
    { type: 'chat', id: '1', sender: 'A', text: '', timestamp: 0, isSelf: false, transferId: 't', imageTransfer: { ...card, isOffered: true } },
    {
      type: 'chat',
      id: '2',
      sender: 'A',
      text: '',
      timestamp: 0,
      isSelf: false,
      folder: {
        folderId: 'f',
        name: 'F',
        files: [
          { transferId: 'x', path: 'F/x', fileName: 'x', fileSize: 1, mimeType: '', state: 'done', percent: 100 },
          { transferId: 'y', path: 'F/y', fileName: 'y', fileSize: 1, mimeType: '', state: 'offered', percent: 0 }
        ]
      }
    }
  ];

  it('a cancel marks the card, or the folder file', () => {
    const a = setTransferCancelled('t')(msgs());
    assert.equal(a[0].imageTransfer?.isCancelled, true);
    assert.equal(a[0].imageTransfer?.isOffered, false);
    const b = setTransferCancelled('y')(msgs());
    assert.equal(b[1].folder?.files[1].state, 'cancelled');
    assert.equal(b[1].folder?.files[0].state, 'done');
  });

  it('a withdrawn folder keeps the files already here', () => {
    const c = setFolderCancelled('f')(msgs());
    assert.equal(c[1].folder?.isCancelled, true);
    assert.deepEqual(
      c[1].folder?.files.map((f) => f.state),
      ['done', 'cancelled']
    );
  });

  it('accepting a folder file shows it coming', () => {
    const d = patchTransfer('y', {}, { state: 'receiving' })(msgs());
    assert.equal(d[1].folder?.files[1].state, 'receiving');
    assert.equal(d[0].imageTransfer?.isOffered, true, 'other messages untouched');
  });
});
