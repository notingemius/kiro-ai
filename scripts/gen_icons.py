"""Generate PNG icons (16, 48, 128 px) — pure stdlib, no Pillow."""
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")
os.makedirs(OUT_DIR, exist_ok=True)


def lerp(a, b, t):
    return int(a + (b - a) * t)


def gradient(x, y, w, h):
    t = (x + y) / (w + h - 2) if (w + h - 2) else 0
    r = lerp(0x7c, 0x00, t)
    g = lerp(0x5c, 0xc2, t)
    b = lerp(0xff, 0xff, t)
    return (r, g, b)


def rounded_mask(x, y, w, h, radius):
    if x < radius and y < radius:
        return (x - radius) ** 2 + (y - radius) ** 2 <= radius * radius
    if x >= w - radius and y < radius:
        return (x - (w - 1 - radius)) ** 2 + (y - radius) ** 2 <= radius * radius
    if x < radius and y >= h - radius:
        return (x - radius) ** 2 + (y - (h - 1 - radius)) ** 2 <= radius * radius
    if x >= w - radius and y >= h - radius:
        return (x - (w - 1 - radius)) ** 2 + (y - (h - 1 - radius)) ** 2 <= radius * radius
    return True


def letter_k_mask(x, y, size):
    inset = size * 0.22
    left = inset
    right = size - inset
    top = inset
    bottom = size - inset
    stroke = max(1.0, size * 0.12)

    if left <= x <= left + stroke and top <= y <= bottom:
        return True

    mid_x = left + stroke
    mid_y = (top + bottom) / 2

    def on_segment(x, y, x1, y1, x2, y2, thickness):
        dx = x2 - x1
        dy = y2 - y1
        L2 = dx * dx + dy * dy
        if L2 == 0:
            return False
        t = ((x - x1) * dx + (y - y1) * dy) / L2
        if t < 0 or t > 1:
            return False
        px = x1 + t * dx
        py = y1 + t * dy
        d2 = (x - px) ** 2 + (y - py) ** 2
        return d2 <= (thickness / 2) ** 2

    if on_segment(x, y, right, top, mid_x, mid_y, stroke):
        return True
    if on_segment(x, y, mid_x, mid_y, right, bottom, stroke):
        return True
    return False


def render(size):
    radius = max(2, int(size * 0.22))
    pixels = bytearray()
    for y in range(size):
        pixels.append(0)
        for x in range(size):
            inside = rounded_mask(x, y, size, size, radius)
            if not inside:
                pixels.extend(b"\x00\x00\x00\x00")
                continue
            if letter_k_mask(x, y, size):
                pixels.extend(b"\xff\xff\xff\xff")
            else:
                r, g, b = gradient(x, y, size, size)
                pixels.extend(bytes((r, g, b, 255)))
    return bytes(pixels)


def write_png(path, size):
    raw = render(size)

    def chunk(tag, data):
        crc = zlib.crc32(tag + data)
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(raw, 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    for sz in (16, 48, 128):
        out = os.path.join(OUT_DIR, f"icon{sz}.png")
        write_png(out, sz)
        print("wrote", out, sz, "x", sz)
