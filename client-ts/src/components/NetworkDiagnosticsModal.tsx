import { useState, useEffect, type ReactNode } from 'react';
import { getNetworkHealthGrade, generateDiagnosticReport } from '../utils/networkMonitor';
import { evaluateBandwidthAdvisor } from '../utils/bandwidthAdvisor';
import { copyToClipboard } from '../utils/clipboard';
import type { NetworkStatsSummary, PeerNetworkStatsRecord, TopologyDistanceMatrix } from '../hooks/useNetworkStats';
import NetworkTopologyMap from './NetworkTopologyMap';

export interface NetworkDiagnosticsModalProps {
  isOpen: boolean;
  onClose: () => void;
  networkStats?: Partial<NetworkStatsSummary>;
  peersStats?: PeerNetworkStatsRecord[];
  roomId?: string | null;
  username?: string;
  onTriggerPing?: () => void;
  hostPeerId?: string | null;
  myPeerId?: string;
  peerMetadata?: Record<string, { username?: string; isMuted?: boolean; client?: string }>;
  topologyMatrix?: TopologyDistanceMatrix;
  topology?: 'mesh' | 'hub';
  isHost?: boolean;
  onSwitchTopology?: (topology: 'mesh' | 'hub') => void;
  maxUsers?: number;
  onSetMaxUsers?: (limit: number) => void;
  /** extra panels at the end (the Stream doctor) */
  children?: ReactNode;
}

