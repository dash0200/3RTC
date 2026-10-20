/**
 * Stream doctor: live streaming numbers (telemetry.ts), a test with one peer (speedTest.ts),
 * findings (verdict.ts) and its panel in the Network HUD (StreamDoctor.tsx, loaded when the HUD
 * opens).
 */
import { useEffect, type MutableRefObject } from 'react';
import type { RoomBus } from '../../types';
import type { PeerEntryRecord } from '../../webrtc/peerEntry';
import { installDiagResponder } from './speedTest';
import { peerLinks } from './links';

/** Every app answers the other side's stream test, whether or not its HUD is open */
export function useDiagResponder(bus: RoomBus, peersRef: MutableRefObject<Map<string, PeerEntryRecord>>): void {
  useEffect(() => installDiagResponder(bus, peerLinks(peersRef)), [bus, peersRef]);
}
