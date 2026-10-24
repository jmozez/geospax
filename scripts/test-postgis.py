#!/usr/bin/env python3
"""PostGIS databases in the Explorer, end to end against a throwaway PostgreSQL + PostGIS server.

Starts a cluster with password login (md5) in a temporary folder, makes a table of 8 plots (points) and
one without geometry, then checks: an address with a password in it is refused (pgpass is the place); the
database connects with the password read from a pgpass file; only the spatial table is listed; clicking it
copies all 8 plots to the map; with a map-view box only the plots inside come; an unknown table is refused.

Skips (exit 0) when PostgreSQL's initdb or the PostGIS extension is not installed.

    python3 scripts/test-postgis.py [--bin target/release/geospax-server]
"""
import argparse, glob, json, os, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request
from urllib.parse import quote

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
failed = []


def check(ok, msg):
    print(("  ok    " if ok else "  FAIL  ") + msg)
    if not ok:
        failed.append(msg)


def pg_bin():
    for d in sorted(glob.glob("/usr/lib/postgresql/*/bin"), reverse=True):
        if os.path.exists(os.path.join(d, "initdb")):
            return d
    p = shutil.which("initdb")
    return os.path.dirname(p) if p else None


def call(base, method, path):
    req = urllib.request.Request(base + path, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bin", default=os.path.join(ROOT, "target/release/geospax-server"))
    a = ap.parse_args()
    bindir = pg_bin()
    if not bindir or not glob.glob("/usr/share/postgresql/*/extension/postgis.control"):
        print("skip: PostgreSQL or PostGIS is not installed (apt install postgresql postgresql-postgis)")
        if os.environ.get("GEOSPAX_REQUIRE_POSTGIS") == "1":
            sys.exit(1)  # CI installs them: a skip there would hide a broken setup
        return
    tmp = tempfile.mkdtemp(prefix="gx-postgis-")
    os.chmod(tmp, 0o777)
    pgdata, sock = os.path.join(tmp, "pg"), os.path.join(tmp, "sock")
    os.makedirs(sock)
    os.chmod(sock, 0o777)
    pw = os.path.join(tmp, "pw")
    with open(pw, "w") as f:
        f.write("s3cret\n")
    os.chmod(pw, 0o644)
    # PostgreSQL will not run as root: run it as the postgres user then
    as_pg = ["runuser", "-u", "postgres", "--"] if os.geteuid() == 0 else []
    port = 25433
    run = lambda *c: subprocess.run(as_pg + list(c), check=True, capture_output=True, text=True)
    run(os.path.join(bindir, "initdb"), "-D", pgdata, "-U", "gis", "--auth=md5", f"--pwfile={pw}")
    # the server's output goes to a log file: it would otherwise keep this script's pipe open forever
    subprocess.run(as_pg + [os.path.join(bindir, "pg_ctl"), "-D", pgdata, "-l", os.path.join(tmp, "pg.log"), "-o", f"-p {port} -k {sock} -c listen_addresses=127.0.0.1", "-w", "start"],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
    env_pg = dict(os.environ, PGPASSWORD="s3cret")
    try:
        sql = """CREATE EXTENSION postgis;
CREATE TABLE plots (id serial primary key, name text, ha double precision, geom geometry(Point, 4326));
INSERT INTO plots (name, ha, geom) SELECT 'plot ' || i, i * 1.5, ST_SetSRID(ST_MakePoint(145 + i * 0.1, -6 - i * 0.05), 4326) FROM generate_series(1, 8) i;
CREATE TABLE notes (id int, txt text);"""
        subprocess.run(["psql", "-h", "127.0.0.1", "-p", str(port), "-U", "gis", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], check=True, env=env_pg, capture_output=True)
        pgpass = os.path.join(tmp, "pgpass")
        with open(pgpass, "w") as f:
            f.write(f"127.0.0.1:{port}:postgres:gis:s3cret\n")
        os.chmod(pgpass, 0o600)
        data = os.path.join(tmp, "data")
        os.makedirs(data)
        env = {k: v for k, v in os.environ.items() if k.lower() not in ("http_proxy", "https_proxy")}
        env.update(PGPASSFILE=pgpass, NO_PROXY="127.0.0.1,localhost")
        env.pop("PGPASSWORD", None)
        gport = 18741
        srv = subprocess.Popen([a.bin, "--data", data, "--state-dir", os.path.join(tmp, "state"), "--port", str(gport), "--no-device-mounts", "--no-triggers"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
        base = f"http://127.0.0.1:{gport}"
        for _ in range(60):
            try:
                urllib.request.urlopen(base + "/api/health", timeout=2)
                break
            except Exception:
                time.sleep(0.5)
        try:
            url = f"postgresql://gis@127.0.0.1:{port}/postgres"
            code, body = call(base, "POST", f"/api/services?kind=postgis&url={quote(f'postgresql://gis:s3cret@127.0.0.1:{port}/postgres', safe='')}")
            check(code == 400 and b"pgpass" in body, f"an address with a password in it is refused ({code} {body[:100]})")
            code, body = call(base, "POST", f"/api/services?kind=postgis&url={quote(url, safe='')}")
            svc = json.loads(body).get("service", {}) if code == 200 else {}
            check(code == 200 and svc.get("title") == "postgres", f"connects with the password from pgpass ({code} {body[:200]})")
            sid = svc.get("id", "")
            ls = json.loads(call(base, "GET", f"/api/services/{sid}/layers")[1]).get("layers", [])
            check([l["id"] for l in ls] == ["plots"] and ls[0].get("note") == "points", f"only the spatial table is listed ({ls})")
            code, body = call(base, "POST", f"/api/services/{sid}/open?path=plots")
            r = json.loads(body) if body else {}
            check(code == 200 and r.get("features") == 8 and r.get("layers"), f"a table goes on the map ({code} {r})")
            code, body = call(base, "POST", f"/api/services/{sid}/open?path=plots&bbox=145.05,-6.3,145.35,-6")
            r = json.loads(body) if body else {}
            check(code == 200 and r.get("features") == 3, f"only the part in the map view ({code} {r})")
            code, body = call(base, "POST", f"/api/services/{sid}/open?path=notes")
            check(code == 502, f"a table that is not spatial (or not there) is refused ({code})")
        finally:
            srv.kill()
    finally:
        subprocess.run(as_pg + [os.path.join(bindir, "pg_ctl"), "-D", pgdata, "-m", "immediate", "stop"], capture_output=True)
    print(f"\n{'PASS' if not failed else 'FAIL'}: {len(failed)} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
