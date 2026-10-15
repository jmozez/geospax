#!/usr/bin/env python3
"""Spatial statistics checks (docs/AUTOMATION.md §6e, docs/RESULTS.md §20).

1. Hot spots of incidents (points-to-hotspots on scripts/data-sample-incidents.py's log, which
   has three planted clusters): every planted centre must be a 99 % hot spot and no hot spot may
   lie far from a planted cluster. Gi* z-scores, global Moran's I and every distance of the
   incremental spatial autocorrelation search are recomputed in R with spdep (localG with
   include.self, moran.test) and must match.
2. Hot spots of values (stats.hotspots, field: ph, on the field samples): the same R checks.
3. Kriging (interpolate-samples on scripts/data-sample-field.py's samples): the empirical
   variogram must equal gstat's variogram(); the fitted model must fit at least as well as
   gstat's own fit.variogram() (weighted SSE, both computed by gstat); predictions and standard
   errors at 300 cells must equal gstat's krige() with the same model, and the leave-one-out
   statistics krige.cv()'s. Against the known truth surface, kriging must beat IDW.
4. Speed: hot spots of one million points (synthetic.points), unless --quick.

  python3 scripts/test-stats.py --bin target/release/geospax-server --data /opt/geospax-data \\
      [--out bench/screenshots] [--results bench/stats-results.json] [--quick] [--no-r] \\
      [--pw /opt/pw/node_modules/playwright]

Needs GDAL's command-line tools (ogr2ogr, gdal_translate); R with sf, spdep, gstat and jsonlite
for the cross-checks (skipped with a note when missing, or with --no-r).
"""
import argparse
import json
import math
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

fails = []
results = {"checks": []}


def check(ok, msg):
    line = ("  ok    " if ok else "  FAIL  ") + msg
    print(line, flush=True)
    results["checks"].append(("ok " if ok else "FAIL ") + msg)
    if not ok:
        fails.append(msg)
    return ok


def step(run, sid):
    for s in run.get("steps", []):
        if s["id"] == sid:
            return s
    return {}


def run_cli(a, state, recipe, inputs=None):
    cmd = [a.bin, "run", recipe, "--state-dir", state, "--json"]
    for d in a.data_dirs:
        cmd += ["--data", d]
    for k, v in (inputs or {}).items():
        cmd += ["--input", f"{k}={v}"]
    t0 = time.time()
    p = subprocess.run(cmd, capture_output=True, text=True)
    wall = time.time() - t0
    try:
        return json.loads(p.stdout), wall
    except json.JSONDecodeError:
        return {"status": "no-json", "error": (p.stderr or p.stdout)[-1200:], "steps": [], "artifacts": []}, wall


def features(gpkg):
    p = subprocess.run(["ogr2ogr", "-f", "GeoJSON", "/vsistdout/", gpkg], capture_output=True, text=True, check=True)
    return json.loads(p.stdout)["features"]


def xyz(path):
    """{(x, y): value} of every cell with data."""
    p = subprocess.run(["gdal_translate", "-q", "-of", "XYZ", path, "/vsistdout/"], capture_output=True, text=True, check=True)
    out = {}
    for line in p.stdout.splitlines():
        x, y, z = map(float, line.split())
        if z > -9000:
            out[(round(x, 3), round(y, 3))] = z
    return out


def point_in_ring(pt, ring):
    x, y = pt
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def metres(lon0, lat0, lon1, lat1):
    kx = 111_320.0 * math.cos(math.radians((lat0 + lat1) / 2))
    return math.hypot((lon1 - lon0) * kx, (lat1 - lat0) * 110_540.0)


def ring_centre(ring):
    xs = [p[0] for p in ring[:-1]]
    ys = [p[1] for p in ring[:-1]]
    return sum(xs) / len(xs), sum(ys) / len(ys)


def have_r():
    if not shutil.which("Rscript"):
        return "Rscript not found"
    p = subprocess.run(["Rscript", "-e", 'q(status = if (all(sapply(c("sf","spdep","gstat","jsonlite"), requireNamespace, quietly = TRUE))) 0 else 1)'], capture_output=True)
    return None if p.returncode == 0 else "R needs the sf, spdep, gstat and jsonlite packages"


