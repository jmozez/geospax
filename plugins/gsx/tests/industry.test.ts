// Known-answer tests for the industry and ENSO helpers (surveying, energy, logistics, climate).
import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { converter, utmFor } from "../src/industry/crs";
import { parseZones } from "../src/industry/energy";
import { ensoPhase, parseEnso } from "../src/industry/enso";
import { tour } from "../src/industry/sectors";
import { bowditch, dms, parseBearing, parseLegs } from "../src/industry/survey";

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

describe("surveying", () => {
  it("reads bearings as DMS, decimal and quadrant", () => {
    near(parseBearing("45 30 20"), 45 + 30 / 60 + 20 / 3600, 1e-9);
    near(parseBearing("45.3020"), 45 + 30 / 60 + 20 / 3600, 1e-9);
    near(parseBearing("45.5", "decimal"), 45.5, 1e-12);
    near(parseBearing("S 30 E"), 150, 1e-9);
    near(parseBearing("N 30 W"), 330, 1e-9);
    assert.equal(dms(90), `90°00'00"`);
  });
  it("closes a square traverse by the compass rule", () => {
    const legs = parseLegs("0 100\n90 100.02\n180 100\n270 100", "dms");
    const r = bowditch([500000, 9000000], legs, [500000, 9000000]) as any;
    near(r.misclosure, 0.02, 1e-6);
    near(r.ratio, 20001, 1);
    const last = r.adjusted[r.adjusted.length - 1];
    near(last[0], 500000, 1e-6);
    near(last[1], 9000000, 1e-6);
  });
  it("projects Port Moresby into UTM 55S", () => {
    assert.equal(utmFor(147.18, -9.44), "EPSG:32755");
    const [e, n] = converter("EPSG:4326", "EPSG:32755").forward([147, -9]);
    near(e, 500000, 0.01);
    near(n, 9005147.82, 0.05);
  });
});

describe("energy corridors", () => {
  it("parses and sorts zone widths", () => {
    assert.deepEqual(parseZones("consultation:100, easement:20; clearance:50"), [{ name: "easement", m: 20 }, { name: "clearance", m: 50 }, { name: "consultation", m: 100 }]);
    assert.deepEqual(parseZones("30"), [{ name: "30 m", m: 30 }]);
    assert.throws(() => parseZones("easement:-5"));
  });
});

describe("logistics", () => {
  it("finds the shortest round trip along a line of stops", () => {
    const x = [100, 700, 300, 500];
    const c = x.map((a) => x.map((b) => Math.abs(a - b)));
    const o = tour(c, true);
    const len = o.reduce((s, v, i) => s + (i ? c[o[i - 1]][v] : 0), 0) + c[o[o.length - 1]][o[0]];
    assert.equal(o[0], 0);
    assert.equal(len, 1200);
  });
});

describe("ENSO", () => {
  const fx = (f: string) => fs.readFileSync(new URL(`./fixtures/enso/${f}`, import.meta.url), "utf8");
  it("reads the ONI, weekly Niño 3.4 and SOI files", () => {
    const oni = parseEnso("oni", fx("oni.ascii.txt"));
    assert.ok(oni.length > 50);
    near(oni[oni.length - 1].v, 2.16, 1e-9);
    const n34 = parseEnso("nino34", fx("wksst9120.for"));
    near(n34[n34.length - 1].v, 3.4, 1e-9);
    const soi = parseEnso("soi", fx("soi_monthly.txt"));
    near(soi[soi.length - 1].v, -21.4, 1e-9);
  });
  it("names the phase", () => {
    assert.equal(ensoPhase("oni", 2.16), "El Niño (very strong)");
    assert.equal(ensoPhase("oni", -0.7), "La Niña (weak)");
    assert.equal(ensoPhase("oni", 0.2), "neutral");
    assert.match(ensoPhase("soi", -21.4), /^El Niño/);
  });
});
