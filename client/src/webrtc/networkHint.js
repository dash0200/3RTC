/**
 * What to tell someone whose first connection to a peer doesn't work. 3RTC connects people
 * directly (no relay server), which some networks block: many work, school and mobile networks,
 * and VPNs. Our own connection candidates tell whose side it is:
 *   only "host" candidates (or none): our network didn't let us find a public address (STUN is
 *     blocked), so it's our network
 *   a public address ("srflx"): we got out, so it's their network, ours, or both being strict
 * (pure, for tests)
 */
export function blockedNetworkHint(localCandidateTypes = []) {
    const types = new Set(localCandidateTypes);
    const reachedOut = types.has('srflx') || types.has('prflx') || types.has('relay');
    if (!reachedOut) {
        return {
            side: 'ours',
            toast: "Can't connect: your network blocks direct connections",
            message: "⚠️ Couldn't connect to someone in the room: your network seems to block direct connections "
                + '(common on work, school and some mobile networks, and with a VPN). Try another network: switch '
                + 'between Wi-Fi and mobile data, or turn off the VPN, then rejoin the room.'
        };
    }
    return {
        side: 'either',
        toast: "Can't connect: a network is blocking direct connections",
        message: "⚠️ Couldn't connect to someone in the room: your network or theirs blocks direct connections "
            + '(common on work, school and some mobile networks, and with a VPN). Try switching one of you between '
            + 'Wi-Fi and mobile data, or turning off a VPN, then rejoin the room.'
    };
}

/** Candidate type from an RTCIceCandidate ('host' | 'srflx' | 'prflx' | 'relay'), or ''. */
export function candidateType(candidate) {
    if (!candidate) return '';
    if (candidate.type) return candidate.type;
    return /\btyp (\w+)/.exec(candidate.candidate || '')?.[1] || '';
}
