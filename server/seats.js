/**
 * Proof of a seat in a room, so nobody can take someone else's place by naming their peer id
 * (peer ids are public: everyone in the room sees them).
 *
 * The server hands out two signed tokens and checks them when someone comes back:
 *   seat token  for one peer id in one room: lets a peer whose signaling dropped reclaim its own
 *               seat (same id), or bring the room back after a server restart
 *   host token  for the room itself (any peer id): lets the host get the room back, also after
 *               reloading the page (new peer id)
 * Each room gets a random instance id ("epoch") when it is created; tokens name it, so a token
 * from an earlier room with the same 5-digit code can't take over a new one. Tokens are HMACs
 * with the server's secret and carry their own expiry, so they still work after a restart
 * (the secret is kept in a file in production, see loadSecret).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // (a room instance is named in the token, so a long life is safe)
const PEER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A client-chosen peer id we accept (the app sends a random UUID). */
export const isValidPeerId = (id) => typeof id === 'string' && PEER_ID_RE.test(id);

export const newEpoch = () => crypto.randomBytes(8).toString('hex');

/**
 * The server's signing secret: SIGNAL_SECRET, else (production) a file next to the server made on
 * first start (kept across restarts and updates), else a new random one for this process.
 * @param {{ env?: NodeJS.ProcessEnv, dir?: string }} [options]
 */
export function loadSecret({ env = process.env, dir } = {}) {
    if (env.SIGNAL_SECRET) return env.SIGNAL_SECRET;
    if (env.NODE_ENV === 'production' && dir) {
        const file = path.join(dir, '.signal-secret');
        try {
            const saved = fs.readFileSync(file, 'utf8').trim();
            if (saved.length >= 32) return saved;
        } catch { /* not made yet */ }
        const secret = crypto.randomBytes(32).toString('hex');
        try {
            fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
        } catch { /* read-only: tokens just won't survive a restart */ }
        return secret;
    }
    return crypto.randomBytes(32).toString('hex');
}

export function createSeats(secret) {
    const sign = (body) => crypto.createHmac('sha256', secret).update(body).digest('base64url');
    const body = (kind, roomId, epoch, peerId, exp) => `${kind}|${roomId}|${epoch}|${peerId}|${exp}`;

    const make = (kind, roomId, epoch, peerId, now) => {
        const exp = Math.floor((now + TOKEN_TTL_MS) / 1000);
        return `v1.${epoch}.${exp}.${sign(body(kind, roomId, epoch, peerId, exp))}`;
    };

    /** The room instance (epoch) the token is for, or null if it isn't valid for this use. */
    const check = (kind, token, roomId, peerId, now) => {
        if (typeof token !== 'string' || token.length > 200) return null;
        const [v, epoch, expText, sig] = token.split('.');
        const exp = Number(expText);
        if (v !== 'v1' || !/^[0-9a-f]{16}$/.test(epoch || '') || !Number.isInteger(exp) || !sig) return null;
        if (exp * 1000 < now) return null;
        const want = Buffer.from(sign(body(kind, roomId, epoch, peerId, exp)));
        const got = Buffer.from(sig);
        return want.length === got.length && crypto.timingSafeEqual(want, got) ? epoch : null;
    };

    // Host tokens carry the room's host generation: it goes up each time the host hands the room to
    // someone else, so an earlier host's token stops working (see signaling.js, transfer-host).
    // Generation 0 keeps the original v1 form, so tokens from before transfers existed still work.
    const makeHost = (roomId, epoch, gen, now) => {
        if (!gen) return make('host', roomId, epoch, '', now);
        const exp = Math.floor((now + TOKEN_TTL_MS) / 1000);
        return `v2.${epoch}.${gen}.${exp}.${sign(body('host', roomId, epoch, `g${gen}`, exp))}`;
    };
    /** { epoch, gen } of a valid host token for this room, or null. */
    const checkHostGen = (token, roomId, now) => {
        if (typeof token !== 'string' || token.length > 200) return null;
        if (!token.startsWith('v2.')) {
            const epoch = check('host', token, roomId, '', now);
            return epoch ? { epoch, gen: 0 } : null;
        }
        const [, epoch, genText, expText, sig] = token.split('.');
        const gen = Number(genText);
        const exp = Number(expText);
        if (!/^[0-9a-f]{16}$/.test(epoch || '') || !Number.isInteger(gen) || gen < 1 || gen > 1e6 || !Number.isInteger(exp) || !sig) return null;
        if (exp * 1000 < now) return null;
        const want = Buffer.from(sign(body('host', roomId, epoch, `g${gen}`, exp)));
        const got = Buffer.from(sig);
        return want.length === got.length && crypto.timingSafeEqual(want, got) ? { epoch, gen } : null;
    };

    return {
        seatToken: (roomId, epoch, peerId, now = Date.now()) => make('seat', roomId, epoch, peerId, now),
        hostToken: (roomId, epoch, gen = 0, now = Date.now()) => makeHost(roomId, epoch, gen, now),
        checkSeat: (token, roomId, peerId, now = Date.now()) => check('seat', token, roomId, peerId, now),
        checkHost: (token, roomId, now = Date.now()) => checkHostGen(token, roomId, now)?.epoch ?? null,
        checkHostGen: (token, roomId, now = Date.now()) => checkHostGen(token, roomId, now)
    };
}
