//! `taxa.worms`: check a layer's species names against the World Register of Marine Species.
//!
//! Every distinct name in the chosen field is matched with WoRMS's AphiaRecordsByMatchNames service
//! (50 names a request, as WoRMS allows), and the layer is copied with what WoRMS says about it:
//! the AphiaID, how it matched (exact, subgenus, phonetic, near), its status, the accepted name and
//! ID for synonyms, the classification, the habitat flags and the record's address. The original
//! names are never changed. Each name ends with a verdict for review: ok, synonym, check spelling
//! (fuzzy match), ambiguous (candidates with different accepted names) or not in WoRMS.
//!
//! Answers are kept in `<state>/worms/` for 30 days, so a re-run does not ask WoRMS again;
//! `base:` points at a mirror (the tests use a local server with recorded WoRMS answers).
use std::collections::BTreeMap;
use std::time::Instant;

use serde_json::{json, Value};

use super::features::{self, Feat, FeatureSet, Val};
use super::steps::{p_str, sanitize, StepCtx, StepOut};
use crate::raster;

pub const WORMS_BASE: &str = "https://www.marinespecies.org";
const BATCH: usize = 50;
const CACHE_DAYS: i64 = 30;

/// The fields added to the layer, in order.
pub const FIELDS: [(&str, &str); 16] = [
    ("worms_verdict", "string"),
    ("worms_id", "integer"),
    ("worms_name", "string"),
    ("worms_match", "string"),
    ("worms_status", "string"),
    ("worms_accepted", "string"),
    ("worms_accepted_id", "integer"),
    ("worms_rank", "string"),
    ("worms_kingdom", "string"),
    ("worms_phylum", "string"),
    ("worms_class", "string"),
    ("worms_order", "string"),
    ("worms_family", "string"),
    ("worms_habitat", "string"),
    ("worms_extinct", "string"),
    ("worms_url", "string"),
];

/// What WoRMS says about one name.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// ok · synonym · check spelling · ambiguous · not in WoRMS · not usable
    pub verdict: String,
    pub record: Option<Value>,
    /// accepted names of the candidates when they disagree
    pub candidates: Vec<String>,
}

fn s<'a>(r: &'a Value, k: &str) -> &'a str {
    r[k].as_str().unwrap_or("")
}

/// The name WoRMS is asked about: trimmed, single spaces, no trailing "sp." or "spp.".
pub fn clean(name: &str) -> String {
    let mut t: Vec<&str> = name.split_whitespace().collect();
    while matches!(t.last(), Some(&("sp." | "sp" | "spp." | "spp" | "cf." | "aff."))) {
        t.pop();
    }
    t.join(" ")
}

/// Keep the candidates inside a higher taxon (kingdom, phylum, class, order or family), which
/// settles homonyms: "Acropora" is a coral (Cnidaria) and an old bryozoan genus (Bryozoa).
pub fn within(records: Vec<Value>, taxa: &[String]) -> Vec<Value> {
    if taxa.is_empty() {
        return records;
    }
    records
        .into_iter()
        .filter(|r| ["kingdom", "phylum", "class", "order", "family"].iter().any(|k| taxa.iter().any(|t| s(r, k).eq_ignore_ascii_case(t))))
        .collect()
}

/// Pick a record and a verdict from WoRMS's candidates for one name.
pub fn judge(records: &[Value]) -> Verdict {
    if records.is_empty() {
        return Verdict { verdict: "not in WoRMS".into(), record: None, candidates: vec![] };
    }
    // candidates that point to different accepted taxa cannot be settled here
    let mut valid: Vec<String> = records.iter().map(|r| s(r, "valid_name").to_string()).filter(|v| !v.is_empty()).collect();
    valid.sort();
    valid.dedup();
    // prefer the record that is itself accepted, then the first
    let rec = records.iter().find(|r| s(r, "status") == "accepted").unwrap_or(&records[0]).clone();
    let m = s(&rec, "match_type");
    let status = s(&rec, "status");
    let verdict = if valid.len() > 1 {
        "ambiguous"
    } else if m.starts_with("phonetic") || m.starts_with("near") {
        "check spelling"
    } else if status == "quarantined" || status == "deleted" || m.contains("quarantine") || m.contains("deleted") {
        "not usable"
    } else if status != "accepted" && rec["valid_AphiaID"].as_i64().is_some_and(|v| Some(v) != rec["AphiaID"].as_i64()) {
        "synonym"
    } else {
        "ok"
    };
    Verdict { verdict: verdict.into(), record: Some(rec), candidates: if valid.len() > 1 { valid } else { vec![] } }
}

