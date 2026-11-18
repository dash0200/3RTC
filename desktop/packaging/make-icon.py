"""Draws the 3RTC logo into crates/app/assets/windows/3rtc.ico (the exe's icon in Explorer, the
taskbar and shortcuts; crates/app/build.rs embeds it).

The drawing is `logo_rgba` in crates/platform-win/src/art.rs (the window and tray icon), line for
line: a red (#E5143D) square with corners rounded by 27% of its size and the white play mark
(pointing left, 42% of the size) in the middle, edges smoothed with 4x4 samples per pixel. Change
both together.

Sizes 16, 24, 32, 48 and 64 are 32-bit bitmaps, 256 is a PNG (what Windows expects).

    python packaging\\make-icon.py
"""

import os
import struct
import zlib

SIZES = [16, 24, 32, 48, 64, 256]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "crates", "app", "assets", "windows", "3rtc.ico")


def in_rounded_square(x, y, s, r):
    cx = min(max(x, r), s - r)
    cy = min(max(y, r), s - r)
    return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r


def in_triangle(x, y, tri):
    a, b, c = tri

    def side(p1, p2):
        (x1, y1), (x2, y2) = p1, p2
        return (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)

    d1, d2, d3 = side(a, b), side(b, c), side(c, a)
    neg = d1 < 0.0 or d2 < 0.0 or d3 < 0.0
    pos = d1 > 0.0 or d2 > 0.0 or d3 > 0.0
    return not (neg and pos)


def logo_rgba(size):
    """`size` x `size` RGBA rows, top to bottom (straight alpha), as art.rs draws them."""
    sub = 4
    s = float(size)
    radius = s * 0.27
    mark = s * 0.42
    scale = mark / 14.0
    origin = (s - mark) / 2.0
    tri = [
        (origin + 11.0 * scale, origin + 1.5 * scale),
        (origin + 11.0 * scale, origin + 12.5 * scale),
        (origin + 1.5 * scale, origin + 7.0 * scale),
    ]
    out = bytearray()
    for y in range(size):
        for x in range(size):
            square = white = 0
            for sy in range(sub):
                for sx in range(sub):
                    px = x + (sx + 0.5) / sub
                    py = y + (sy + 0.5) / sub
                    if in_rounded_square(px, py, s, radius):
                        square += 1
                        if in_triangle(px, py, tri):
                            white += 1
            total = sub * sub

            def mix(red):
                if square == 0:
                    return 0
                return min(255, (red * (square - white) + 255 * white) // square)

            out += bytes([mix(0xE5), mix(0x14), mix(0x3D), min(255, 255 * square // total)])
    return bytes(out)


def bmp_entry(size, rgba):
    """A 32-bit DIB as an ICO entry: header, BGRA rows bottom to top, then the 1-bit AND mask."""
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    pixels = bytearray()
    for y in reversed(range(size)):
        row = rgba[y * size * 4 : (y + 1) * size * 4]
        for i in range(0, len(row), 4):
            r, g, b, a = row[i : i + 4]
            pixels += bytes([b, g, r, a])
    mask_stride = ((size + 31) // 32) * 4
    mask = bytearray()
    for y in reversed(range(size)):
        bits = bytearray(mask_stride)
        for x in range(size):
            if rgba[(y * size + x) * 4 + 3] == 0:
                bits[x // 8] |= 0x80 >> (x % 8)
        mask += bits
    return header + bytes(pixels) + bytes(mask)


def png_entry(size, rgba):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + rgba[y * size * 4 : (y + 1) * size * 4] for y in range(size))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    entries = []
    for size in SIZES:
        rgba = logo_rgba(size)
        entries.append((size, png_entry(size, rgba) if size >= 256 else bmp_entry(size, rgba)))
    out = struct.pack("<HHH", 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    for size, data in entries:
        dim = 0 if size >= 256 else size  # 0 means 256
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in entries:
        out += data
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(out)
    print(f"{os.path.normpath(OUT)}: {len(out)} bytes, sizes {SIZES}")


if __name__ == "__main__":
    main()