def rscript(code, args, tmp):
    path = os.path.join(tmp, "check.R")
    with open(path, "w") as f:
        f.write(code)
    apath = os.path.join(tmp, "args.json")
    with open(apath, "w") as f:
        json.dump(args, f)
    p = subprocess.run(["Rscript", path, apath], capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(p.stderr[-1500:])
    return json.loads(p.stdout.strip().splitlines()[-1])


R_HOTSPOTS = r"""
suppressMessages({library(sf); library(spdep); library(jsonlite)})
a <- fromJSON(commandArgs(TRUE)[1])
g <- st_transform(st_read(a$gpkg, quiet = TRUE), a$epsg)
xy <- if (all(st_geometry_type(g) == "POINT")) st_coordinates(g) else st_coordinates(suppressWarnings(st_centroid(st_geometry(g))))
x <- as.numeric(g[[a$field]])
band <- function(d) dnearneigh(xy, 0, d * (1 + 1e-6))
nb <- band(a$distance)
gi <- as.numeric(localG(x, nb2listw(include.self(nb), style = "B")))
m <- moran.test(x, nb2listw(nb, style = "W", zero.policy = TRUE), randomisation = TRUE, zero.policy = TRUE)
isa_i <- c(); isa_z <- c()
for (d in a$bands) {
  mt <- moran.test(x, nb2listw(band(d), style = "W", zero.policy = TRUE), randomisation = TRUE, zero.policy = TRUE)
  isa_i <- c(isa_i, mt$estimate[[1]]); isa_z <- c(isa_z, mt$statistic[[1]])
}
cat(toJSON(list(gi = gi, gz = as.numeric(g$gi_z), card = card(nb), I = m$estimate[[1]], z = m$statistic[[1]], isa_i = isa_i, isa_z = isa_z), digits = NA, auto_unbox = TRUE), "\n")
"""

R_KRIGING = r"""
suppressMessages({library(sf); library(gstat); library(jsonlite)})
a <- fromJSON(commandArgs(TRUE)[1])
pts <- st_transform(st_read(a$samples, quiet = TRUE), a$epsg)
pts <- pts[!is.na(pts[[a$field]]), ]
f <- as.formula(paste(a$field, "~ 1"))
v <- variogram(f, pts, cutoff = a$cutoff, width = a$width)
own <- suppressWarnings(fit.variogram(v, vgm(NA, a$code, NA, NA)))
best <- suppressWarnings(fit.variogram(v, vgm(c("Sph", "Exp", "Gau"))))
m <- vgm(a$psill, a$code, a$range, a$nugget)
# weighted SSE as gstat's fit.method 7 defines it (pairs / distance²), for both fits alike
wsse <- function(mod) sum(v$np / v$dist^2 * (v$gamma - variogramLine(mod, dist_vector = v$dist)$gamma)^2)
cells <- st_as_sf(data.frame(x = a$cx, y = a$cy), coords = c("x", "y"), crs = a$epsg)
nmax <- if (is.null(a$nmax) || a$nmax == 0) Inf else a$nmax
k <- krige(f, pts, cells, model = m, nmax = nmax, debug.level = 0)
cv <- krige.cv(f, pts, model = m, nmax = nmax, verbose = FALSE)
ll <- st_coordinates(st_transform(cells, 4326))
last <- nrow(own)
cat(toJSON(list(
  np = v$np, dist = v$dist, gamma = v$gamma,
  own = list(nugget = own$psill[1], psill = own$psill[last], range = own$range[last], sse = wsse(own), ssErr = attr(own, "SSErr"), singular = isTRUE(attr(own, "singular"))),
  best_model = as.character(best$model[nrow(best)]), best_sse = attr(best, "SSErr"),
  sse_ours = wsse(m),
  pred = k$var1.pred, se = sqrt(pmax(k$var1.var, 0)),
  cv_rmse = sqrt(mean(cv$residual^2)), cv_mae = mean(abs(cv$residual)), cv_me = mean(-cv$residual),
  cv_rmsse = sqrt(mean(cv$zscore^2)),
  lon = ll[, 1], lat = ll[, 2]), digits = NA, auto_unbox = TRUE), "\n")
"""


def truth_ph(lon, lat):
    """The smooth surface scripts/data-sample-field.py draws its pH samples from (without noise)."""
    u, v = (lon - 144.235) / 0.05, (lat + 5.862) / 0.04
    return 5.6 + 0.55 * u - 0.35 * v + 0.25 * math.sin(3 * u) * math.cos(2 * v)


def random_field(path, n=400, seed=9, ell=900.0):
    """Stationary Gaussian random field (random Fourier features: covariance exp(−h²/2ℓ²), so
    gstat's Gaussian model with range √2·ℓ), sampled at n random places near Lae with a 0.15
    measurement nugget. Returns the truth function of (lon, lat)."""
    rnd = random.Random(seed)
    lon0, lat0 = 146.99, -6.70
    kx, ky = 111_320.0 * math.cos(math.radians(lat0)), 110_540.0
    waves = [(rnd.gauss(0, 1 / ell), rnd.gauss(0, 1 / ell), rnd.uniform(0, 2 * math.pi)) for _ in range(300)]
    amp = math.sqrt(2 / len(waves))

    def truth(lon, lat):
        x, y = (lon - lon0) * kx, (lat - lat0) * ky
        return 10 + 2 * amp * sum(math.cos(a * x + b * y + p) for a, b, p in waves)

    feats = []
    for i in range(n):
        x, y = rnd.uniform(0, 6000), rnd.uniform(0, 5000)
        lon, lat = lon0 + x / kx, lat0 + y / ky
        feats.append({"type": "Feature", "properties": {"site": f"R{i + 1:03d}", "z": round(truth(lon, lat) + rnd.gauss(0, 0.15), 5)}, "geometry": {"type": "Point", "coordinates": [lon, lat]}})
    with open(path, "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)
    return truth


def r_hotspots(a, tmp, run, sid, field):
    out = step(run, sid).get("outputs", {})
    gpkg = os.path.join(run["dir"], "..", "..", "outputs", run["recipe"], os.path.basename(out.get("layer", "x.y").split(".", 1)[1]) + ".gpkg")
    gpkg = os.path.normpath(gpkg)
    bands = [b["distance"] for b in out.get("isa", [])]
    r = rscript(R_HOTSPOTS, {"gpkg": gpkg, "epsg": out["epsg"], "field": field, "distance": out["distance_m"], "bands": bands}, tmp)
    dz = max(abs(x - y) for x, y in zip(r["gi"], r["gz"]))
    check(len(r["gi"]) == out["features"] and dz < 5e-6, f"Gi* z-scores of {len(r['gi'])} features equal spdep localG (include.self, binary): max |Δz| = {dz:.1e}")
    m = out["moran"]
    check(abs(m["i"] - r["I"]) < 1e-9 and abs(m["z"] - r["z"]) < 1e-6, f"global Moran's I {m['i']:.6f} (z {m['z']:.4f}) equals spdep moran.test {r['I']:.6f} (z {r['z']:.4f})")
    if bands:
        di = max(abs(b["i"] - x) for b, x in zip(out["isa"], r["isa_i"]))
        dzz = max(abs(b["z"] - x) for b, x in zip(out["isa"], r["isa_z"]))
        check(di < 1e-9 and dzz < 1e-6, f"incremental search: Moran's I at all {len(bands)} distances equals spdep (max |ΔI| {di:.1e}, |Δz| {dzz:.1e})")
    return {"max_dz": dz, "moran_i": m["i"], "moran_z": m["z"], "r_moran_i": r["I"], "r_moran_z": r["z"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bin", default=os.path.join(ROOT, "target/release/geospax-server"))
    ap.add_argument("--data", default="/opt/geospax-data")
    ap.add_argument("--out", default=None, help="folder for report screenshots (needs --pw)")
    ap.add_argument("--results", default=None)
    ap.add_argument("--pw", default=os.environ.get("PW"), help="Playwright module path for report screenshots")
    ap.add_argument("--quick", action="store_true", help="skip the million-point timing")
    ap.add_argument("--no-r", action="store_true", help="skip the R cross-checks")
    a = ap.parse_args()
    t_all = time.time()
    tmp = tempfile.mkdtemp(prefix="geospax-stats-")
    state = os.path.join(tmp, "state")
    # data: the incident log and the field samples, generated into the temp folder when the data
    # folder lacks them (never written into it)
    gen = os.path.join(tmp, "data")
    a.data_dirs = [a.data]
    have = lambda f: os.path.exists(os.path.join(a.data, f))  # noqa: E731
    if not (have("incidents.geojson") and have("incidents_truth.json")):
        subprocess.run([sys.executable, os.path.join(HERE, "data-sample-incidents.py"), gen], check=True, stdout=subprocess.DEVNULL)
    if not have("field_samples.geojson"):
        subprocess.run([sys.executable, os.path.join(HERE, "data-sample-field.py"), gen], check=True, stdout=subprocess.DEVNULL)
    if os.path.isdir(gen):
        a.data_dirs.append(gen)
    src = lambda f: os.path.join(a.data if have(f) else gen, f)  # noqa: E731
    truth = json.load(open(src("incidents_truth.json") if have("incidents.geojson") else os.path.join(gen, "incidents_truth.json")))
    no_r = "skipped (--no-r)" if a.no_r else have_r()
    if no_r:
        print(f"  note  R cross-checks skipped: {no_r}")

    # ---------------------------------------------------------------- 1. hot spots of incidents
    print("1. hot spots of incidents (points-to-hotspots)")
    run, wall = run_cli(a, state, "points-to-hotspots")
    hot = step(run, "hot").get("outputs", {})
    check(run.get("status") == "done", f"points-to-hotspots ran: {run.get('status')} in {wall:.2f} s {run.get('error') or ''}")
    check(set(["map.png", "map.svg", "map.pdf", "report.html"]) <= set(run.get("artifacts", [])), f"map PNG/SVG/PDF and report: {run.get('artifacts')}")
    check(hot.get("mode") == "incidents" and hot.get("incidents") == 1120, f"picked the incident log by itself: {hot.get('source')} ({hot.get('incidents')} incidents)")
    check(hot.get("features", 0) >= 30 and hot.get("aggregation") == "hexagon", f"{hot.get('features')} hexagons of {hot.get('cell_m', 0):.0f} m")
    check(hot.get("distance_rule") in ("peak", "knn", "standard_distance", "capped"), f"distance band {hot.get('distance_m', 0):.0f} m by rule '{hot.get('distance_rule')}' ({len(hot.get('isa', []))} distances searched)")
    results["hotspots"] = {k: hot.get(k) for k in ("features", "cell_m", "distance_m", "distance_rule", "hot", "cold", "bins", "moran", "neighbours", "seconds")}
    results["hotspots"]["wall_s"] = round(wall, 2)
    gpkg = os.path.join(state, "outputs", "points-to-hotspots", "hotspots.gpkg")
    feats = features(gpkg)
    cells = []
    for f in feats:
        g = f["geometry"]
        ring = g["coordinates"][0][0] if g["type"] == "MultiPolygon" else g["coordinates"][0]
        cells.append((ring, f["properties"]))
    # every planted centre: inside a 99 % hot cell
    for c in truth["clusters"]:
        holder = [p for ring, p in cells if point_in_ring((c["lon"], c["lat"]), ring)]
        b = holder[0]["gi_bin"] if holder else None
        check(b == 3, f"planted cluster '{c['name']}' ({c['incidents']} incidents, σ {c['sigma_m']:.0f} m) is a 99 % hot spot (bin {b})")
    # no hot spot far from every planted cluster: within 2σ plus the distance band
    band = hot.get("distance_m", 0)
    far = []
    for ring, p in cells:
        if p["gi_bin"] > 0:
            lon, lat = ring_centre(ring)
            near = min(metres(lon, lat, c["lon"], c["lat"]) - 2 * c["sigma_m"] for c in truth["clusters"])
            if near > band:
                far.append((round(lon, 4), round(lat, 4), p["gi_bin"]))
    n_hot = sum(1 for _, p in cells if p["gi_bin"] > 0)
    check(not far, f"all {n_hot} hot cells lie within 2σ + the band ({band:.0f} m) of a planted cluster{'' if not far else f'; outside: {far[:5]}'}")
    results["hotspots"]["truth"] = {"clusters_found": sum(1 for c in truth["clusters"] if any(point_in_ring((c["lon"], c["lat"]), r) and p["gi_bin"] == 3 for r, p in cells)), "false_hot_cells": len(far)}
    with open(os.path.join(run.get("dir", tmp), "report.html"), encoding="utf-8") as f:
        rep = f.read()
    check("How the distance band was chosen" in rep and rep.count("<svg") >= 2, "report shows the map and the distance-search chart")
    if not no_r:
        try:
            results["hotspots"]["r"] = r_hotspots(a, tmp, run, "hot", "count")
        except Exception as e:  # noqa: BLE001
            check(False, f"R spdep cross-check ran: {e}")

    # ---------------------------------------------------------------- 2. hot spots of values
    print("2. hot spots of values (stats.hotspots, field: ph)")
    rec = os.path.join(tmp, "values.yaml")
    with open(rec, "w") as f:
        f.write("recipe: stats-test-values\nversion: 1\ntitle: Hot spots of values (test)\nsteps:\n  - id: hot\n    use: stats.hotspots\n    with: { layer: field_samples.geojson, field: ph, name: ph_hotspots }\n")
    run2, wall2 = run_cli(a, state, rec)
    h2 = step(run2, "hot").get("outputs", {})
    check(run2.get("status") == "done" and h2.get("mode") == "values" and h2.get("features") == 60, f"Gi* of pH at 60 samples: {run2.get('status')} {run2.get('error') or ''}")
    check(h2.get("hot", 0) > 0 and h2.get("cold", 0) > 0, f"the pH trend shows as {h2.get('hot')} hot and {h2.get('cold')} cold samples (band {h2.get('distance_m', 0):.0f} m, rule {h2.get('distance_rule')})")
    results["values"] = {k: h2.get(k) for k in ("features", "distance_m", "distance_rule", "hot", "cold", "moran")}
    if not no_r and run2.get("status") == "done":
        try:
            results["values"]["r"] = r_hotspots(a, tmp, run2, "hot", "ph")
        except Exception as e:  # noqa: BLE001
            check(False, f"R spdep cross-check (values) ran: {e}")

    # ---------------------------------------------------------------- 3. kriging
    print("3. automatic kriging (interpolate-samples)")
    run3, wall3 = run_cli(a, state, "interpolate-samples")
    s = step(run3, "surface").get("outputs", {})
    check(run3.get("status") == "done", f"interpolate-samples ran: {run3.get('status')} in {wall3:.2f} s {run3.get('error') or ''}")
    check({"map.png", "uncertainty.png", "report.html"} <= set(run3.get("artifacts", [])), f"surface map, uncertainty map and report: {run3.get('artifacts')}")
    vg = s.get("variogram") or {}
    cvk = (s.get("cv") or {}).get("kriging") or {}
    cvi = (s.get("cv") or {}).get("idw") or {}
    check(s.get("method") == "kriging" and s.get("has_se"), f"method chosen by cross-validation: {s.get('method')} (kriging RMSE {cvk.get('rmse', 0):.4f} vs IDW {cvi.get('rmse', 0):.4f} at power {cvi.get('power')})")
    check(0.5 < (cvk.get("rmsse") or 0) < 1.5, f"standard errors are honest: RMSSE {cvk.get('rmsse', 0):.3f} (1 = perfect)")
    with open(os.path.join(run3.get("dir", tmp), "report.html"), encoding="utf-8") as f:
        rep3 = f.read()
    check("Variogram" in rep3 and "How sure is the" in rep3, "report shows the variogram chart and the uncertainty map")
    results["kriging"] = {"model": vg.get("model"), "nugget": vg.get("nugget"), "psill": vg.get("psill"), "range": vg.get("range"), "practical_range": vg.get("practical_range"), "sse": vg.get("sse"), "cv": s.get("cv"), "cells": s.get("cells"), "cell_m": s.get("cell_m"), "seconds": s.get("seconds"), "wall_s": round(wall3, 2)}
    surf = os.path.join(state, "outputs", "interpolate-samples", "surface.tif")
    sef = os.path.join(state, "outputs", "interpolate-samples", "surface_se.tif")
    pv, sv = xyz(surf), xyz(sef)
    keys = sorted(pv)
    rnd = random.Random(5)
    pick = rnd.sample(keys, min(300, len(keys)))
    # IDW surface on the same grid, for the truth comparison
    rec_idw = os.path.join(tmp, "idw.yaml")
    with open(rec_idw, "w") as f:
        f.write("recipe: stats-test-idw\nversion: 1\ntitle: IDW only (test)\nsteps:\n  - id: surface\n    use: interpolate.auto\n    with: { layer: field_samples.geojson, field: ph, method: idw, name: surface }\n")
    run4, _ = run_cli(a, state, rec_idw)
    check(run4.get("status") == "done" and step(run4, "surface").get("outputs", {}).get("method") == "idw", f"IDW-only run for comparison: {run4.get('status')}")
    iv = xyz(os.path.join(state, "outputs", "stats-test-idw", "surface.tif"))
    if not no_r and run3.get("status") == "done":
        try:
            r = rscript(R_KRIGING, {
                "samples": src("field_samples.geojson"), "epsg": s["epsg"], "field": s["field"],
                "cutoff": vg["cutoff"], "width": vg["width"], "code": vg["code"],
                "nugget": vg["nugget"], "psill": vg["psill"], "range": vg["range"],
                "cx": [k[0] for k in pick], "cy": [k[1] for k in pick],
            }, tmp)
            lags = vg["lags"]
            same_np = [l["np"] for l in lags] == r["np"]
            dg = max(abs(l["gamma"] - g) / max(abs(g), 1e-12) for l, g in zip(lags, r["gamma"]))
            dd = max(abs(l["dist"] - d) / d for l, d in zip(lags, r["dist"]))
            check(same_np and dg < 1e-9 and dd < 1e-9, f"empirical variogram equals gstat variogram(): {len(lags)} lags, same pair counts, max rel. Δγ {dg:.1e}")
            check(r["sse_ours"] <= r["own"]["sse"] * (1 + 1e-6) and abs(r["sse_ours"] - vg["sse"]) <= 1e-6 * vg["sse"], f"fit at least as good as gstat fit.variogram ({vg['code']}): weighted SSE {r['sse_ours']:.4e} vs gstat {r['own']['sse']:.4e} (gstat: nugget {r['own']['nugget']:.4g}, psill {r['own']['psill']:.4g}, range {r['own']['range']:.4g}; ours {vg['nugget']:.4g}, {vg['psill']:.4g}, {vg['range']:.4g})")
            check(r["best_model"] == vg["code"] or r["sse_ours"] <= r["best_sse"] * (1 + 1e-6), f"model choice: ours {vg['code']}, gstat's best of Sph/Exp/Gau {r['best_model']} (SSE {r['best_sse']:.4e})")
            dp = max(abs(pv[k] - x) / max(1.0, abs(x)) for k, x in zip(pick, r["pred"]))
            ds = max(abs(sv[k] - x) / max(1.0, abs(x)) for k, x in zip(pick, r["se"]))
            check(dp < 2e-6 and ds < 2e-6, f"predictions and standard errors at {len(pick)} cells equal gstat krige(): max rel. Δ {dp:.1e} / {ds:.1e}")
            dcv = max(abs(cvk["rmse"] - r["cv_rmse"]), abs(cvk["mae"] - r["cv_mae"]), abs(cvk["me"] - r["cv_me"]), abs(cvk["rmsse"] - r["cv_rmsse"]))
            check(dcv < 1e-9, f"leave-one-out RMSE {cvk['rmse']:.6f}, MAE, ME, RMSSE equal gstat krige.cv() (max Δ {dcv:.1e})")
            tk = [pv[k] - truth_ph(lo, la) for k, lo, la in zip(pick, r["lon"], r["lat"])]
            ti = [iv[k] - truth_ph(lo, la) for k, lo, la in zip(pick, r["lon"], r["lat"]) if k in iv]
            rk = math.sqrt(sum(e * e for e in tk) / len(tk))
            ri = math.sqrt(sum(e * e for e in ti) / max(1, len(ti)))
            check(rk < ri, f"against the true surface: kriging RMSE {rk:.4f} < IDW {ri:.4f} ({(1 - rk / ri) * 100:.0f} % lower) at {len(tk)} cells")
            results["kriging"]["gstat"] = {"own_fit": r["own"], "best_model": r["best_model"], "sse_ours": r["sse_ours"], "max_rel_pred": dp, "max_rel_se": ds, "cv_rmse": r["cv_rmse"]}
            results["kriging"]["truth_rmse"] = {"kriging": rk, "idw": ri}
        except Exception as e:  # noqa: BLE001
            check(False, f"R gstat cross-check ran: {e}")

    # ---------------------------------------------------------------- 3b. stationary field, local kriging
    print("3b. a stationary random field with a sill (400 samples: local kriging, 32 neighbours)")
    rf = os.path.join(tmp, "random_field.geojson")
    rtruth = random_field(rf)
    rec_rf = os.path.join(tmp, "rf.yaml")
    with open(rec_rf, "w") as f:
        f.write(f"recipe: stats-test-field\nversion: 1\ntitle: Random field (test)\nsteps:\n  - id: open\n    use: io.open\n    with: {{ path: {rf} }}\n  - id: surface\n    use: interpolate.auto\n    with: {{ layer: \"${{open.layer}}\", field: z, name: surface }}\n")
    run6, wall6 = run_cli(a, state, rec_rf)
    s6 = step(run6, "surface").get("outputs", {})
    vg6 = s6.get("variogram") or {}
    cv6 = (s6.get("cv") or {}).get("kriging") or {}
    ci6 = (s6.get("cv") or {}).get("idw") or {}
    check(run6.get("status") == "done" and s6.get("method") == "kriging" and vg6.get("neighbours") == 32, f"400 samples: {s6.get('method')} with {vg6.get('neighbours')} neighbours, {vg6.get('model')} model (practical range {vg6.get('practical_range', 0):.0f} m; truth: gaussian, {math.sqrt(3) * math.sqrt(2) * 900:.0f} m), RMSE {cv6.get('rmse', 0):.4f} vs IDW {ci6.get('rmse', 0):.4f} in {wall6:.2f} s {run6.get('error') or ''}")
    results["field"] = {"model": vg6.get("model"), "nugget": vg6.get("nugget"), "psill": vg6.get("psill"), "practical_range": vg6.get("practical_range"), "cv": s6.get("cv"), "seconds": s6.get("seconds")}
    if not no_r and run6.get("status") == "done":
        pv6 = xyz(os.path.join(state, "outputs", "stats-test-field", "surface.tif"))
        sv6 = xyz(os.path.join(state, "outputs", "stats-test-field", "surface_se.tif"))
        pick6 = random.Random(6).sample(sorted(pv6), min(300, len(pv6)))
        try:
            r = rscript(R_KRIGING, {
                "samples": rf, "epsg": s6["epsg"], "field": "z", "cutoff": vg6["cutoff"], "width": vg6["width"], "code": vg6["code"],
                "nugget": vg6["nugget"], "psill": vg6["psill"], "range": vg6["range"], "nmax": 32,
                "cx": [k[0] for k in pick6], "cy": [k[1] for k in pick6],
            }, tmp)
            check([l["np"] for l in vg6["lags"]] == r["np"], f"empirical variogram equals gstat's ({len(r['np'])} lags)")
            check(r["sse_ours"] <= r["own"]["sse"] * (1 + 1e-6), f"fit at least as good as gstat fit.variogram ({vg6['code']}): weighted SSE {r['sse_ours']:.4e} vs {r['own']['sse']:.4e} (gstat: nugget {r['own']['nugget']:.4g}, psill {r['own']['psill']:.4g}, range {r['own']['range']:.4g}; ours {vg6['nugget']:.4g}, {vg6['psill']:.4g}, {vg6['range']:.4g})")
            dp = max(abs(pv6[k] - x) / max(1.0, abs(x)) for k, x in zip(pick6, r["pred"]))
            ds = max(abs(sv6[k] - x) / max(1.0, abs(x)) for k, x in zip(pick6, r["se"]))
            check(dp < 2e-6 and ds < 2e-6, f"local kriging (32 nearest) at {len(pick6)} cells equals gstat krige(nmax = 32): max rel. Δ {dp:.1e} / {ds:.1e}")
            dcv = max(abs(cv6["rmse"] - r["cv_rmse"]), abs(cv6["me"] - r["cv_me"]), abs(cv6["rmsse"] - r["cv_rmsse"]))
            check(dcv < 1e-9, f"leave-one-out RMSE {cv6['rmse']:.6f} equals gstat krige.cv(nmax = 32) (max Δ {dcv:.1e})")
            ek = [pv6[k] - rtruth(lo, la) for k, lo, la in zip(pick6, r["lon"], r["lat"])]
            rk = math.sqrt(sum(e * e for e in ek) / len(ek))
            check(rk < 0.6, f"against the true field (sd 2): kriging RMSE {rk:.3f} at {len(ek)} cells")
            results["field"]["gstat"] = {"own_fit": r["own"], "sse_ours": r["sse_ours"], "max_rel_pred": dp, "max_rel_se": ds}
            results["field"]["truth_rmse"] = rk
        except Exception as e:  # noqa: BLE001
            check(False, f"R gstat cross-check (random field) ran: {e}")

    # ---------------------------------------------------------------- 4. speed
    if not a.quick:
        print("4. a million points")
        rec_m = os.path.join(tmp, "million.yaml")
        with open(rec_m, "w") as f:
            f.write("recipe: stats-test-million\nversion: 1\ntitle: Hot spots of a million points (test)\nsteps:\n  - id: hot\n    use: stats.hotspots\n    with: { layer: synthetic.points, name: million }\n")
        run5, wall5 = run_cli(a, state, rec_m)
        h5 = step(run5, "hot").get("outputs", {})
        check(run5.get("status") == "done" and h5.get("incidents") == 1_000_000, f"1,000,000 points → {h5.get('features')} cells, band {h5.get('distance_m', 0):.0f} m ({h5.get('distance_rule')}), {h5.get('hot')} hot / {h5.get('cold')} cold: step {h5.get('seconds', 0):.2f} s, run {wall5:.2f} s {run5.get('error') or ''}")
        results["million"] = {k: h5.get(k) for k in ("features", "cell_m", "distance_m", "distance_rule", "hot", "cold", "seconds")}
        results["million"]["wall_s"] = round(wall5, 2)

    # ---------------------------------------------------------------- maps and report screenshots
    if a.out:
        os.makedirs(a.out, exist_ok=True)
        for r_, f, name in ((run, "map.png", "55-hotspot-map.png"), (run3, "map.png", "56-kriging-map.png"), (run3, "uncertainty.png", "57-kriging-uncertainty.png")):
            src_png = os.path.join(r_.get("dir", tmp), f)
            if os.path.exists(src_png):
                shutil.copy(src_png, os.path.join(a.out, name))
    if a.out and a.pw and os.path.isdir(a.pw):
        os.makedirs(a.out, exist_ok=True)
        js = os.path.join(tmp, "shot.mjs")
        with open(js, "w") as f:
            f.write("""import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW);
const [,, url, out] = process.argv;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
await p.goto(url);
await p.screenshot({ path: out, fullPage: true });
await b.close();
""")
        for name, r_ in (("53-hotspot-report.png", run), ("54-kriging-report.png", run3)):
            if r_.get("dir"):
                p = subprocess.run(["node", js, "file://" + os.path.join(r_["dir"], "report.html"), os.path.join(a.out, name)], env={**os.environ, "PW": a.pw}, capture_output=True, text=True)
                check(p.returncode == 0, f"screenshot {name}" + ("" if p.returncode == 0 else f": {p.stderr[-300:]}"))

    results["seconds"] = round(time.time() - t_all, 1)
    if a.results:
        with open(a.results, "w") as f:
            json.dump(results, f, indent=1, default=str)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'PASS' if not fails else 'FAIL'}: spatial statistics checks in {results['seconds']} s" + (f" — {len(fails)} failed:\n  " + "\n  ".join(fails) if fails else ""))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    main()
