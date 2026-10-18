/**
 * In-browser WebAssembly PGS (Presentation Graphic Stream) subtitle renderer using libbitsub.
 * Renders Blu-ray BD-PGS bitmap subtitles on an overlay canvas synchronized with HTML5 video.
 */

let libbitsubPromise = null;

export async function getPgsRendererClass() {
    if (!libbitsubPromise) {
        libbitsubPromise = (async () => {
            const mod = await import('libbitsub');
            if (typeof mod.initWasm === 'function') {
                await mod.initWasm();
            }
            return mod.PgsRenderer;
        })();
    }
    return libbitsubPromise;
}

/**
 * Creates and initializes a PgsRenderer instance.
 * @param {object} options
 * @param {HTMLVideoElement} options.video
 * @param {HTMLCanvasElement} [options.canvas]
 * @param {Uint8Array|ArrayBuffer} options.supBytes
 * @param {() => void} [options.onLoaded]
 * @param {(err: Error) => void} [options.onError]
 * @returns {Promise<any>} PgsRenderer instance
 */
export async function createPgsRenderer({ video, canvas, supBytes, onLoaded, onError }) {
    if (!video || !supBytes) {
        throw new Error('Missing video or supBytes for PGS renderer');
    }

    const PgsRenderer = await getPgsRendererClass();
    const buffer = supBytes instanceof Uint8Array
        ? supBytes.buffer.slice(supBytes.byteOffset, supBytes.byteOffset + supBytes.byteLength)
        : supBytes;

    const options = {
        video,
        subContent: buffer,
        onLoaded: () => {
            onLoaded?.();
        },
        onError: (err) => {
            console.error('[libbitsub] PGS rendering error:', err);
            onError?.(err);
        }
    };
    if (canvas) {
        options.canvas = canvas;
    }

    const renderer = new PgsRenderer(options);
    return renderer;
}