/// The values of FIELDS for one verdict.
pub fn values(v: &Verdict) -> Vec<Val> {
    let Some(r) = &v.record else {
        let mut out = vec![Val::Str(v.verdict.clone())];
        out.extend(std::iter::repeat_n(Val::Null, FIELDS.len() - 1));
        return out;
    };
    let txt = |k: &str| if s(r, k).is_empty() { Val::Null } else { Val::Str(s(r, k).to_string()) };
    let int = |k: &str| r[k].as_i64().map(Val::Int).unwrap_or(Val::Null);
    let habitat: Vec<&str> = [("isMarine", "marine"), ("isBrackish", "brackish"), ("isFreshwater", "freshwater"), ("isTerrestrial", "terrestrial")]
        .iter()
        .filter(|(k, _)| r[*k].as_i64() == Some(1))
        .map(|(_, l)| *l)
        .collect();
    let accepted = if v.candidates.is_empty() { txt("valid_name") } else { Val::Str(v.candidates.join(" | ")) };
    vec![
        Val::Str(v.verdict.clone()),
        int("AphiaID"),
        txt("scientificname"),
        txt("match_type"),
        txt("status"),
        accepted,
        if v.candidates.is_empty() { int("valid_AphiaID") } else { Val::Null },
        txt("rank"),
        txt("kingdom"),
        txt("phylum"),
        txt("class"),
        txt("order"),
        txt("family"),
        if habitat.is_empty() { Val::Null } else { Val::Str(habitat.join(", ")) },
        match r["isExtinct"].as_i64() {
            Some(1) => Val::Str("extinct".into()),
            Some(0) => Val::Str("extant".into()),
            _ => Val::Null,
        },
        txt("url"),
    ]
}

fn enc(s: &str) -> String {
    s.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect()
}

/// The request for up to 50 names.
pub fn match_url(base: &str, names: &[String]) -> String {
    let q: Vec<String> = names.iter().map(|n| format!("scientificnames%5B%5D={}", enc(n))).collect();
    format!("{}/rest/AphiaRecordsByMatchNames?{}&marine_only=false", base.trim_end_matches('/'), q.join("&"))
}

/// One answer per name, in order (WoRMS answers 204 with no body when nothing matches).
pub fn parse_answer(body: &[u8], n: usize) -> Result<Vec<Vec<Value>>, String> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(vec![vec![]; n]);
    }
    let v: Value = serde_json::from_slice(body).map_err(|e| format!("WoRMS: unexpected answer ({e})"))?;
    let arr = v.as_array().ok_or("WoRMS: unexpected answer (not a list)")?;
    let mut out: Vec<Vec<Value>> = arr.iter().map(|g| g.as_array().cloned().unwrap_or_default()).collect();
    out.resize(n, vec![]);
    Ok(out)
}

fn cache_path(sc: &StepCtx) -> std::path::PathBuf {
    sc.engine.state_dir.join("worms").join("names.json")
}

