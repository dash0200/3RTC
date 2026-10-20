/**
 * Stream doctor: the part of the Network HUD that finds out why local-video streaming is slow
 * between you and one person. Live numbers from this device's streaming, and a ~30 s test with
 * the other app (./speedTest.ts) that ends in plain findings (./verdict.ts) and a copyable report.
 */
import { useEffect, useMemo, useRef, useState, type JSX, type MutableRefObject } from 'react';
import type { RoomBus } from '../../types';
import type { PeerEntryRecord } from '../../webrtc/peerEntry';
import { copyToClipboard } from '../../utils/clipboard';
import { liveSnapshot, type LiveSnapshot } from './telemetry';
import { BUFFER_STEPS, runStreamTest, PeerTooOldError, type PhaseResult, type StreamTestReport } from './speedTest';
import { peerLinks } from './links';
import { analyze, mbps, reportText, type Severity, type Verdict } from './verdict';
import './diagnostics.css';

export interface StreamDoctorProps {
  bus: RoomBus;
  peersRef: MutableRefObject<Map<string, PeerEntryRecord>>;
  peerNames: Record<string, { username?: string }>;
  selfName: string;
}

const SEVERITY_LABEL: Record<Severity, string> = { bad: 'Problem', warn: 'Check', info: 'Note', ok: 'Fine' };