export default function NetworkDiagnosticsModal({
  isOpen,
  onClose,
  networkStats = {},
  peersStats = [],
  roomId = '',
  username = '',
  onTriggerPing,
  hostPeerId,
  myPeerId = '',
  peerMetadata = {},
  topologyMatrix = {},
  topology = 'mesh',
  isHost = false,
  onSwitchTopology,
  maxUsers = 32,
  onSetMaxUsers,
  children
}: NetworkDiagnosticsModalProps) {
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'hud' | 'topology'>('hud');

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const avgPing = networkStats.avgPingMs ?? null;
  const health = getNetworkHealthGrade(avgPing, networkStats.maxPacketLoss ?? 0);
  const advisor = evaluateBandwidthAdvisor({
    totalDownloadKBps: networkStats.totalDownloadKBps || 0,
    totalUploadKBps: networkStats.totalUploadKBps || 0,
    activePeerCount: peersStats.length + 1,
    currentTopology: topology,
    isHost
  });

  // Aggregated ping history for sparkline
  const combinedHistory =
    networkStats.pingHistory && networkStats.pingHistory.length > 0
      ? networkStats.pingHistory
      : peersStats[0]?.pingHistory || [];

  const handleCopyReport = async () => {
    const report = generateDiagnosticReport({
      roomId: roomId || undefined,
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
  const renderSparkline = (samples: number[] = [], width = 280, height = 48) => {
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
        <path
          d={pathData}
          fill="none"
          stroke="#38bdf8"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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
                <span
                  className="hud-p2p-badge"
                  style={{ borderColor: `${health.color}55`, color: health.color }}
                >
                  <span className="hud-live-dot" style={{ background: health.color }} />
                  {health.label}
                </span>
              </div>
              <p className="hud-subtitle">
                Real-time WebRTC mesh telemetry, candidate pairs & sync metrics
              </p>
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

        {/* Navigation Tabs */}
        <div style={{ display: 'flex', gap: '8px', padding: '0 20px', borderBottom: '1px solid #1e293b', marginBottom: '16px' }}>
          <button
            type="button"
            onClick={() => setActiveTab('hud')}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'hud' ? '2px solid #38bdf8' : '2px solid transparent',
              color: activeTab === 'hud' ? '#38bdf8' : '#94a3b8',
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            📊 Telemetry HUD
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('topology')}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === 'topology' ? '2px solid #38bdf8' : '2px solid transparent',
              color: activeTab === 'topology' ? '#38bdf8' : '#94a3b8',
              padding: '8px 16px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            🗺️ Topology & Technical Distance Map
          </button>
        </div>

        {activeTab === 'topology' ? (
          <NetworkTopologyMap
            hostPeerId={hostPeerId}
            myPeerId={myPeerId}
            username={username}
            peerMetadata={peerMetadata}
            peersStats={peersStats}
            topologyMatrix={topologyMatrix}
            topology={topology}
            isHost={isHost}
            onSwitchTopology={onSwitchTopology}
          />
        ) : (
          <>
            {/* Room Capacity & Live Bandwidth Advisor */}
            <div
              className="hud-advisor-card"
              style={{
                background: 'linear-gradient(135deg, rgba(30, 41, 59, 0.8) 0%, rgba(15, 23, 42, 0.95) 100%)',
                border: '1px solid #334155',
                borderRadius: '12px',
                padding: '16px',
                marginBottom: '16px',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc' }}>
                    ⚡ Room Peer Capacity & Dynamic Advisor
                  </span>
                  <span
                    style={{
                      background: topology === 'hub' ? '#581c87' : '#0369a1',
                      color: '#f8fafc',
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: '12px'
                    }}
                  >
                    {topology === 'hub' ? '⭐ Host Hub Mode' : '🕸️ Full Mesh'}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '13px', color: '#94a3b8' }}>
                  <span>
                    ⬇️ Avg Down: <strong style={{ color: '#38bdf8' }}>{advisor.avgDownloadMbps} Mbps</strong>
                  </span>
                  <span>
                    ⬆️ Avg Up: <strong style={{ color: '#34d399' }}>{advisor.avgUploadMbps} Mbps</strong>
                  </span>
                </div>
              </div>

              {/* Dynamic Capacity Controls */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '12px',
                  background: 'rgba(15, 23, 42, 0.6)',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid #1e293b'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: '#e2e8f0' }}>Max Room Peers:</span>
                  {isHost && onSetMaxUsers ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <button
                        type="button"
                        onClick={() => onSetMaxUsers(Math.max(2, maxUsers - 1))}
                        style={{
                          background: '#334155',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          width: '28px',
                          height: '28px',
                          cursor: 'pointer',
                          fontWeight: 'bold',
                          fontSize: '14px'
                        }}
                        title="Decrease room limit"
                      >
                        -
                      </button>
                      <input
                        type="number"
                        min="2"
                        max="200"
                        value={maxUsers}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          if (!isNaN(val) && val >= 2) onSetMaxUsers(val);
                        }}
                        style={{
                          width: '56px',
                          textAlign: 'center',
                          background: '#0f172a',
                          border: '1px solid #475569',
                          borderRadius: '4px',
                          color: '#38bdf8',
                          fontWeight: 700,
                          fontSize: '14px',
                          padding: '4px'
                        }}
                        title="Enter any custom peer limit (uncapped)"
                      />
                      <button
                        type="button"
                        onClick={() => onSetMaxUsers(maxUsers + 1)}
                        style={{
                          background: '#334155',
                          color: '#fff',
                          border: 'none',
                          borderRadius: '4px',
                          width: '28px',
                          height: '28px',
                          cursor: 'pointer',
                          fontWeight: 'bold',
                          fontSize: '14px'
                        }}
                        title="Increase room limit"
                      >
                        +
                      </button>

                      {/* Quick presets */}
                      <span style={{ fontSize: '11px', color: '#64748b', marginLeft: '6px' }}>Presets:</span>
                      {[4, 8, 12, 16, 24, 32, 50].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => onSetMaxUsers(preset)}
                          style={{
                            background: maxUsers === preset ? '#0284c7' : '#1e293b',
                            color: maxUsers === preset ? '#fff' : '#94a3b8',
                            border: '1px solid #334155',
                            borderRadius: '4px',
                            padding: '2px 8px',
                            fontSize: '11px',
                            fontWeight: 600,
                            cursor: 'pointer'
                          }}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span style={{ fontSize: '13px', fontWeight: 700, color: '#38bdf8' }}>
                      {maxUsers} peers {isHost ? '' : '(Host managed)'}
                    </span>
                  )}
                </div>

                {isHost && onSetMaxUsers && maxUsers !== advisor.recommendedPeers && (
                  <button
                    type="button"
                    onClick={() => onSetMaxUsers(advisor.recommendedPeers)}
                    style={{
                      background: 'linear-gradient(90deg, #0284c7 0%, #2563eb 100%)',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                    title="Apply recommended room peer count"
                  >
                    Apply Recommended: {advisor.recommendedPeers} Peers
                  </button>
                )}
              </div>

              {/* Bandwidth Suggestion Line */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: 'rgba(56, 189, 248, 0.08)',
                  border: '1px solid rgba(56, 189, 248, 0.25)',
                  borderRadius: '8px',
                  padding: '8px 12px',
                  fontSize: '12.5px',
                  color: '#e0f2fe'
                }}
              >
                <span>💡 {advisor.suggestionText}</span>
                {isHost && onSwitchTopology && topology === 'mesh' && advisor.recommendedTopology === 'hub' && (
                  <button
                    type="button"
                    onClick={() => onSwitchTopology('hub')}
                    style={{
                      background: '#581c87',
                      color: '#f8fafc',
                      border: '1px solid #a855f7',
                      borderRadius: '4px',
                      padding: '3px 8px',
                      fontSize: '11px',
                      fontWeight: 600,
                      cursor: 'pointer',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    Switch to Hub Mode
                  </button>
                )}
              </div>
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
              Min: <strong>{networkStats.minPingMs ?? '--'}ms</strong> • Max:{' '}
              <strong>{networkStats.maxPingMs ?? '--'}ms</strong>
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
            <div className="stat-subtext">Zero Relay Servers • Full Mesh</div>
          </div>

          {/* Tile 3: Media Sync Drift */}
          <div className="hud-stat-card">
            <div className="stat-card-header">
              <span className="stat-label">PLAYBACK SYNC DRIFT</span>
              {networkStats.syncDriftMs !== undefined && <span className="stat-tag">STRICT</span>}
            </div>
            <div className="stat-value-row">
              <span className="stat-main-value drift-value">
                {networkStats.syncDriftMs !== undefined ? `±${networkStats.syncDriftMs}` : '—'}
              </span>
              {networkStats.syncDriftMs !== undefined && <span className="stat-unit">ms</span>}
            </div>
            <div className="stat-subtext">
              {networkStats.syncDriftStatus || 'No video playing'}
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
          <div className="graph-canvas-container">{renderSparkline(combinedHistory, 560, 60)}</div>
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
                        <span className="peer-name">
                          {peer.username || peer.peerId.slice(0, 6)}
                        </span>
                        <span className="peer-id-badge">ID: {peer.peerId.slice(0, 8)}</span>
                        <span
                          className="peer-type-pill"
                          style={{
                            color: peerHealth.color,
                            borderColor: `${peerHealth.color}44`
                          }}
                        >
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
                          ↓ {peer.downloadKBps ?? 0} KB/s ↑ {peer.uploadKBps ?? 0} KB/s
                        </span>
                      </div>
                    </div>

                    {peer.candidatePair && (
                      <div className="peer-candidates-bar">
                        <span className="cand-label">ICE Pair:</span>
                        <span className="cand-tag local">Local: {peer.candidatePair.localType}</span>
                        <span className="cand-arrow">↔</span>
                        <span className="cand-tag remote">
                          Remote: {peer.candidatePair.remoteType}
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        </>
        )}

        {children}

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

          <button type="button" className="btn-hud-done" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
