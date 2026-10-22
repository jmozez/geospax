#!/usr/bin/env python3
"""Equal Earth for exported maps, end to end: a world map (a 2° raster and six cities) chooses Equal
Earth by itself, warps the raster into it, draws the world's outline and no scale bar; a small map stays
in Web Mercator; an unknown projection is refused.

    python3 scripts/test-equal-earth.py target/release/geospax-server
"""
import json, math, os, subprocess, sys, tempfile, time, urllib.request

BIN = sys.argv[1] if len(sys.argv) > 1 else 'target/release/geospax-server'
PORT = 18099
BASE = f'http://127.0.0.1:{PORT}'
passed, failed = 0, []


def ok(name, cond, extra=''):
    global passed
    print(('  ok   ' if cond else '  FAIL ') + name + (f' ({extra})' if extra else ''))
    if cond:
        passed += 1
    else:
        failed.append(name)


def req(path, body=None, ctype='application/json', method=None):
    r = urllib.request.Request(BASE + path, data=body.encode() if isinstance(body, str) else body, method=method or ('POST' if body is not None else 'GET'))
    if body is not None:
        r.add_header('content-type', ctype)
    try:
        with urllib.request.urlopen(r, timeout=120) as f:
            return f.status, json.loads(f.read() or b'null')
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b'null')


def run(name, layers, extra, report=False):
    w = {'layers': layers, 'name': name, 'title': name, 'basemap': 'none', **extra}
    y = f'recipe: {name}\nversion: 1\ntitle: {name}\nsteps:\n  - id: map\n    use: export.map\n    with: {json.dumps(w)}\n'
    y += '  - id: report\n    use: export.report\n    needs: [map]\noutputs: [map, report]\n' if report else 'outputs: [map]\n'
    req('/api/recipes', y, 'text/yaml')
    _, r = req(f'/api/recipes/{name}/run', '{}')
    for _ in range(240):
        if r.get('status') not in ('running', 'queued'):
            break
        time.sleep(0.5)
        _, r = req(f"/api/runs/{r['id']}")
    return r


tmp = tempfile.mkdtemp(prefix='gx-ee-')
data = os.path.join(tmp, 'data')
os.makedirs(data)
rows = [' '.join(str(int(50 + 40 * math.cos(math.radians(-89 + 2 * r)))) for _ in range(180)) for r in range(90)]
open(os.path.join(data, 'temp.asc'), 'w').write('\n'.join(['ncols 180', 'nrows 90', 'xllcorner -180', 'yllcorner -90', 'cellsize 2', 'NODATA_value -9999', *rows, '']))
open(os.path.join(data, 'temp.prj'), 'w').write('GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]')
cities = [('Port Moresby', 147.18, -9.44), ('London', -0.12, 51.5), ('Lima', -77.0, -12.0), ('Tokyo', 139.7, 35.7), ('Cape Town', 18.4, -33.9), ('Anchorage', -149.9, 61.2)]
fc = lambda pts: json.dumps({'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': {'name': n}, 'geometry': {'type': 'Point', 'coordinates': [x, y]}} for n, x, y in pts]})
open(os.path.join(data, 'cities.geojson'), 'w').write(fc(cities))
open(os.path.join(data, 'local.geojson'), 'w').write(fc([('Koki', 147.2, -9.48), ('Hanuabada', 147.15, -9.46)]))

srv = subprocess.Popen([BIN, '--data', data, '--state-dir', os.path.join(tmp, 'state'), '--port', str(PORT), '--no-device-mounts', '--no-triggers'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    for _ in range(60):
        try:
            if req('/api/health')[0] == 200:
                break
        except OSError:
            time.sleep(0.5)
    _, rl = req('/api/rasters')
    rid = rl['rasters'][0]['id']

    r = run('world', [rid, 'cities.geojson'], {}, report=True)
    ok('world map ran', r.get('status') == 'done', r.get('error') or '')
    svg = open(r['outputs']['map']['svg']).read() if r.get('status') == 'done' else ''
    ok('automatic projection is Equal Earth', 'Equal Earth (equal-area)' in svg)
    ok('no scale bar on a world map', 'km<' not in svg and ' m<' not in svg)
    ok('raster drawn', '<image' in svg)
    ok('page follows the oval (landscape)', r['outputs']['map']['size'][0] > r['outputs']['map']['size'][1] * 1.4, r['outputs']['map']['size'])
    rep = ''.join(open(os.path.join(r['dir'], f), encoding='utf-8', errors='ignore').read() for f in os.listdir(r['dir']) if f.endswith(('.html', '.md')))
    ok("the report's methods name Equal Earth", 'Šavrič' in rep, ', '.join(os.listdir(r['dir'])))

    r = run('local', ['local.geojson'], {})
    svg = open(r['outputs']['map']['svg']).read() if r.get('status') == 'done' else ''
    ok('a small map stays in Web Mercator, with its scale bar', 'Web Mercator' in svg and 'Equal Earth' not in svg and ' m<' in svg)

    r = run('local-ee', ['local.geojson'], {'projection': 'equal-earth'})
    svg = open(r['outputs']['map']['svg']).read() if r.get('status') == 'done' else ''
    ok('Equal Earth on request', 'Equal Earth' in svg, r.get('error') or '')

    r = run('bad', ['local.geojson'], {'projection': 'lambert'})
    ok('unknown projection refused', r.get('status') == 'failed' and 'projection' in (r.get('error') or ''), r.get('error') or '')
finally:
    srv.terminate()

print(f'\n{passed} passed, {len(failed)} failed')
sys.exit(1 if failed else 0)
