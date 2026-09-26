"""
產生擴充程式所需的 PNG 圖示（16x16, 48x48, 128x128）
執行方式：python generate_icons.py
"""
import struct, zlib, math, os

def png_bytes(pixels, size):
    """最小化 PNG encoder，不需要任何第三方套件。"""
    def chunk(tag, data):
        c = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', c)

    raw = b''
    for row in pixels:
        raw += b'\x00'
        for r, g, b, a in row:
            raw += bytes([r, g, b, a])

    compressed = zlib.compress(raw, 9)
    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', ihdr)
        + chunk(b'IDAT', compressed)
        + chunk(b'IEND', b'')
    )

def draw_icon(size):
    pixels = [[(0, 0, 0, 0)] * size for _ in range(size)]

    def set_px(x, y, r, g, b, a=255):
        if 0 <= x < size and 0 <= y < size:
            pixels[y][x] = (r, g, b, a)

    def blend(x, y, r, g, b, alpha):
        if 0 <= x < size and 0 <= y < size:
            pr, pg, pb, pa = pixels[y][x]
            a = alpha / 255
            pixels[y][x] = (
                int(pr * (1 - a) + r * a),
                int(pg * (1 - a) + g * a),
                int(pb * (1 - a) + b * a),
                min(255, pa + int(alpha * (1 - pa / 255))),
            )

    # ── Background: rounded rect (blue #4F86F7) ──────────────────────────────
    bg_r, bg_g, bg_b = 0x4F, 0x86, 0xF7
    corner = max(2, int(size * 0.22))

    for y in range(size):
        for x in range(size):
            # Distance to nearest corner center
            cx = corner if x < corner else (size - 1 - corner if x > size - 1 - corner else x)
            cy = corner if y < corner else (size - 1 - corner if y > size - 1 - corner else y)
            dist = math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
            if dist <= corner:
                pixels[y][x] = (bg_r, bg_g, bg_b, 255)

    # ── White lines ──────────────────────────────────────────────────────────
    def draw_hline(lx, ly, lw, lh):
        for y in range(ly, min(ly + lh, size)):
            for x in range(lx, min(lx + lw, size)):
                pixels[y][x] = (255, 255, 255, 242)

    lx = int(size * 0.22)
    lh = max(1, int(size * 0.085))
    lines = [
        (int(size * 0.28), int(size * 0.56)),
        (int(size * 0.43), int(size * 0.40)),
        (int(size * 0.58), int(size * 0.48)),
    ]
    for ly, lw in lines:
        draw_hline(lx, ly, lw, lh)

    # ── Green circle badge (#22C55E) ─────────────────────────────────────────
    gcx = int(size * 0.735)
    gcy = int(size * 0.735)
    gcr = int(size * 0.195)
    gr, gg, gb = 0x22, 0xC5, 0x5E

    for y in range(max(0, gcy - gcr - 1), min(size, gcy + gcr + 2)):
        for x in range(max(0, gcx - gcr - 1), min(size, gcx + gcr + 2)):
            d = math.sqrt((x - gcx) ** 2 + (y - gcy) ** 2)
            if d < gcr - 0.5:
                pixels[y][x] = (gr, gg, gb, 255)
            elif d < gcr + 0.5:
                a = int((gcr + 0.5 - d) * 255)
                blend(x, y, gr, gg, gb, a)

    # ── White person icon inside badge ───────────────────────────────────────
    hcx, hcy = gcx, gcy - int(gcr * 0.12)
    hr = max(1, int(gcr * 0.30))
    for y in range(max(0, hcy - hr - 1), min(size, hcy + hr + 2)):
        for x in range(max(0, hcx - hr - 1), min(size, hcx + hr + 2)):
            if math.sqrt((x - hcx) ** 2 + (y - hcy) ** 2) < hr:
                pixels[y][x] = (255, 255, 255, 255)

    # Body arc
    body_r = int(gcr * 0.50)
    body_cy = hcy + int(gcr * 0.72)
    for y in range(max(0, body_cy - body_r), min(size, body_cy + 1)):
        for x in range(max(0, hcx - body_r - 1), min(size, hcx + body_r + 2)):
            if math.sqrt((x - hcx) ** 2 + (y - body_cy) ** 2) < body_r:
                pixels[y][x] = (255, 255, 255, 255)

    return pixels

def main():
    out_dir = os.path.join(os.path.dirname(__file__), 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in [16, 48, 128]:
        pixels = draw_icon(size)
        data = png_bytes(pixels, size)
        path = os.path.join(out_dir, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(data)
        print(f'已產生 {path} ({len(data)} bytes)')
    print('完成！')

if __name__ == '__main__':
    main()
