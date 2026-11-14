import { useState, useMemo, type ReactElement } from 'react';
import type { PeerNetworkStatsRecord } from '../hooks/useNetworkStats';
import {
  calculateTechnicalDistance,
  type TopologyDistanceMatrix,
  type TechnicalDistanceEvaluation
} from '../hooks/useNetworkStats';
import type { PeerLinkMetric } from '../types/protocol';

export interface NetworkTopologyMapProps {
  hostPeerId?: string | null;
  myPeerId: string;
  username: string;
  peerMetadata: Record<string, { username?: string; isMuted?: boolean; client?: string }>;
  peersStats: PeerNetworkStatsRecord[];
  topologyMatrix: TopologyDistanceMatrix;
  topology?: 'mesh' | 'hub';
  isHost?: boolean;
  onSwitchTopology?: (topology: 'mesh' | 'hub') => void;
}

type ViewMode = 'graph' | 'radar' | 'matrix';
type CenterPerspective = 'host' | 'me';

interface NodeInfo {
  id: string;
  name: string;
  isHost: boolean;
  isMe: boolean;
  client?: string;
  x: number;
  y: number;
}

interface EdgeInfo {
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  metric: PeerLinkMetric;
  eval: TechnicalDistanceEvaluation;
}

export default function NetworkTopologyMap({
  hostPeerId,
  myPeerId,
  username,
  peerMetadata,
  peersStats,
  topologyMatrix,
  topology = 'mesh',
  isHost = false,
  onSwitchTopology
}: NetworkTopologyMapProps): ReactElement {
  const [viewMode, setViewMode] = useState<ViewMode>('graph');
  const [perspective, setPerspective] = useState<CenterPerspective>('host');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<EdgeInfo | null>(null);

  // Compile full list of unique participants
  const participants = useMemo(() => {
    const set = new Set<string>();
    if (myPeerId) set.add(myPeerId);
    if (hostPeerId) set.add(hostPeerId);
    for (const p of peersStats) {
      if (p.peerId) set.add(p.peerId);
    }
    for (const fromId of Object.keys(topologyMatrix)) {
      set.add(fromId);
      for (const toId of Object.keys(topologyMatrix[fromId] || {})) {
        set.add(toId);
      }
    }
    return Array.from(set);
  }, [myPeerId, hostPeerId, peersStats, topologyMatrix]);

  const getName = (id: string): string => {
    if (id === myPeerId) return `${username} (You)`;
    return peerMetadata[id]?.username || `Peer ${id.slice(0, 4)}`;
  };

  // Compile all unique bidirectional edges
  const edges = useMemo(() => {
    const list: EdgeInfo[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        const a = participants[i];
        const b = participants[j];

        // In hub mode, non-hosts do not connect to non-hosts
        if (topology === 'hub' && hostPeerId && a !== hostPeerId && b !== hostPeerId) {
          continue;
        }

        // Try getting metric from a -> b or b -> a
        const metricAB = topologyMatrix[a]?.[b];
        const metricBA = topologyMatrix[b]?.[a];

        let metric: PeerLinkMetric | null = null;
        if (metricAB && metricBA) {
          // Average the bidirectional measurements
          metric = {
            rttMs: Math.round((metricAB.rttMs + metricBA.rttMs) / 2),
            candidateType: metricAB.candidateType === 'relay' || metricBA.candidateType === 'relay'
              ? 'relay'
              : metricAB.candidateType === 'host' && metricBA.candidateType === 'host'
                ? 'host'
                : 'srflx',
            lossPct: Math.round(((metricAB.lossPct + metricBA.lossPct) / 2) * 10) / 10,
            jitterMs: Math.round(((metricAB.jitterMs + metricBA.jitterMs) / 2) * 10) / 10,
            downloadKBps: (metricAB.downloadKBps || 0) + (metricBA.downloadKBps || 0),
            uploadKBps: (metricAB.uploadKBps || 0) + (metricBA.uploadKBps || 0)
          };
        } else if (metricAB) {
          metric = metricAB;
        } else if (metricBA) {
          metric = metricBA;
        } else if (a === myPeerId || b === myPeerId) {
          // Fallback to local peerStatsRecord if available
          const otherId = a === myPeerId ? b : a;
          const stat = peersStats.find((p) => p.peerId === otherId);
          if (stat && stat.pingMs !== null) {
            const isLan = stat.candidatePair?.localType === 'host' && stat.candidatePair?.remoteType === 'host';
            const isRelay = stat.connectionType.includes('Relay');
            metric = {
              rttMs: stat.pingMs,
              candidateType: isRelay ? 'relay' : isLan ? 'host' : 'srflx',
              lossPct: stat.packetLossPercent || 0,
              jitterMs: stat.jitterMs || 0,
              downloadKBps: stat.downloadKBps,
              uploadKBps: stat.uploadKBps
            };
          }
        }

        if (metric) {
          const key = [a, b].sort().join('--');
          if (!seen.has(key)) {
            seen.add(key);
            list.push({
              fromId: a,
              toId: b,
              fromName: getName(a),
              toName: getName(b),
              metric,
              eval: calculateTechnicalDistance(metric)
            });
          }
        }
      }
    }
    return list;
  }, [participants, topology, hostPeerId, topologyMatrix, myPeerId, peersStats, username, peerMetadata]);

  // Layout node coordinates for SVG graph view
  const nodes = useMemo((): NodeInfo[] => {
    const count = participants.length;
    const cx = 320;
    const cy = 200;
    const radius = 140;

    if (count <= 1) {
      return [{
        id: myPeerId,
        name: getName(myPeerId),
        isHost: Boolean(isHost || myPeerId === hostPeerId),
        isMe: true,
        client: 'desktop',
        x: cx,
        y: cy
      }];
    }

    // In hub mode or when host exists, place Host at center for Hub topology
    if (topology === 'hub' && hostPeerId) {
      const result: NodeInfo[] = [];
      const guests = participants.filter((p) => p !== hostPeerId);
      result.push({
        id: hostPeerId,
        name: getName(hostPeerId),
        isHost: true,
        isMe: hostPeerId === myPeerId,
        client: peerMetadata[hostPeerId]?.client,
        x: cx,
        y: cy
      });

      guests.forEach((id, idx) => {
        const angle = (idx * 2 * Math.PI) / guests.length - Math.PI / 2;
        result.push({
          id,
          name: getName(id),
          isHost: false,
          isMe: id === myPeerId,
          client: peerMetadata[id]?.client,
          x: Math.round(cx + radius * Math.cos(angle)),
          y: Math.round(cy + radius * Math.sin(angle))
        });
      });
      return result;
    }

    // Full Mesh: Circular arrangement around center
    return participants.map((id, idx) => {
      const angle = (idx * 2 * Math.PI) / count - Math.PI / 2;
      return {
        id,
        name: getName(id),
        isHost: id === hostPeerId,
        isMe: id === myPeerId,
        client: peerMetadata[id]?.client,
        x: Math.round(cx + radius * Math.cos(angle)),
        y: Math.round(cy + radius * Math.sin(angle))
      };
    });
  }, [participants, myPeerId, hostPeerId, isHost, topology, peerMetadata, username]);

  // Node positions map for quick lookup
  const nodeMap = useMemo(() => {
    const map = new Map<string, NodeInfo>();
    for (const n of nodes) map.set(n.id, n);
    return map;
  }, [nodes]);

  // Radar View calculations: Concentric rings based on Technical Distance
  const radarCenterId = perspective === 'host' && hostPeerId ? hostPeerId : myPeerId;
  const radarNodes = useMemo(() => {
    const cx = 320;
    const cy = 200;
    const maxR = 150;

    const peers = participants.filter((id) => id !== radarCenterId);
    return peers.map((id, idx) => {
      // Find edge between radarCenterId and this peer
      const edge = edges.find(
        (e) => (e.fromId === radarCenterId && e.toId === id) || (e.toId === radarCenterId && e.fromId === id)
      );

      const score = edge ? edge.eval.score : 60;
      // Map technical score (0..300) to radial distance (25..maxR)
      const r = Math.min(maxR, Math.max(30, (score / 250) * maxR));
      const angle = (idx * 2 * Math.PI) / Math.max(1, peers.length) - Math.PI / 2;

      return {
        id,
        name: getName(id),
        isHost: id === hostPeerId,
        isMe: id === myPeerId,
        score,
        edge,
        eval: edge?.eval || calculateTechnicalDistance({ rttMs: score, candidateType: 'srflx', lossPct: 0, jitterMs: 0 }),
        x: Math.round(cx + r * Math.cos(angle)),
        y: Math.round(cy + r * Math.sin(angle))
      };
    });
  }, [participants, radarCenterId, edges, hostPeerId, myPeerId, username, peerMetadata]);

  return (
    <div className="topology-map-container" style={{ padding: '16px', background: '#090d16', borderRadius: '12px', border: '1px solid #1e293b' }}>
      {/* Top Header & Mode Bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px', flexWrap: 'wrap', gap: '8px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '15px', fontWeight: 700, color: '#f8fafc', letterSpacing: '0.02em' }}>
              NETWORK TOPOLOGY & TECHNICAL DISTANCE MAP
            </span>
            <span
              style={{
                fontSize: '11px',
                padding: '2px 8px',
                borderRadius: '12px',
                background: topology === 'hub' ? '#7c3aed22' : '#0284c722',
                color: topology === 'hub' ? '#c084fc' : '#38bdf8',
                border: `1px solid ${topology === 'hub' ? '#a855f755' : '#0ea5e955'}`,
                fontWeight: 600
              }}
            >
              {topology === 'hub' ? '⭐ Host Hub Topology' : '🕸️ Full Mesh Topology'}
            </span>
          </div>
          <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>
            Real-time peer technical distance computed from RTT latency, packet loss, audio jitter & ICE candidate path
          </div>
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          {/* View mode toggle */}
          <div style={{ display: 'flex', background: '#0f172a', padding: '2px', borderRadius: '8px', border: '1px solid #334155' }}>
            <button
              type="button"
              onClick={() => setViewMode('graph')}
              style={{
                background: viewMode === 'graph' ? '#1e293b' : 'transparent',
                color: viewMode === 'graph' ? '#38bdf8' : '#94a3b8',
                border: 'none',
                padding: '4px 10px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              🕸️ Topology Graph
            </button>
            <button
              type="button"
              onClick={() => setViewMode('radar')}
              style={{
                background: viewMode === 'radar' ? '#1e293b' : 'transparent',
                color: viewMode === 'radar' ? '#38bdf8' : '#94a3b8',
                border: 'none',
                padding: '4px 10px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              🎯 Distance Radar
            </button>
            <button
              type="button"
              onClick={() => setViewMode('matrix')}
              style={{
                background: viewMode === 'matrix' ? '#1e293b' : 'transparent',
                color: viewMode === 'matrix' ? '#38bdf8' : '#94a3b8',
                border: 'none',
                padding: '4px 10px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              📊 Distance Matrix
            </button>
          </div>

          {/* Hub/Mesh switcher for host */}
          {isHost && onSwitchTopology && (
            <button
              type="button"
              onClick={() => onSwitchTopology(topology === 'mesh' ? 'hub' : 'mesh')}
              title="Toggle between Full P2P Mesh and Host Hub star routing"
              style={{
                background: topology === 'mesh' ? '#0f172a' : '#581c87',
                color: '#f8fafc',
                border: '1px solid #475569',
                padding: '4px 10px',
                borderRadius: '6px',
                fontSize: '11px',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Switch to {topology === 'mesh' ? '⭐ Host Hub' : '🕸️ Full Mesh'}
            </button>
          )}
        </div>
      </div>

      {/* Perspective switcher (for Radar view) */}
      {viewMode === 'radar' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', fontSize: '12px', color: '#cbd5e1' }}>
          <span>Radar Center Perspective:</span>
          <button
            type="button"
            onClick={() => setPerspective('host')}
            style={{
              background: perspective === 'host' ? '#0369a1' : '#1e293b',
              color: '#f8fafc',
              border: 'none',
              padding: '2px 8px',
              borderRadius: '4px',
              fontSize: '11px',
              cursor: 'pointer'
            }}
          >
            👑 Host Perspective
          </button>
          <button
            type="button"
            onClick={() => setPerspective('me')}
            style={{
              background: perspective === 'me' ? '#0369a1' : '#1e293b',
              color: '#f8fafc',
              border: 'none',
              padding: '2px 8px',
              borderRadius: '4px',
              fontSize: '11px',
              cursor: 'pointer'
            }}
          >
            👤 My Perspective
          </button>
        </div>
      )}

      {/* VIEW 1: TOPOLOGY GRAPH */}
      {viewMode === 'graph' && (
        <div style={{ position: 'relative', width: '100%', height: '400px', background: '#020617', borderRadius: '8px', overflow: 'hidden', border: '1px solid #1e293b' }}>
          <svg width="100%" height="100%" viewBox="0 0 640 400" preserveAspectRatio="xMidYMid meet">
            <defs>
              {/* Glow filter for LAN lines */}
              <filter id="lanGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="3" result="blur" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Background grid */}
            <pattern id="topoGrid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" strokeWidth="0.5" strokeOpacity="0.4" />
            </pattern>
            <rect width="640" height="400" fill="url(#topoGrid)" />

            {/* Connection Edges */}
            {edges.map((e, idx) => {
              const from = nodeMap.get(e.fromId);
              const to = nodeMap.get(e.toId);
              if (!from || !to) return null;

              const isSelected = selectedEdge === e;
              const isLan = e.metric.candidateType === 'host';
              const isRelay = e.metric.candidateType === 'relay';
              const strokeColor = isLan ? '#00e676' : isRelay ? '#f97316' : '#38bdf8';
              const strokeDash = isRelay ? '4,4' : isLan ? 'none' : 'none';
              const midX = (from.x + to.x) / 2;
              const midY = (from.y + to.y) / 2;

              return (
                <g key={`edge-${idx}`} style={{ cursor: 'pointer' }} onClick={() => setSelectedEdge(e)}>
                  {/* Outer glow line */}
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={strokeColor}
                    strokeWidth={isSelected ? 5 : isLan ? 3 : 2}
                    strokeDasharray={strokeDash}
                    strokeOpacity={isSelected ? 1 : 0.75}
                    filter={isLan ? 'url(#lanGlow)' : undefined}
                  />

                  {/* Midpoint Latency / Distance Pill */}
                  <rect
                    x={midX - 32}
                    y={midY - 10}
                    width={64}
                    height={20}
                    rx={10}
                    fill="#0f172a"
                    stroke={strokeColor}
                    strokeWidth="1.2"
                  />
                  <text
                    x={midX}
                    y={midY + 3.5}
                    textAnchor="middle"
                    fill={strokeColor}
                    fontSize="10"
                    fontWeight="700"
                    fontFamily="monospace"
                  >
                    {isLan ? '⚡ ' : ''}{e.metric.rttMs}ms
                  </text>
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map((n) => {
              const isSelected = selectedNodeId === n.id;
              const borderCol = n.isHost ? '#f59e0b' : n.isMe ? '#38bdf8' : '#64748b';

              return (
                <g
                  key={n.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelectedNodeId(n.id === selectedNodeId ? null : n.id)}
                >
                  {/* Outer circle halo */}
                  <circle
                    cx={n.x}
                    cy={n.y}
                    r={isSelected ? 26 : 22}
                    fill="#090d16"
                    stroke={borderCol}
                    strokeWidth={isSelected ? 3 : 2}
                  />

                  {/* Node icon or initial */}
                  <text
                    x={n.x}
                    y={n.y + 5}
                    textAnchor="middle"
                    fill="#f8fafc"
                    fontSize="13"
                    fontWeight="700"
                  >
                    {n.isHost ? '👑' : n.name.charAt(0).toUpperCase()}
                  </text>

                  {/* Node Label underneath */}
                  <rect
                    x={n.x - 48}
                    y={n.y + 27}
                    width={96}
                    height={18}
                    rx={4}
                    fill="#0b1329dd"
                    stroke={borderCol}
                    strokeWidth="0.8"
                  />
                  <text
                    x={n.x}
                    y={n.y + 39}
                    textAnchor="middle"
                    fill="#f1f5f9"
                    fontSize="10"
                    fontWeight="600"
                  >
                    {n.name.length > 14 ? `${n.name.slice(0, 12)}…` : n.name}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Legend Overlay */}
          <div style={{ position: 'absolute', bottom: '8px', left: '10px', display: 'flex', gap: '12px', background: '#0b1329dd', padding: '6px 10px', borderRadius: '6px', fontSize: '10px', color: '#cbd5e1' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '12px', height: '3px', background: '#00e676', display: 'inline-block' }} /> ⚡ LAN Direct (Closest)
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '12px', height: '3px', background: '#38bdf8', display: 'inline-block' }} /> 🌐 Direct P2P (STUN)
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ width: '12px', height: '3px', background: '#f97316', borderBottom: '2px dotted #f97316', display: 'inline-block' }} /> 🔄 TURN Relay
            </span>
          </div>
        </div>
      )}

      {/* VIEW 2: DISTANCE RADAR */}
      {viewMode === 'radar' && (
        <div style={{ position: 'relative', width: '100%', height: '400px', background: '#020617', borderRadius: '8px', overflow: 'hidden', border: '1px solid #1e293b' }}>
          <svg width="100%" height="100%" viewBox="0 0 640 400" preserveAspectRatio="xMidYMid meet">
            <defs>
              <radialGradient id="radarSweep" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#0ea5e9" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#0ea5e9" stopOpacity="0.02" />
              </radialGradient>
            </defs>

            {/* Concentric Distance Rings */}
            <circle cx="320" cy="200" r="30" fill="url(#radarSweep)" stroke="#00e676" strokeWidth="1" strokeDasharray="3,3" />
            <circle cx="320" cy="200" r="60" fill="none" stroke="#10b981" strokeWidth="0.8" strokeDasharray="4,4" />
            <circle cx="320" cy="200" r="95" fill="none" stroke="#f59e0b" strokeWidth="0.8" strokeDasharray="4,4" />
            <circle cx="320" cy="200" r="130" fill="none" stroke="#f97316" strokeWidth="0.8" strokeDasharray="4,4" />
            <circle cx="320" cy="200" r="160" fill="none" stroke="#ef4444" strokeWidth="0.8" strokeDasharray="4,4" />

            {/* Radial labels */}
            <text x="325" y="172" fill="#00e676" fontSize="9" fontWeight="700">⚡ LAN (&lt;15ms)</text>
            <text x="325" y="142" fill="#10b981" fontSize="9" fontWeight="700">🟢 Near (15-50ms)</text>
            <text x="325" y="108" fill="#f59e0b" fontSize="9" fontWeight="700">🟡 Medium (50-120ms)</text>
            <text x="325" y="73" fill="#f97316" fontSize="9" fontWeight="700">🟠 Far (120-250ms)</text>
            <text x="325" y="44" fill="#ef4444" fontSize="9" fontWeight="700">🔴 Distant / Relay (&gt;250ms)</text>

            {/* Center Reference Node */}
            <circle cx="320" cy="200" r="18" fill="#0f172a" stroke="#38bdf8" strokeWidth="2.5" />
            <text x="320" y="204" textAnchor="middle" fill="#38bdf8" fontSize="12" fontWeight="700">
              {perspective === 'host' ? '👑' : '👤'}
            </text>
            <text x="320" y="228" textAnchor="middle" fill="#93c5fd" fontSize="10" fontWeight="600">
              Center: {perspective === 'host' ? 'Host' : 'You'}
            </text>

            {/* Peripheral Radar Nodes */}
            {radarNodes.map((n) => {
              const col = n.eval.color;
              return (
                <g key={n.id} style={{ cursor: 'pointer' }}>
                  {/* Radial line to center */}
                  <line x1="320" y1="200" x2={n.x} y2={n.y} stroke={col} strokeWidth="1" strokeOpacity="0.4" strokeDasharray="2,2" />

                  {/* Node Circle */}
                  <circle cx={n.x} cy={n.y} r="14" fill="#0b1329" stroke={col} strokeWidth="2" />
                  <text x={n.x} y={n.y + 4} textAnchor="middle" fill="#f8fafc" fontSize="10" fontWeight="700">
                    {n.isHost ? '👑' : n.name.charAt(0).toUpperCase()}
                  </text>

                  {/* Badge */}
                  <rect x={n.x - 36} y={n.y + 16} width="72" height="15" rx="3" fill="#020617ee" stroke={col} strokeWidth="0.8" />
                  <text x={n.x} y={n.y + 27} textAnchor="middle" fill={col} fontSize="9" fontWeight="700">
                    {n.eval.score} (dist)
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* VIEW 3: PAIRWISE TECHNICAL DISTANCE MATRIX */}
      {viewMode === 'matrix' && (
        <div style={{ maxHeight: '380px', overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px', color: '#f1f5f9' }}>
            <thead>
              <tr style={{ background: '#0f172a', borderBottom: '1px solid #334155', textAlign: 'left' }}>
                <th style={{ padding: '8px 12px' }}>Peer Pair</th>
                <th style={{ padding: '8px 12px' }}>Connection Path</th>
                <th style={{ padding: '8px 12px' }}>Measured Latency</th>
                <th style={{ padding: '8px 12px' }}>Jitter / Loss</th>
                <th style={{ padding: '8px 12px' }}>Technical Distance</th>
                <th style={{ padding: '8px 12px' }}>Proximity Tier</th>
              </tr>
            </thead>
            <tbody>
              {edges.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: '24px', textAlign: 'center', color: '#94a3b8' }}>
                    No peer connections established yet. Share room code with others to view technical distances.
                  </td>
                </tr>
              ) : (
                edges.map((e, idx) => (
                  <tr
                    key={idx}
                    style={{
                      borderBottom: '1px solid #1e293b',
                      background: idx % 2 === 0 ? '#0b1329' : 'transparent'
                    }}
                  >
                    <td style={{ padding: '8px 12px', fontWeight: 600 }}>
                      <span style={{ color: '#38bdf8' }}>{e.fromName}</span>
                      <span style={{ color: '#64748b', margin: '0 6px' }}>↔</span>
                      <span style={{ color: '#38bdf8' }}>{e.toName}</span>
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <span
                        style={{
                          padding: '2px 6px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          background: `${e.eval.color}22`,
                          color: e.eval.color,
                          border: `1px solid ${e.eval.color}44`
                        }}
                      >
                        {e.metric.candidateType === 'host' ? '⚡ LAN Direct' : e.metric.candidateType === 'relay' ? '🔄 TURN Relay' : '🌐 Direct P2P'}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', color: e.eval.color, fontWeight: 700 }}>
                      {e.metric.rttMs} ms
                    </td>
                    <td style={{ padding: '8px 12px', color: '#94a3b8', fontSize: '11px' }}>
                      {e.metric.jitterMs}ms jitter • {e.metric.lossPct}% loss
                    </td>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontWeight: 700 }}>
                      Score: {e.eval.score}
                    </td>
                    <td style={{ padding: '8px 12px', color: e.eval.color, fontWeight: 600 }}>
                      {e.eval.tierLabel}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Selected Edge or Node detail popover */}
      {selectedEdge && (
        <div style={{ marginTop: '12px', padding: '10px 14px', background: '#0f172a', borderRadius: '8px', border: `1px solid ${selectedEdge.eval.color}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span style={{ fontWeight: 700, color: '#f8fafc' }}>
              Link Details: {selectedEdge.fromName} ↔ {selectedEdge.toName}
            </span>
            <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '2px' }}>
              Ping: <strong style={{ color: selectedEdge.eval.color }}>{selectedEdge.metric.rttMs} ms</strong> • Path:{' '}
              <strong>{selectedEdge.metric.candidateType}</strong> • Technical Distance Score:{' '}
              <strong style={{ color: selectedEdge.eval.color }}>{selectedEdge.eval.score}</strong> ({selectedEdge.eval.tierLabel})
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSelectedEdge(null)}
            style={{ background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', fontSize: '14px' }}
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
