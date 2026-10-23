# A small HTTP server with byte ranges and a speed limit, for scripts/test-online-download.mjs:
# GDAL reads remote zips and GeoTIFFs with range requests, as from geodata.ucdavis.edu.
#   python3 scripts/test-range-server.py PORT ROOT
import http.server, os, re, sys
root = sys.argv[2]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=root, **k)
    def log_message(s, *a): pass
    def send_head(s):
        rng = s.headers.get('Range'); path = s.translate_path(s.path)
        if not rng or not os.path.isfile(path): return super().send_head()
        m = re.match(r'bytes=(\d+)-(\d*)', rng); size = os.path.getsize(path)
        a = int(m.group(1)); b = int(m.group(2)) if m.group(2) else size - 1; b = min(b, size - 1)
        f = open(path, 'rb'); f.seek(a); s.send_response(206)
        s.send_header('Content-Range', f'bytes {a}-{b}/{size}'); s.send_header('Content-Length', str(b - a + 1)); s.send_header('Accept-Ranges', 'bytes'); s.end_headers()
        s._left = b - a + 1; return f
    def copyfile(s, src, dst):
        import time
        if hasattr(s, '_left'):
            left = s._left; del s._left
            while left > 0:
                n = min(65536, left); dst.write(src.read(n)); left -= n; time.sleep(0.1)  # SLOW

        else:
            while True:
                b = src.read(65536)
                if not b: break
                dst.write(b); time.sleep(0.1)
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