function LiveCard({ snap }: { snap: LiveSnapshot }): JSX.Element {
  const r = snap.recent;
  const o = snap.overall;
  const watching = snap.watching;
  const sharing = snap.sharing.viewers + snap.sharing.relays > 0;
  const bitrate = watching?.bitrateKbps ?? snap.sharing.bitrateKbps;
  const rows: [string, string, boolean?][] = [];
  if (watching) {
    rows.push(['Receiving now', `${mbps(r.recvKbps)} (2 min avg ${mbps(o.recvKbps)})`, bitrate !== null && r.recvKbps < bitrate && !snap.video.paused]);
    rows.push(['Buffered ahead', snap.video.bufferedAheadS !== null ? `${snap.video.bufferedAheadS} s` : '–', snap.video.bufferedAheadS !== null && snap.video.bufferedAheadS < 5]);
    rows.push(['Stopped to load (2 min)', `${o.stalls}× · ${(o.stallMs / 1000).toFixed(1)} s`, o.stalls > 0]);
    rows.push(['Piece arrival (ask → have)', o.blockLatencyMs.p50 !== null ? `${o.blockLatencyMs.p50} ms typical · ${o.blockLatencyMs.p95} ms slow` : '–', (o.blockLatencyMs.p95 ?? 0) > 3000]);
    rows.push(['Pieces asked again', String(o.reasks), o.reasks > 3]);
    rows.push(['Source', watching.relayed ? 'through another viewer' : watching.swarm ? 'owner + other viewers' : 'straight from the owner']);
  }
  if (sharing) {
    rows.push(['Sending now', `${mbps(r.sendKbps)} to ${snap.sharing.viewers} viewer${snap.sharing.viewers === 1 ? '' : 's'}${snap.sharing.relays ? ` (+${snap.sharing.relays} relayed)` : ''}`]);
    rows.push(['Waiting on send buffer', `${r.drainWaitPct}% now · ${o.drainWaitPct}% over 2 min`, o.drainWaitPct >= 50]);
    rows.push(['File read per 256 KB', o.readMsAvg !== null ? `${o.readMsAvg} ms` : '–', (o.readMsAvg ?? 0) > 40]);
  }
  return (
    <div className="sd-card">
      <div className="sd-card-title">
        This device, live
        {bitrate !== null && <span className="sd-chip">video ≈ {mbps(bitrate)}</span>}
        {snap.video.resolution && <span className="sd-chip">{snap.video.resolution}</span>}
      </div>
      {rows.length ? (
        <dl className="sd-rows">
          {rows.map(([k, v, warn]) => (
            <div key={k} className={`sd-row${warn ? ' is-warn' : ''}`}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="sd-muted">No local video streaming on this device right now. Play one to see live numbers.</p>
      )}
    </div>
  );
}

function Bars({ phases, direction, needKbps }: { phases: PhaseResult[]; direction: 'download' | 'upload'; needKbps: number | null }): JSX.Element | null {
  const list = phases.filter((p) => p.direction === direction && !p.warmup);
  if (!list.length) return null;
  const rates = list.map((p) => (p.meter ? Math.max(p.meter.steadyKbps, p.meter.rateKbps) : 0));
  const max = Math.max(1, needKbps ?? 0, ...rates) * 1.1;
  return (
    <div className="sd-bars">
      {list.map((p, i) => (
        <div key={i} className="sd-bar-row">
          <span className="sd-bar-label">
            {p.high >= 1024 * 1024 ? `${Math.round((p.high / 1024 / 1024) * 10) / 10} MB` : `${Math.round(p.high / 1024)} KB`}
            {p.high === BUFFER_STEPS[0][0] ? (list.slice(0, i).some((q) => q.high === p.high) ? ' (now, again)' : ' (now)') : ''}
          </span>
          <span className="sd-bar-track">
            <span className="sd-bar-fill" style={{ width: `${(rates[i] / max) * 100}%` }} />
            {needKbps !== null && <span className="sd-bar-need" style={{ left: `${(needKbps / max) * 100}%` }} title="what the video needs" />}
          </span>
          <span className="sd-bar-value">{p.error ? 'failed' : mbps(rates[i])}</span>
        </div>
      ))}
    </div>
  );
}

function Results({ report, verdict, onCopy, copied }: { report: StreamTestReport; verdict: Verdict; onCopy: () => void; copied: boolean }): JSX.Element {
  const n = verdict.numbers;
  const need = n.videoKbps ? Math.round(n.videoKbps * 1.25) : null;
  const peer = report.peer.name;
  return (
    <div className="sd-results">
      <div className={`sd-headline is-${verdict.severity}`}>{verdict.headline}</div>
      <div className="sd-numbers">
        <div><span>Ping idle</span><strong>{n.pingIdleMs ?? '–'} ms</strong></div>
        <div><span>Ping while sending</span><strong>{n.pingLoadedMs ?? '–'} ms</strong><em>network {n.networkRttMaxMs ?? '–'} ms max</em></div>
        <div><span>{peer} → you</span><strong>{mbps(n.downNowKbps)}</strong><em>best {mbps(n.downBestKbps)}</em></div>
        <div><span>You → {peer}</span><strong>{mbps(n.upNowKbps)}</strong><em>best {mbps(n.upBestKbps)}</em></div>
        <div><span>Video needs</span><strong>{n.videoKbps ? mbps(Math.round(n.videoKbps * 1.25)) : '–'}</strong><em>{n.videoKbps ? `avg ${mbps(n.videoKbps)}` : 'none playing'}</em></div>
        <div><span>192 KB limit at this ping</span><strong>{mbps(n.bufferCeilingKbps)}</strong></div>
      </div>

      <div className="sd-bars-block">
        <div className="sd-sub">Speed by send-buffer size · {peer} → you</div>
        <Bars phases={report.phases} direction="download" needKbps={n.videoDirection === 'download' ? need : null} />
        <div className="sd-sub">You → {peer}</div>
        <Bars phases={report.phases} direction="upload" needKbps={n.videoDirection === 'upload' ? need : null} />
      </div>

      <ul className="sd-findings">
        {verdict.findings.map((f) => (
          <li key={f.id} className={`sd-finding is-${f.severity}`}>
            <span className="sd-badge">{SEVERITY_LABEL[f.severity]}</span>
            <div>
              <div className="sd-finding-title">{f.title}</div>
              <div className="sd-finding-detail">{f.detail}</div>
              {f.fix && <div className="sd-finding-fix">Fix: {f.fix}</div>}
            </div>
          </li>
        ))}
      </ul>

      <details className="sd-details">
        <summary>Every step in detail</summary>
        <div className="sd-table-wrap">
          <table className="sd-table">
            <thead>
              <tr>
                <th>Step</th><th>Buffer</th><th>Speed</th><th>App ping (typ / slow)</th><th>Network round trip</th><th>Longest pause</th><th>Pauses &gt;100 ms</th><th>Sender waiting</th><th>Voice loss</th>
              </tr>
            </thead>
            <tbody>
              {report.phases.map((p, i) => (
                <tr key={i}>
                  <td>{p.warmup ? 'warm-up, ' : ''}{p.direction === 'download' ? `${peer} → you` : `you → ${peer}`}</td>
                  <td>{p.high >= 1024 * 1024 ? `${Math.round((p.high / 1024 / 1024) * 10) / 10} MB` : `${Math.round(p.high / 1024)} KB`}</td>
                  <td>{p.error ? p.error : mbps(p.meter ? Math.max(p.meter.steadyKbps, p.meter.rateKbps) : null)}</td>
                  <td>{p.loadedPing.p50 ?? '–'} / {p.loadedPing.p95 ?? '–'} ms{p.loadedPing.lost ? ` (${p.loadedPing.lost} lost)` : ''}</td>
                  <td>{p.networkRtt?.length ? `${Math.min(...p.networkRtt)}–${Math.max(...p.networkRtt)} ms` : '–'}</td>
                  <td>{p.meter ? `${p.meter.maxGapMs} ms` : '–'}</td>
                  <td>{p.meter ? p.meter.gaps.length : '–'}</td>
                  <td>{p.sender ? `${p.sender.blockedPct}%` : '–'}</td>
                  <td>{p.audioLossInPct !== null ? `${p.audioLossInPct}%` : '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="sd-muted">
          Connection: {report.local.linkStart?.pair ? `${report.local.linkStart.pair.localType} ↔ ${report.local.linkStart.pair.remoteType} over ${report.local.linkStart.pair.protocol?.toUpperCase()}` : 'unknown'}
          {report.local.linkStart?.pair?.networkType ? ` · ${report.local.linkStart.pair.networkType}` : ''} · idle ping {report.idlePing.min ?? '–'}–{report.idlePing.max ?? '–'} ms, jitter {report.idlePing.jitterMs ?? '–'} ms · test took {Math.round(report.durationMs / 1000)} s
        </p>
      </details>

      <button type="button" className={`btn-hud-copy sd-copy ${copied ? 'copied' : ''}`} onClick={onCopy}>
        {copied ? 'Report copied' : 'Copy full report'}
      </button>
    </div>
  );
}

export default function StreamDoctor({ bus, peersRef, peerNames, selfName }: StreamDoctorProps): JSX.Element {
  const [snap, setSnap] = useState<LiveSnapshot>(() => liveSnapshot());
  useEffect(() => {
    const t = setInterval(() => setSnap(liveSnapshot()), 1000);
    return () => clearInterval(t);
  }, []);

  const peers = Object.entries(peerNames)
    .filter(([id]) => peersRef.current.has(id))
    .map(([id, meta]) => ({ id, name: meta.username || `User ${id.slice(0, 4)}` }));
  const peersKey = peers.map((p) => p.id).join(',');
  // Default: whoever the video comes from, else the first person
  const preferred = snap.watching?.ownerId && peers.some((p) => p.id === snap.watching?.ownerId) ? snap.watching.ownerId : peers[0]?.id ?? '';
  const [picked, setPicked] = useState('');
  const peerId = peers.some((p) => p.id === picked) ? picked : preferred;

  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<{ label: string; fraction: number } | null>(null);
  const [result, setResult] = useState<{ report: StreamTestReport; verdict: Verdict } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const abortRef = useRef<{ aborted: boolean } | null>(null);
  useEffect(() => () => {
    if (abortRef.current) abortRef.current.aborted = true;
  }, []);

  const links = useMemo(() => peerLinks(peersRef), [peersRef]);

  const run = async (): Promise<void> => {
    const peer = peers.find((p) => p.id === peerId);
    if (!peer || running) return;
    const signal = { aborted: false };
    abortRef.current = signal;
    setRunning(true);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      const report = await runStreamTest({
        bus,
        links,
        peerId: peer.id,
        peerName: peer.name,
        selfName,
        signal,
        onProgress: (label, fraction) => setStep({ label, fraction })
      });
      if (abortRef.current !== signal) return;
      setResult({ report, verdict: analyze(report) });
    } catch (err) {
      if (abortRef.current !== signal) return;
      setError(err instanceof PeerTooOldError ? err.message : `The test failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (abortRef.current === signal) {
        setRunning(false);
        setStep(null);
      }
    }
  };

  const stop = (): void => {
    if (abortRef.current) abortRef.current.aborted = true;
  };

  const copy = async (): Promise<void> => {
    if (!result) return;
    const ok = await copyToClipboard(reportText(result.report, result.verdict));
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  };

  return (
    <section className="stream-doctor" aria-label="Stream doctor">
      <div className="sd-head">
        <div>
          <div className="sd-title">Stream doctor</div>
          <div className="sd-muted">Finds what slows down local-video streaming between you and one person.</div>
        </div>
      </div>

      <LiveCard snap={snap} />

      <div className="sd-card">
        <div className="sd-card-title">Test with</div>
        {peers.length === 0 ? (
          <p className="sd-muted">Nobody is connected yet.</p>
        ) : (
          <>
            <div className="sd-controls" data-peers={peersKey}>
              <select className="sd-select" value={peerId} disabled={running} onChange={(e) => setPicked(e.target.value)} aria-label="Person to test with">
                {peers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {running ? (
                <button type="button" className="btn btn-secondary" onClick={stop}>Stop</button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={run}>{result ? 'Run again' : 'Run test (1–2 min)'}</button>
              )}
            </div>
            <p className="sd-muted">
              Sends test data both ways at different settings and watches the ping meanwhile. Pausing the video first gives the cleanest numbers. Chat and play/pause can lag while it runs. Both of you need this version of the app.
            </p>
          </>
        )}
        {running && step && (
          <div className="sd-progress" role="status" aria-live="polite">
            <div className="sd-progress-track"><div className="sd-progress-fill" style={{ width: `${Math.round(step.fraction * 100)}%` }} /></div>
            <span>{step.label}…</span>
          </div>
        )}
        {error && <p className="sd-error" role="alert">{error}</p>}
      </div>

      {result && <Results report={result.report} verdict={result.verdict} onCopy={copy} copied={copied} />}
    </section>
  );
}