pub(super) fn worms(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let t0 = Instant::now();
    let layer_id = p_str(p, "layer").ok_or("layer is required: the layer with species names")?.to_string();
    let l = sc.layer(&layer_id)?;
    let field = match p_str(p, "field") {
        Some(f) => f.to_string(),
        None => l
            .info
            .fields
            .iter()
            .find(|f| f.kind == "string" && ["species", "scientificname", "scientific_name", "taxon", "taxon_name", "name"].contains(&f.name.to_ascii_lowercase().as_str()))
            .map(|f| f.name.clone())
            .ok_or("field is required: the field with scientific names (no species or scientificName field found)")?,
    };
    if !l.info.fields.iter().any(|f| f.name == field) {
        return Err(format!("{}: no field '{field}'", sc.title_of(&l)));
    }
    let mut fs = features::read_layer(sc.engine, &l, None, None, 500_000)?;
    let col = fs.field(&field).ok_or_else(|| format!("field '{field}' cannot be read"))?;
    // distinct names, cleaned
    let names: Vec<String> = {
        let mut v: Vec<String> = fs.feats.iter().map(|f| clean(&f.props[col].text())).filter(|n| !n.is_empty()).collect();
        v.sort();
        v.dedup();
        v
    };
    if names.is_empty() {
        return Err(format!("{}: '{field}' has no names", sc.title_of(&l)));
    }
    let base = p_str(p, "base").unwrap_or(WORMS_BASE).to_string();
    // answers already known (30 days), then WoRMS for the rest
    let cpath = cache_path(sc);
    let mut cache: BTreeMap<String, Value> = std::fs::read(&cpath).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    let today = chrono::Local::now().date_naive();
    let fresh = |e: &Value| e["base"].as_str() == Some(base.as_str()) && e["date"].as_str().and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()).is_some_and(|d| (today - d).num_days() < CACHE_DAYS);
    let todo: Vec<String> = names.iter().filter(|n| !cache.get(*n).is_some_and(fresh)).cloned().collect();
    let mut asked = 0usize;
    for chunk in todo.chunks(BATCH) {
        if sc.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let body = raster::http(&match_url(&base, chunk), None, 120).map_err(|e| format!("WoRMS: {e} (no internet, or WoRMS is down; `base:` sets a mirror)"))?;
        for (name, recs) in chunk.iter().zip(parse_answer(&body, chunk.len())?) {
            cache.insert(name.clone(), json!({ "records": recs, "date": today.format("%Y-%m-%d").to_string(), "base": base }));
        }
        asked += 1;
    }
    if asked > 0 {
        if let Some(d) = cpath.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(&cpath, serde_json::to_vec(&cache).unwrap_or_default());
    }
    let scope: Vec<String> = super::steps::p_list(p, "within").iter().flat_map(|s| s.split(',').map(|x| x.trim().to_string()).collect::<Vec<_>>()).filter(|s| !s.is_empty()).collect();
    let verdicts: BTreeMap<String, Verdict> = names
        .iter()
        .map(|n| {
            let recs: Vec<Value> = cache.get(n).and_then(|e| e["records"].as_array().cloned()).unwrap_or_default();
            (n.clone(), judge(&within(recs, &scope)))
        })
        .collect();
    // the layer with the WoRMS fields
    // a layer checked before: its WoRMS fields are replaced, not added twice
    let keep: Vec<usize> = (0..fs.fields.len()).filter(|&i| !FIELDS.iter().any(|(f, _)| *f == fs.fields[i].0)).collect();
    let mut out = FeatureSet::new(fs.kind, keep.iter().map(|&i| fs.fields[i].clone()).chain(FIELDS.iter().map(|(n, k)| (n.to_string(), *k))).collect());
    let blank = Verdict { verdict: "no name".into(), record: None, candidates: vec![] };
    for f in fs.feats.drain(..) {
        let name = clean(&f.props[col].text());
        let v = if name.is_empty() { &blank } else { &verdicts[&name] };
        let mut props: Vec<Val> = keep.iter().map(|&i| f.props[i].clone()).collect();
        props.extend(values(v));
        out.feats.push(Feat { geom: f.geom, props });
    }
    out.total = out.feats.len() as u64;
    let count = |k: &str| verdicts.values().filter(|v| v.verdict == k).count();
    let (ok, syn, fuzzy, amb, none, bad) = (count("ok"), count("synonym"), count("check spelling"), count("ambiguous"), count("not in WoRMS"), count("not usable"));
    let name = sanitize(p_str(p, "name").unwrap_or(&format!("{}_worms", sanitize(&l.info.name))));
    let id = sc.write_output(&name, &out, format!("{} (names checked with WoRMS)", sc.title_of(&l)))?;
    let date = today.format("%Y-%m-%d");
    let citation = format!("WoRMS Editorial Board (2026). World Register of Marine Species. Available from https://www.marinespecies.org at VLIZ. Accessed {date}. doi:10.14284/170");
    sc.methods.push(format!(
        "Scientific names in '{field}' ({} distinct) were matched against the World Register of Marine Species (AphiaRecordsByMatchNames, marine and non-marine taxa{}): {ok} accepted as written, {syn} synonyms with their accepted names, {fuzzy} fuzzy matches to check, {amb} ambiguous, {none} not in WoRMS{}. Original names were kept; WoRMS fields were added. {citation}",
        names.len(),
        if scope.is_empty() { String::new() } else { format!("; candidates kept within {}", scope.join(", ")) },
        if bad > 0 { format!(", {bad} quarantined or deleted") } else { String::new() }
    ));
    sc.cards.push(("Names in WoRMS".into(), format!("{} of {}", names.len() - none, names.len())));
    if syn + fuzzy + amb + bad > 0 {
        sc.cards.push(("To review".into(), format!("{}", syn + fuzzy + amb + bad)));
    }
    let table: Vec<Value> = verdicts
        .iter()
        .map(|(n, v)| {
            let r = v.record.as_ref();
            json!({ "name": n, "verdict": v.verdict, "match": r.map(|r| s(r, "match_type")), "status": r.map(|r| s(r, "status")),
                "accepted": if v.candidates.is_empty() { r.map(|r| s(r, "valid_name").to_string()) } else { Some(v.candidates.join(" | ")) }, "aphia_id": r.and_then(|r| r["AphiaID"].as_i64()) })
        })
        .collect();
    Ok(StepOut {
        outputs: json!({ "layer": id, "names": names.len(), "ok": ok, "synonyms": syn, "check_spelling": fuzzy, "ambiguous": amb, "not_found": none, "not_usable": bad,
            "asked_worms": asked, "table": table, "citation": citation, "seconds": t0.elapsed().as_secs_f64() }),
        why: vec![format!("{} name(s) in '{field}': {ok} ok, {syn} synonym(s), {fuzzy} to check, {amb} ambiguous, {none} not in WoRMS ({asked} request(s) to WoRMS)", names.len())],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(id: i64, name: &str, status: &str, valid: i64, valid_name: &str, m: &str) -> Value {
        json!({ "AphiaID": id, "scientificname": name, "status": status, "valid_AphiaID": valid, "valid_name": valid_name, "match_type": m, "rank": "Species", "family": "F", "isMarine": 1, "isBrackish": 0, "isExtinct": 0, "url": format!("https://www.marinespecies.org/aphia.php?p=taxdetails&id={id}") })
    }

    #[test]
    fn verdicts() {
        // answers recorded from WoRMS on 2026-10-22
        assert_eq!(judge(&[rec(137206, "Chelonia mydas", "accepted", 137206, "Chelonia mydas", "exact")]).verdict, "ok");
        let syn = judge(&[rec(1519273, "Acropora (Acropora) formosa", "junior subjective synonym", 207007, "Acropora muricata", "exact_subgenus"), rec(1563389, "Acropora (Eumadrepora) formosa", "junior subjective synonym", 207007, "Acropora muricata", "exact_subgenus")]);
        assert_eq!(syn.verdict, "synonym");
        assert_eq!(values(&syn)[5], Val::Str("Acropora muricata".into()));
        assert_eq!(values(&syn)[6], Val::Int(207007));
        assert_eq!(judge(&[rec(137206, "Chelonia mydas", "accepted", 137206, "Chelonia mydas", "phonetic")]).verdict, "check spelling");
        assert_eq!(judge(&[]).verdict, "not in WoRMS");
        let amb = judge(&[rec(1, "A x", "accepted", 1, "A x", "exact"), rec(2, "A x", "unaccepted", 3, "B y", "exact")]);
        assert_eq!(amb.verdict, "ambiguous");
        assert_eq!(values(&amb)[5], Val::Str("A x | B y".into()));
        assert_eq!(values(&amb)[13], Val::Str("marine".into()));
        assert_eq!(values(&judge(&[])).len(), FIELDS.len());
    }

    #[test]
    fn homonyms_within_a_group() {
        // WoRMS 2026-10-22: Acropora Oken, 1815 (Cnidaria, accepted) and Acropora Reuss, 1869 (Bryozoa → Porina)
        let mut coral = rec(205469, "Acropora", "accepted", 205469, "Acropora", "exact");
        coral["phylum"] = json!("Cnidaria");
        let mut bryo = rec(578625, "Acropora", "unaccepted", 1, "Porina", "exact");
        bryo["phylum"] = json!("Bryozoa");
        assert_eq!(judge(&[coral.clone(), bryo.clone()]).verdict, "ambiguous");
        let v = judge(&within(vec![coral, bryo], &["cnidaria".into()]));
        assert_eq!((v.verdict.as_str(), values(&v)[5].clone()), ("ok", Val::Str("Acropora".into())));
    }

    #[test]
    fn names_and_requests() {
        assert_eq!(clean("  Chelonia   mydas "), "Chelonia mydas");
        assert_eq!(clean("Acropora sp."), "Acropora");
        let u = match_url("https://www.marinespecies.org/", &["Chelonia mydas".into(), "Tridacna gigas".into()]);
        assert_eq!(u, "https://www.marinespecies.org/rest/AphiaRecordsByMatchNames?scientificnames%5B%5D=Chelonia%20mydas&scientificnames%5B%5D=Tridacna%20gigas&marine_only=false");
        assert_eq!(parse_answer(b"", 3).unwrap(), vec![Vec::<Value>::new(); 3]);
        let a = parse_answer(br#"[[{"AphiaID":1}],[],null]"#, 3).unwrap();
        assert_eq!((a[0].len(), a[1].len(), a[2].len()), (1, 0, 0));
    }
}
