import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { citationString } from "../src/data/types";
import { gbifSearchUrl } from "../src/data/connectors/gbif";
import { obisSearchUrl } from "../src/data/connectors/obis";
import { inatSearchUrl } from "../src/data/connectors/inat";
import { wormsAphiaUrl } from "../src/data/connectors/worms";
import { worldbankUrl } from "../src/data/connectors/worldbank";
import { GEBCO_META, gebcoTileUrl } from "../src/data/catalogue/gebco";
import {
  ECOREGION_CATALOGUE,
  ecoregionFeatureCount,
} from "../src/data/catalogue/ecoregion";
import { CONNECTORS, CATALOGUE_TIERS, ALL_SOURCES } from "../src/data/index";

describe("geospax-data: citation string", () => {
  it("formats DOI", () => {
    const s = citationString({
      title: "T",
      publisher: "P",
      year: 2020,
      doi: "10.1/abc",
      accessedAt: "2024-01-01",
    });
    assert.ok(s.includes("DOI:10.1/abc"));
    assert.ok(s.includes("2020"));
  });
});

describe("gbif connector", () => {
  it("builds URL with taxon and bbox", () => {
    const u = gbifSearchUrl("Paradisaea apoda", [140, -10, 150, 0], 50);
    assert.ok(u.includes("api.gbif.org"));
    assert.ok(u.includes("Paradisaea"));
    assert.ok(u.includes("decimalLongitude"));
    assert.ok(u.includes("limit=50"));
  });
  it("clamps limit", () => {
    const u = gbifSearchUrl("x", undefined, 9999);
    assert.ok(u.includes("limit=300"));
  });
});

describe("obis connector", () => {
  it("builds geometry polygon for bbox", () => {
    const u = obisSearchUrl("Thunnus", [140, -5, 145, 0]);
    assert.ok(u.includes("api.obis.org"));
    assert.ok(u.includes("POLYGON"));
  });
});

describe("inat connector", () => {
  it("research grade and bbox", () => {
    const u = inatSearchUrl("Myrmecodia", [140, -10, 150, 0], 10);
    assert.ok(u.includes("inaturalist.org"));
    assert.ok(u.includes("quality_grade=research"));
    assert.ok(u.includes("nelat=0"));
  });
});

describe("worms connector", () => {
  it("aphia URL encodes taxon", () => {
    const u = wormsAphiaUrl("Acanthaster planci");
    assert.ok(u.includes("Acanthaster"));
    assert.ok(u.includes("marinespecies.org"));
  });
});

describe("worldbank connector", () => {
  it("country/indicator URL", () => {
    const u = worldbankUrl("PG", "SP.POP.TOTL", 2018, 2022);
    assert.ok(u.includes("worldbank.org"));
    assert.ok(u.includes("PG"));
    assert.ok(u.includes("SP.POP.TOTL"));
  });
});

describe("GEBCO catalogue", () => {
  it("tile URL and meta", () => {
    assert.equal(gebcoTileUrl(0, 0, 0), "https://tiles.gebco.net/gebco/0/0/0.png");
    assert.equal(GEBCO_META.tier, "catalogue");
  });
});

describe("ecoregion catalogue", () => {
  it("counts 846 + 232", () => {
    assert.equal(ecoregionFeatureCount("teow-846"), 846);
    assert.equal(ecoregionFeatureCount("meow-232"), 232);
    assert.equal(ECOREGION_CATALOGUE.length, 3);
  });
  it("null on unknown", () => {
    assert.equal(ecoregionFeatureCount("unknown"), null);
  });
});

describe("data package tiers", () => {
  it("5 live +5 catalogue =10", () => {
    assert.equal(CONNECTORS.length, 5);
    assert.equal(CATALOGUE_TIERS.length, 5);
    assert.equal(ALL_SOURCES.length, 10);
    assert.ok(CONNECTORS.every((c) => c.tier === "live"));
    assert.ok(CATALOGUE_TIERS.every((c) => c.tier === "catalogue"));
  });
  it("citations carry DOI/URL", () => {
    for (const c of ALL_SOURCES) {
      assert.ok(c.citation.title.length > 5);
      assert.ok(c.citation.publisher.length > 2);
      assert.ok(c.citation.accessedAt);
    }
  });
});
