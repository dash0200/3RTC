import React, { useState, useEffect } from 'react';
import { getNetworkHealthGrade, generateDiagnosticReport } from '../utils/networkMonitor';
import { copyToClipboard } from '../utils/clipboard';

export default function NetworkDiagnosticsModal({
  isOpen,
  onClose,
  networkStats = {},
  peersStats = [],
  roomId = '',
  username = '',
  onTriggerPing
}) {
  const [copied, setCopied] = useState(false);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const avgPing = networkStats.avgPingMs ?? null;
  const health = getNetworkHealthGrade(avgPing, networkStats.maxPacketLoss ?? 0);

  // Aggregated ping history for sparkline
  const combinedHistory = networkStats.pingHistory && networkStats.pingHistory.length > 0
    ? networkStats.pingHistory
    : peersStats[0]?.pingHistory || [];

  const handleCopyReport = async () => {
    const report = generateDiagnosticReport({
      roomId,
      username,
      summary: networkStats,
      peers: peersStats
    });
    const success = await copyToClipboard(report);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2200);
    }
  };

  // Sparkline SVG path generator
  const renderSparkline = (samples = [], width = 280, height = 48) => {
    if (!samples || samples.length < 2) {
      return (
        <div className="sparkline-empty">
          <span>Collecting latency samples...</span>
        </div>
      );
    }

    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const range = Math.max(10, max - min);
    const step = width / (samples.length - 1);

    const points = samples.map((val, idx) => {
      const x = idx * step;
      const y = height - ((val - min) / range) * (height - 12) - 6;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });

    const pathData = `M ${points.join(' L ')}`;
    const areaData = `M 0,${height} L ${points.join(' L ')} L ${width},${height} Z`;

    return (
      <svg className="sparkline-svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="pingGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.0" />
          </linearGradient>
        </defs>
        <path d={areaData} fill="url(#pingGrad)" />
        <path d={pathData} fill="none" stroke="#38bdf8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        {samples.map((val, idx) => {
          const x = idx * step;
          const y = height - ((val - min) / range) * (height - 12) - 6;
          return (
            <circle
              key={idx}
              cx={x}
              cy={y}
              r={idx === samples.length - 1 ? 3.5 : 2}
              fill={idx === samples.length - 1 ? '#00e676' : '#38bdf8'}
              stroke="#0f172a"
              strokeWidth="1"
            />
          );
        })}
      </svg>
    );
  };

  return (
    <div
      className="network-hud-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Real-Time WebRTC P2P Network HUD"
      onClick={onClose}
    >
      <div className="network-hud-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header Bar */}
        <div className="network-hud-header">
          <div className="hud-header-left">
            <div className="hud-icon-wrap">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                <path d="M12 3C6.95 3 3.1 4.85 1.13 5.8a1 1 0 0 0-.13 1.62l10.3 12.35a1 1 0 0 0 1.4 0L23 7.42a1 1 0 0 0-.13-1.62C20.9 4.85 17.05 3 12 3zm0 2c4.3 0 7.72 1.5 9.6 2.37L12 18.91 2.4 7.37C4.28 6.5 7.7 5 12 5z" />
              </svg>
            </div>
            <div>
              <div className="hud-title-row">
                <h2 className="hud-title">P2P Network Diagnostics HUD</h2>
                <span className="hud-p2p-badge" style={{ borderColor: `${health.color}55`, color: health.color }}>
                  <span className="hud-live-dot" style={{ background: health.color }} />
                  {health.label}
                </span>
              </div>
              <p className="hud-subtitle">Real-time WebRTC mesh telemetry, candidate pairs & sync metrics</p>
            </div>
          </div>

          <button
            type="button"
            className="hud-close-btn"
            onClick={onClose}
            title="Close Network HUD (Esc)"
            aria-label="Close Network HUD"
          >
            ✕
          </button>
        </div>

        {/* 4 Primary Metric Cards */}
        <div className="hud-metrics-grid">
          {/* Tile 1: Ping / Latency */}
          <div className="hud-stat-card">
            <div className="stat-card-header">
              <span className="stat-label">RTT LATENCY (PING)</span>
              <span className="stat-tag" style={{ color: health.color }}>
                {health.grade}
              </span>
            </div>
            <div className="stat-value-row">
              <span className="stat-main-value" style={{ color: health.color }}>
                {avgPing !== null ? avgPing : '--'}
              </span>
              <span className="stat-unit">ms</span>
            </div>
            <div className="stat-subtext">
              Min: <strong>{networkStats.minPingMs ?? '--'}ms</strong> • Max: <strong>{networkStats.maxPingMs ?? '--'}ms</strong>
            </div>
          </div>

          {/* Tile 2: Connection Mode */}
          <div className="hud-stat-card">
            <div className="stat-card-header">
              <span className="stat-label">CONNECTION MODE</span>
              <span className="stat-tag p2p-tag">DIRECT MESH</span>
            </div>
            <div className="stat-value-row">
              <span className="stat-main-value mode-value">
                {networkStats.overallConnectionType || 'Direct P2P'}
              </span>
            </div>
            <div className="stat-subtext">
              Zero Relay Servers • Full Mesh
            </div>
          </div>

          {/* Tile 3: Media Sync Drift */}
          <div className="hud-stat-card">
            <div className="stat-card-header">
              <span className="stat-label">PLAYBACK SYNC DRIFT</span>
              <span className="stat-tag">STRICT</span>
            </div>
            <div className="stat-value-row">
              <span className="stat-main-value drift-value">
                {networkStats.syncDriftMs !== undefined ? `±${networkStats.syncDriftMs}` : '<15'}
              </span>
              <span className="stat-unit">ms</span>
            </div>
            <div className="stat-subtext">
              {networkStats.syncDriftStatus || 'In Sync (Threshold: ±800ms)'}
            </div>
          </div>

          {/* Tile 4: Throughput */}
          <div className="hud-stat-card">
            <div className="stat-card-header">
              <span className="stat-label">NETWORK BANDWIDTH</span>
              <span className="stat-tag">LIVE</span>
            </div>
            <div className="stat-value-row">
              <span className="stat-main-value rate-value">
                ↓ {networkStats.totalDownloadKBps ?? 0}
              </span>
              <span className="stat-unit">KB/s</span>
            </div>
            <div className="stat-subtext">
              ↑ {networkStats.totalUploadKBps ?? 0} KB/s Outbound
            </div>
          </div>
        </div>

        {/* Latency History Graph */}
        <div className="hud-graph-section">
          <div className="graph-header">
            <div className="graph-title-group">
              <span className="graph-title">Rolling Latency Sparkline</span>
              <span className="graph-sub">Last 15 RTT Probe Samples</span>
            </div>
            {typeof onTriggerPing === 'function' && (
              <button
                type="button"
                className="btn-trigger-ping"
                onClick={onTriggerPing}
                title="Send instant DataChannel ping probe"
              >
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                  <path d="M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
                </svg>
                <span>Ping Now</span>
              </button>
            )}
          </div>
          <div className="graph-canvas-container">
            {renderSparkline(combinedHistory, 560, 60)}
          </div>
        </div>

        {/* Per-Peer Diagnostic Breakdown */}
        <div className="hud-peers-section">
          <div className="peers-section-header">
            <span className="peers-section-title">
              Connected Peers Telemetry ({peersStats.length})
            </span>
            <span className="peers-section-hint">Individual WebRTC PeerConnection stats</span>
          </div>

          {peersStats.length === 0 ? (
            <div className="peers-empty-state">
              <span>Waiting for room peers to connect direct P2P mesh...</span>
            </div>
          ) : (
            <div className="peers-cards-list">
              {peersStats.map((peer) => {
                const peerHealth = getNetworkHealthGrade(peer.pingMs, peer.packetLossPercent || 0);

                return (
                  <div key={peer.peerId} className="peer-stat-row">
                    <div className="peer-stat-header">
                      <div className="peer-id-info">
                        <span className="peer-name">{peer.username || peer.peerId.slice(0, 6)}</span>
                        <span className="peer-id-badge">ID: {peer.peerId.slice(0, 8)}</span>
                        <span className="peer-type-pill" style={{ color: peerHealth.color, borderColor: `${peerHealth.color}44` }}>
                          {peer.connectionType || 'Direct P2P'}
                        </span>
                      </div>
                      <div className="peer-rtt-badge" style={{ color: peerHealth.color }}>
                        <span className="rtt-dot" style={{ background: peerHealth.color }} />
                        <span>{peer.pingMs !== null ? `${peer.pingMs} ms` : 'Probing...'}</span>
                      </div>
                    </div>

                    <div className="peer-details-grid">
                      <div className="peer-detail-cell">
                        <span className="detail-name">Packet Loss:</span>
                        <span className="detail-value">{peer.packetLossPercent ?? 0}%</span>
                      </div>
                      <div className="peer-detail-cell">
                        <span className="detail-name">Audio Jitter:</span>
                        <span className="detail-value">{peer.jitterMs ?? 0} ms</span>
                      </div>
                      <div className="peer-detail-cell">
                        <span className="detail-name">Protocol:</span>
                        <span className="detail-value">{peer.protocol || 'UDP'}</span>
                      </div>
                      <div className="peer-detail-cell">
                        <span className="detail-name">Data Rate:</span>
                        <span className="detail-value">
                          ↓ {peer.downloadKBps ?? 0} KB/s  ↑ {peer.uploadKBps ?? 0} KB/s
                        </span>
                      </div>
                    </div>

                    {peer.candidatePair && (
                      <div className="peer-candidates-bar">
                        <span className="cand-label">ICE Pair:</span>
                        <span className="cand-tag local">Local: {peer.candidatePair.localType}</span>
                        <span className="cand-arrow">↔</span>
                        <span className="cand-tag remote">Remote: {peer.candidatePair.remoteType}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="hud-footer">
          <button
            type="button"
            className={`btn-hud-copy ${copied ? 'copied' : ''}`}
            onClick={handleCopyReport}
            title="Copy full diagnostic markdown report to clipboard"
          >
            {copied ? (
              <>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                  <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                </svg>
                <span>Report Copied!</span>
              </>
            ) : (
              <>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                  <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
                </svg>
                <span>Copy Diagnostic Report</span>
              </>
            )}
          </button>

          <button
            type="button"
            className="btn-hud-done"
            onClick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
