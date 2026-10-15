/* SkovPlan Felt – enkel feltapp (PWA).
 *
 * Læser skovens GeoPackage direkte på telefonen (sql.js), viser litraerne på et
 * kort med GPS-position og gemmer prøveflader, fotos og noter i telefonens
 * IndexedDB.  Skovkort og ortofoto kommer fra SkovPlans «Lav feltpakke til appen» (én zip).
 * «Eksportér» laver en zip, som SkovPlan henter med «Hent data fra app»:
 *   - taksationsark_felt_<dato>.csv  – samme kolonner som SkovPlans taksationsark,
 *     så filen kan indlæses med «Importér bevoksningsliste fra Excel/CSV…»
 *   - registreringer.geojson         – alle registreringer som punkter (WGS84)
 *   - fotos/                          – billederne
 */
"use strict";

const LAYERS = {
  skovafdelinger: { required: true },
  ejendomsgraense: { style: { color: "#b3261e", weight: 2.5, fill: false, dashArray: "6 4" } },
  adgangsveje: { style: { color: "#7a5230", weight: 3 } },
  kortlinjer: { style: { color: "#555", weight: 1.5, dashArray: "3 3" } },
  indgange: { style: { color: "#7a5230", radius: 5 } },
  aflaegningspladser: { style: { color: "#5b3a17", fillColor: "#f2c14e", fillOpacity: 1, weight: 2, radius: 7 } },
};
/* Lokale hensyn fra feltpakken (feltlag.json): navn i menuen «Vis lag», stil og evt. tekst ved klik. */
const EXTRA = {
  naturtyper: { name: "§3-naturtyper", style: { color: "#0a8f5a", weight: 2, dashArray: "6 3", fillColor: "#0a8f5a", fillOpacity: 0.14 },
    label: p => "§3 " + (p.Natyp_navn || "natur") },
  diger: { name: "Beskyttede diger", style: { color: "#6b4f2a", weight: 3.5, dashArray: "2 5", lineCap: "round" },
    info: p => "Beskyttet dige" + (p.Digetypebeskrivelse ? ": " + p.Digetypebeskrivelse : "") + (p.Stendige ? " (stendige)" : "") },
  fortidsminde_zoner: { name: "Fortidsminders beskyttelseszone", style: { color: "#8a3ffc", weight: 1.5, dashArray: "4 4", fill: false } },
  fortidsminder: { name: "Fortidsminder", style: { color: "#fff", weight: 2, fillColor: "#8a3ffc", fillOpacity: 1, radius: 7 },
    info: p => "Fortidsminde: " + [p.anlaegstype, p.datering, p.frednr ? "fredningsnr. " + p.frednr : ""].filter(Boolean).join(" · ") },
};
const STAND_FIELDS = ["compartment_id", "navn", "afdeling", "afdeling_nr", "litra", "træart", "etableringsaar",
  "alder", "middelhoejde_m", "middeldiameter_cm", "stamtal_ha", "grundflade_m2_ha", "vedmasse_m3_ha",
  "areal_ha", "bemærkning", "taksationsaar", "dataaar", "p3_status", "p3_naturtyper"];
const RADII = [5.64, 7.98, 10, 12.62, 15];
const YEAR = new Date().getFullYear();

/* ------------------------------------------------------------------ helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const num = v => { if (v === null || v === undefined || v === "") return null; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const fmt = (v, d = 1) => v === null || v === undefined || !Number.isFinite(Number(v)) ? "–" : Number(v).toLocaleString("da-DK", { minimumFractionDigits: d, maximumFractionDigits: d });
const csvNum = (v, d) => v === null || v === undefined || !Number.isFinite(v) ? "" : (d === 0 ? String(Math.round(v)) : v.toFixed(d).replace(".", ","));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Date().toISOString().slice(0, 10);
function toast(msg, ms = 2600) { const t = $("#toast"); t.textContent = msg; t.classList.remove("hidden"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add("hidden"), ms); }
const standKey = p => `${p.afdeling_nr ?? ""}|${String(p.litra ?? "").trim().toLowerCase()}`;
const standLabel = p => p.afdeling || `${p.afdeling_nr ?? ""}${p.litra ?? ""}` || p.navn || "?";

/* ------------------------------------------------------------------ IndexedDB */
const db = {
  _db: null,
  open() {
    if (this._db) return Promise.resolve(this._db);
    return new Promise((res, rej) => {
      const r = indexedDB.open("skovplan-felt", 2);
      r.onupgradeneeded = () => {
        const d = r.result, have = n => d.objectStoreNames.contains(n);
        if (!have("kv")) d.createObjectStore("kv");
        if (!have("regs")) d.createObjectStore("regs", { keyPath: "id" });
        if (!have("tiles")) d.createObjectStore("tiles");
      };
      r.onsuccess = () => res(this._db = r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async tx(store, mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const s = t.objectStore(store); let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error);
    });
  },
  req: r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }),
  get(store, key) { return this.tx(store, "readonly", s => this.req(s.get(key))); },
  put(store, val, key) { return this.tx(store, "readwrite", s => { key === undefined ? s.put(val) : s.put(val, key); }); },
  del(store, key) { return this.tx(store, "readwrite", s => { s.delete(key); }); },
  all(store) { return this.tx(store, "readonly", s => this.req(s.getAll())); },
  clear(store) { return this.tx(store, "readwrite", s => { s.clear(); }); },
  delPrefix(store, prefix) { return this.tx(store, "readwrite", s => { s.delete(IDBKeyRange.bound(prefix, prefix + "\uffff")); }); },
  keys(store) { return this.tx(store, "readonly", s => this.req(s.getAllKeys())); },
  putMany(store, entries) { return this.tx(store, "readwrite", s => { for (const [k, v] of entries) s.put(v, k); }); },
};

/* ------------------------------------------------------------------ UTM 32N (ETRS89) -> WGS84 */
function utmToLatLon(E, N, zone = 32) {
  const a = 6378137, f = 1 / 298.257222101, k0 = 0.9996;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2), x = E - 500000, y = N;
  const M = y / k0, mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
    + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
  const N1 = a / Math.sqrt(1 - e2 * s * s), T1 = t * t, C1 = ep2 * c * c, R1 = a * (1 - e2) / (1 - e2 * s * s) ** 1.5, D = x / (N1 * k0);
  const lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4 / 24
    + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6 / 720);
  const lon = (D - (1 + 2 * T1 + C1) * D ** 3 / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5 / 120) / c;
  return [lon * 180 / Math.PI + (zone * 6 - 183), lat * 180 / Math.PI];
}

/* ------------------------------------------------------------------ GeoPackage geometry (GP header + WKB) */
function gpkgToGeoJSON(blob, transform) {
  if (!blob || blob.length < 8 || blob[0] !== 0x47 || blob[1] !== 0x50) return null;
  const flags = blob[3], envLen = [0, 32, 48, 48, 64][(flags >> 1) & 7] || 0;
  if (flags & 0x10) return null; // tom geometri
  const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  let o = 8 + envLen;
  function geom() {
    const le = dv.getUint8(o) === 1; o += 1;
    let type = dv.getUint32(o, le); o += 4;
    let dims = 2;
    if (type & 0x80000000) dims++; if (type & 0x40000000) dims++; type &= 0x0fffffff; // EWKB
    if (type > 1000) { const k = Math.floor(type / 1000); dims = k === 3 ? 4 : 3; type %= 1000; } // ISO Z/M
    const pt = () => { const X = dv.getFloat64(o, le), Y = dv.getFloat64(o + 8, le); o += 8 * dims; return transform(X, Y); };
    const line = () => { const n = dv.getUint32(o, le); o += 4; const r = []; for (let i = 0; i < n; i++) r.push(pt()); return r; };
    const poly = () => { const n = dv.getUint32(o, le); o += 4; const r = []; for (let i = 0; i < n; i++) r.push(line()); return r; };
    const multi = () => { const n = dv.getUint32(o, le); o += 4; const r = []; for (let i = 0; i < n; i++) r.push(geom().coordinates); return r; };
    switch (type) {
      case 1: return { type: "Point", coordinates: pt() };
      case 2: return { type: "LineString", coordinates: line() };
      case 3: return { type: "Polygon", coordinates: poly() };
      case 4: return { type: "MultiPoint", coordinates: multi() };
      case 5: return { type: "MultiLineString", coordinates: multi() };
      case 6: return { type: "MultiPolygon", coordinates: multi() };
      default: throw new Error("Ukendt geometritype " + type);
    }
  }
  return geom();
}

let SQL = null;
/* QGIS gemmer GeoPackages i WAL-tilstand, som sql.js ikke kan åbne. Vi læser kun, så filen sættes til almindelig journal. */
function sqliteBytes(buf) {
  const b = new Uint8Array(buf);
  if (b.length > 100 && b[18] === 2 && b[19] === 2) { b[18] = 1; b[19] = 1; }
  return b;
}
async function openSqlite(file) {
  SQL = SQL || await initSqlJs({ locateFile: f => "lib/" + f });
  return new SQL.Database(sqliteBytes(await file.arrayBuffer()));
}
const hasTable = (g, t) => !!g.exec(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='${t}'`)[0];
function readGpkg(g, file) {
  {
    const contents = {};
    const r = g.exec("SELECT table_name, srs_id FROM gpkg_contents WHERE data_type='features'");
    (r[0]?.values || []).forEach(([t, srs]) => contents[t] = srs);
    if (!("skovafdelinger" in contents)) throw new Error("Filen har ikke laget «skovafdelinger». Er det SkovPlans GeoPackage?");
    const out = {};
    for (const name of Object.keys(LAYERS)) {
      if (!(name in contents)) continue;
      const srs = contents[name];
      const transform = srs === 25832 ? (x, y) => utmToLatLon(x, y, 32).map(v => +v.toFixed(7))
        : srs === 25833 ? (x, y) => utmToLatLon(x, y, 33).map(v => +v.toFixed(7))
        : srs === 4326 ? (x, y) => [x, y] : null;
      if (!transform) { console.warn("Springer over", name, "srs", srs); continue; }
      const cols = g.exec(`PRAGMA table_info("${name}")`)[0].values.map(v => v[1]);
      const geomCol = (g.exec(`SELECT column_name FROM gpkg_geometry_columns WHERE table_name='${name}'`)[0]?.values[0][0]) || "geom";
      const keep = name === "skovafdelinger" ? STAND_FIELDS.filter(c => cols.includes(c)) : cols.filter(c => ["navn", "type", "vejtype", "linjetype", "sortiment", "aktivitet", "bemærkning"].includes(c));
      const sel = [`"${geomCol}"`, ...keep.map(c => `"${c}"`)].join(",");
      const res = g.exec(`SELECT ${sel} FROM "${name}"`)[0];
      const feats = [];
      for (const row of res?.values || []) {
        const geometry = gpkgToGeoJSON(row[0], transform);
        if (!geometry) continue;
        const props = {}; keep.forEach((c, i) => props[c] = row[i + 1]);
        feats.push({ type: "Feature", geometry, properties: props });
      }
      out[name] = { type: "FeatureCollection", features: feats };
    }
    let propName = "";
    try { propName = g.exec("SELECT navn FROM ejendomsgraense WHERE navn IS NOT NULL LIMIT 1")[0]?.values[0][0] || ""; } catch (e) { /* intet */ }
    return { layers: out, name: propName || file.name.replace(/\.gpkg$/i, ""), file: file.name, loaded: new Date().toISOString() };
  }
}

/* ------------------------------------------------------------------ prøveflade-beregning */
function plotStats(p) {
  const area = Math.PI * p.radius ** 2, ef = 10000 / area;
  let n = 0, sg = 0, sd2 = 0, sd3 = 0, sgh = 0, sgH = 0;
  for (const t of p.trees) {
    const d = num(t.d); if (!d) continue;
    const g = Math.PI / 4 * (d / 100) ** 2; n++; sg += g; sd2 += d * d; sd3 += d ** 3;
    const h = num(t.h); if (h) { sgh += g * h; sgH += g; }
  }
  return {
    // Dg er den kvadratiske middeldiameter (G = N·π/4·Dg²), som SkovPlans modeller bruger; Dgw er den grundfladevægtede Σd³/Σd².
    // En flade uden træer (kun Hg udfyldt) giver ikke N og G, så den trækker ikke litraets gennemsnit ned.
    ef, n, N: n ? n * ef : null, G: n ? sg * ef : null, Dg: n ? Math.sqrt(sd2 / n) : null, Dgw: sd2 ? sd3 / sd2 : null,
    // Målte højder går forud for et manuelt Hg ("hvis ikke målt på træer").
    Hg: sgH ? sgh / sgH : num(p.hg), heights: p.trees.filter(t => num(t.h)).length,
    _N: n * ef, _sd2: sd2 * ef, _sd3: sd3 * ef, _sgh: sgh * ef, _sgH: sgH * ef,
  };
}
/* CLAUDE-1162: litraets tal samles af enkelttræer med vægt (stk/ha pr. træ):
   - prøveflade: hvert klupret træ vejer fladens opskaleringsfaktor / antal enheder i litraet;
   - relaskop: artens G (BAF × talte, gennemsnit over punkterne) fordeles på artens målte træer i hele litraet
     (forholdsestimat pr. art: w = G_art / målte_art / g). Arter uden målte træer giver kun G, ikke N og Dg.
   Højder: Näslund-kurve h = 1,3 + (d/(a+b·d))² pr. art (ellers pr. litra) fra mindst 3 målte højder; træer uden målt
   højde får fladens manuelle Hg eller kurvens højde, og Hg = Loreys middelhøjde Σg·h/Σg over alle træer.
   Relaskoptal for en art er «skøn», til litraet har mindst MIN_SAMPLED målte træer af arten; skøn eksporteres ikke. */
const MIN_SAMPLED = 8;   // CLAUDE-1162
function naslund(pts) {   // CLAUDE-1162: lineær regression d/√(h−1,3) = a + b·d
  const P = pts.filter(([d, h]) => d > 0 && h > 1.3);
  if (P.length < 3) return null;
  const xs = P.map(p => p[0]), ys = P.map(([d, h]) => d / Math.sqrt(h - 1.3)), n = P.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  if (sxx < 1e-9) return null;
  const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx, a = my - b * mx;
  if (!(a > 0 && b > 0)) return null;   // kurven skal stige og flade ud; ellers bruges kun de målte højder
  return { a, b, n, h: d => 1.3 + (d / (a + b * d)) ** 2 };
}
/* Hvilken talt art et målt træ hører til (relaskop): samme art, ellers den eneste talte art, ellers «Blandet». */
const artMatcher = arts => a => arts.includes(a) ? a : arts.length === 1 ? arts[0] : arts.includes("Blandet") ? "Blandet" : null;   // CLAUDE-1162
function litraCalc(plots, standArt) {   // CLAUDE-1162
  const pfTrees = plots.filter(p => p.type === "proeveflade" && (p.data.trees || []).some(t => num(t.d) > 0));
  const vk = plots.filter(p => p.type === "vinkel"), P = pfTrees.length + vk.length;
  if (!P) return null;
  const trees = [], gOnly = {}, Gart = {}, samp = {};
  for (const p of pfTrees) {
    const ef = 10000 / (Math.PI * p.data.radius ** 2), hMan = num(p.data.hg);
    for (const t of p.data.trees) { const d = num(t.d); if (d > 0) trees.push({ art: t.art || standArt || "?", d, h: num(t.h), hMan, w: ef / P, src: "flade" }); }
  }
  const vstats = vk.map(p => vinkelStats(p.data));
  vstats.forEach(s => s.byArt.forEach(a => { Gart[a.art] = (Gart[a.art] || 0) + a.G / P; }));
  const match = artMatcher(Object.keys(Gart));
  for (const p of vk) for (const t of p.data.trees || []) {
    const d = num(t.d), a = d > 0 ? match(t.art) : null;
    if (a) (samp[a] = samp[a] || []).push({ d, h: num(t.h) });
  }
  for (const [a, G] of Object.entries(Gart)) {
    const S = samp[a] || [];
    if (!S.length) { gOnly[a] = G; continue; }
    for (const t of S) trees.push({ art: a, d: t.d, h: t.h, hMan: null, w: G / S.length / (Math.PI / 4 * (t.d / 100) ** 2), src: "relaskop" });
  }
  const curveAll = naslund(trees.filter(t => t.h).map(t => [t.d, t.h]));
  const arts = [...new Set([...trees.map(t => t.art), ...Object.keys(gOnly)])], curves = {};
  for (const a of arts) curves[a] = naslund(trees.filter(t => t.art === a && t.h).map(t => [t.d, t.h])) || curveAll;
  for (const t of trees) { const c = curves[t.art]; t.g = Math.PI / 4 * (t.d / 100) ** 2; t.hUse = t.h || t.hMan || (c ? c.h(t.d) : null); }
  const stats = (ts, gExtra = 0) => {
    let N = 0, G = 0, s2 = 0, s3 = 0, gh = 0, gH = 0;
    for (const t of ts) { N += t.w; G += t.w * t.g; s2 += t.w * t.d * t.d; s3 += t.w * t.d ** 3; if (t.hUse) { gh += t.w * t.g * t.hUse; gH += t.w * t.g; } }
    return { N: N || null, G: G + gExtra, Dg: N ? Math.sqrt(s2 / N) : null, Dgw: s2 ? s3 / s2 : null, Hg: gH ? gh / gH : null,
      heights: ts.filter(t => t.h).length, measured: ts.length };
  };
  const byArt = arts.map(a => {
    const ts = trees.filter(t => t.art === a), s = stats(ts, gOnly[a] || 0);
    if (gOnly[a]) Object.assign(s, { N: null, Dg: null, Dgw: null });
    return Object.assign(s, { art: a, relaskop: a in Gart, skoen: a in Gart && ts.length < MIN_SAMPLED, curve: curves[a] && curves[a] !== curveAll ? "art" : curves[a] ? "litra" : null });
  }).sort((x, y) => y.G - x.G);
  const total = stats(trees, Object.values(gOnly).reduce((a, b) => a + b, 0));
  total.complete = !Object.keys(gOnly).length;
  if (!total.complete) Object.assign(total, { N: null, Dg: null, Dgw: null });
  total.skoen = byArt.some(a => a.skoen);
  return { P, trees, byArt, total, curve: curveAll, missing: Object.keys(gOnly) };
}
function standSummary(regs) {
  const plots = regs.filter(r => r.type === "proeveflade" || r.type === "vinkel");
  const tax = regs.filter(r => r.type === "taksation").sort((a, b) => a.created.localeCompare(b.created)).pop();
  const out = { plots: plots.filter(p => p.type === "proeveflade").length, points: plots.filter(p => p.type === "vinkel").length,
    exp: {}, skoen: {} };   // CLAUDE-1162: exp = det, der går i taksationsarket (hovedarten); skoen = vises, men eksporteres ikke
  const st0 = regs[0]?.stand, props = standProps(st0?.key);
  if (plots.length) {
    out.spread = vinkelSpread(regs);
    const lc = litraCalc(plots, st0?.art);
    const manual = plots.filter(p => p.type === "proeveflade").map(p => num(p.data.hg)).filter(v => v !== null);
    const manualHg = manual.length ? manual.reduce((a, b) => a + b, 0) / manual.length : null;
    if (lc) {
      if (!lc.total.Hg && manualHg) { lc.total.Hg = manualHg; lc.byArt.forEach(a => { if (!a.Hg) a.Hg = manualHg; }); }
      const v = vinkelVolume({ G: lc.total.G, Hg: lc.total.Hg, Dg: lc.total.Dg, byArt: lc.byArt }, props, st0?.art);
      (v?.parts || []).forEach(p => { const a = lc.byArt.find(x => x.art === p.key); if (a) Object.assign(a, { V: p.V, F: p.F, hFrom: p.hFrom }); });
      Object.assign(out, { arts: lc.byArt, total: lc.total, curve: lc.curve, missing: lc.missing, Vtotal: v?.V ?? null });
      if (v) out.total.V = v.V;
      const main = lc.byArt[0];   // B2: hovedarten = største grundflade
      out.main = main.art;
      Object.assign(out, { N: main.N, G: main.G, Dg: main.Dg, Dgw: main.Dgw, Hg: main.Hg, V: main.V ?? null,
        Vinfo: main.V != null ? { V: main.V, F: main.F, H: main.Hg ?? lc.total.Hg ?? num(props?.middelhoejde_m), hFrom: main.hFrom, art: main.art } : null });
      if (main.skoen) out.skoen = { N: true, Dg: true, Hg: true, V: true };
      out.exp = { G: main.G, N: main.skoen ? null : main.N, Dg: main.skoen ? null : main.Dg, Hg: main.skoen ? null : main.Hg,
        // B10: vedmasse med planens Hg (eller et skønnet Hg) er ikke årets måling, så cellen står tom og SkovPlan regner selv.
        V: main.skoen || main.hFrom === "planen" ? null : main.V ?? null };
    } else if (manualHg !== null) { out.Hg = manualHg; out.exp.Hg = manualHg; }
    const bks = plots.map(p => num(p.data.bk)).filter(v => v !== null);
    if (bks.length) out.Bk = out.exp.Bk = bks.reduce((a, b) => a + b, 0) / bks.length;
  }
  if (tax) {
    const d = tax.data; let changed = false;
    for (const [k, f] of [["Hg", "hg"], ["Dg", "dg"], ["N", "n"], ["G", "g"], ["V", "v"], ["Bk", "bk"]]) if (num(d[f]) !== null) {
      out[k] = out.exp[k] = num(d[f]); delete out.skoen[k]; if (["Hg", "Dg", "G"].includes(k)) changed = true;
    }
    // B12: erstatter taksationen G, Hg eller Dg uden selv at angive V, regnes V igen af de tal, der vises.
    if (changed && num(d.v) === null) {
      const H = out.exp.Hg ?? null, G = out.exp.G ?? null, art = d.art || out.main || st0?.art || "";
      const F = H ? formFactor(art, out.exp.Dg ?? num(props?.middeldiameter_cm), H) : null;
      out.V = out.exp.V = G && H ? G * H * F : null;
      out.Vinfo = out.V ? { V: out.V, F, H, hFrom: "taksation", art } : null; delete out.skoen.V;
    }
    if (d.art) out.art = d.art;
  }
  return out;
}

/* ------------------------------------------------------------------ state + kort */
const state = { data: null, regs: [], allRegs: [], selected: null, me: null, standLayer: null, overlays: [], basemap: 0 };
const map = L.map("map", { zoomControl: false, attributionControl: true, maxZoom: 21 }).setView([56.0, 9.5], 7);
L.control.zoom({ position: "bottomright" }).addTo(map);
/* Ortofoto fra SkovPlan (MBTiles, gemt i telefonens IndexedDB) */
/* Fliserne tegnes på et lærred, så kanten af ortofotoet (sort i JPEG-fliser) males grå uden for fotoets udstrækning. */
const OrthoLayer = L.GridLayer.extend({
  createTile(c, done) {
    const cv = document.createElement("canvas"); cv.width = cv.height = 256;
    db.get("tiles", `${this.options.prefix || ""}${c.z}/${c.x}/${c.y}`).then(b => {
      if (!b) return done(null, cv);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(img.src);
        const g = cv.getContext("2d"); g.drawImage(img, 0, 0, 256, 256);
        const bb = this.options.bounds;
        if (bb) {
          const a = this._map.project(bb.getNorthWest(), c.z), z = this._map.project(bb.getSouthEast(), c.z);
          const x0 = a.x - c.x * 256, y0 = a.y - c.y * 256, x1 = z.x - c.x * 256, y1 = z.y - c.y * 256;
          g.fillStyle = "#dddddd";
          if (y0 > 0) g.fillRect(0, 0, 256, Math.ceil(y0));
          if (y1 < 256) g.fillRect(0, Math.floor(y1), 256, 256);
          if (x0 > 0) g.fillRect(0, 0, Math.ceil(x0), 256);
          if (x1 < 256) g.fillRect(Math.floor(x1), 0, 256, 256);
        }
        done(null, cv);
      };
      img.onerror = () => done(null, cv);
      img.src = URL.createObjectURL(b);
    }).catch(e => done(e, cv));
    return cv;
  },
});
const BASEMAPS = [
  { name: "Ortofoto (gemt)", layer: null, ortho: true },
  { name: "OpenStreetMap", layer: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20, maxNativeZoom: 19, attribution: "© OpenStreetMap" }) },
  { name: "Ingen baggrund", layer: null },
];
function makeOrtho() {
  const m = state.ortho; if (!m) return null;
  return new OrthoLayer({ prefix: m.prefix || "", minZoom: 0, maxZoom: 21, minNativeZoom: m.minzoom, maxNativeZoom: m.maxzoom, attribution: m.attribution || "Ortofoto",
    bounds: m.bounds ? L.latLngBounds([m.bounds[1], m.bounds[0]], [m.bounds[3], m.bounds[2]]) : undefined });
}
function setBasemap(i) {
  BASEMAPS.forEach(b => b.layer && map.removeLayer(b.layer));
  if (BASEMAPS[i].ortho && !state.ortho) i = 1;
  if (BASEMAPS[0].layer && BASEMAPS[0].layer._skovMeta !== state.ortho) BASEMAPS[0].layer = null;
  if (BASEMAPS[i].ortho && !BASEMAPS[0].layer) { BASEMAPS[0].layer = makeOrtho(); BASEMAPS[0].layer._skovMeta = state.ortho; }
  state.basemap = i; const b = BASEMAPS[i]; if (b.layer) b.layer.addTo(map).bringToBack();
  try { localStorage.setItem("basemap", i); } catch (e) { /* ok */ }
}
function safeLS(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }

/* SkovPlans litrafarver (træart -> fyldfarve), som de står i SkovPlan-projektet. */
const SPECIES_COLORS = {
  "Agerjord": "#e0eeec", "Almindelig ædelgran": "#6a3d9a", "Anden anvendelse": "#f4f3bf", "andet": "#f4f3bf",
  "Bjergfyr": "#e59a59", "Blandet løvskov": "#f6f57f", "Blandet løv": "#f6f57f", "Blandet nåleskov": "#bda662",
  "Blandet nål": "#bda662", "Bøg": "#c3f88d", "Contortafyr": "#f2c29b", "Douglasgran": "#e0b030", "Eg": "#f8a9a8",
  "Eng": "#daf3bf", "Lysåbent": "#d8c76a", "Lysåben": "#d8c76a", "Grandis": "#5e35b1", "Hus": "#9b6a58",
  "Ikke fastlagt": "#e1e1e1", "Ikke bestemt": "#e1e1e1", "Lærk": "#8bc34a", "Mose": "#6b9c86",
  "Naturlig succession": "#e99758", "Naturforyngelse": "#e99758", "Nobilis": "#b39ddb", "Ædelgran": "#8e6bbf",
  "Rødgran": "#7f8c8d", "Serbisk gran": "#2e5f8a", "Omorika": "#3b74a8", "Sitkagran": "#4a90a4", "Skovbryn": "#4272cc",
  "Skovfyr": "#c8742b", "Udyrket areal": "#d82e83", "Udyrket": "#d82e83", "Sø": "#6e99f1", "Søer": "#6e99f1",
  "Vand": "#6e99f1", "Vej": "#ffffff", "Blandet løv og nål": "#8fa8d9", "Rødel": "#2f8f6b", "Poppel": "#e8b4d4",
  "Birk": "#f4f0a0", "Vestamerikansk hemlock": "#00897b", "Hemlock": "#30d10c", "Ask": "#ddb4f5", "Ær": "#f7d26c",
  "Løn": "#f7d26c", "Ær, Løn": "#f7d26c", "Andet løvtræ": "#f6f57f", "Andet nåletræ": "#9e9d24", "Vandløb": "#4276b4",
  "Slette, Overdrev": "#daf3bf", "Ahorn": "#e69f76", "Avnbøg": "#d2ad48", "Bygning/bebygget areal": "#c78f5b",
  "Cypres": "#455a64", "Europæisk lærk": "#c5e1a5", "Fuglekirsebær": "#50c4ca", "Gran": "#9fb4c7",
  "Græsareal": "#77c574", "Hede": "#cd5aa5", "Hybridasp": "#5bdbe7", "Hybridlærk": "#aed581", "Japansk lærk": "#689f38",
  "Krat": "#7345d5", "Liggeplads": "#caa147", "Læhegn": "#cfc558", "Mark": "#8072cf", "Naturareal": "#4ad56f",
  "OP42": "#63c9c2", "Overdrev": "#4ecac2", "Park/have": "#576fc6", "Rødeg": "#c66679", "Stilkeg": "#70c6d1",
  "Tsuga": "#4db6ac", "Vildtager": "#e0665b", "Vortebirk": "#8de471", "Vådområde": "#c6455b", "Å": "#bca84d",
};
const NO_SPECIES_COLOR = "#afafa5";
const normName = s => String(s ?? "").split(/\s+/).filter(Boolean).join(" ").toLocaleLowerCase("da");
const COLOR_LOOKUP = Object.fromEntries(Object.entries(SPECIES_COLORS).map(([k, v]) => [normName(k), v]));
const autoColors = {};
/* Samme automatiske farve som SkovPlan giver arter uden fast farve (sha256 -> HSV). */
async function prepareAutoColors(names) {
  for (const name of names) {
    const key = normName(name);
    if (!key || COLOR_LOOKUP[key] || autoColors[key] || !crypto?.subtle) continue;
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
    autoColors[key] = hsvHex(((d[0] << 8) | d[1]) % 360, 105 + (d[2] % 75), 185 + (d[3] % 55));
  }
}
function hsvHex(h, s, v) {
  s /= 255; v /= 255; const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map(t => Math.round((t + m) * 255).toString(16).padStart(2, "0")).join("");
}
const colorFor = art => { const k = normName(art); return k ? (COLOR_LOOKUP[k] || autoColors[k] || NO_SPECIES_COLOR) : NO_SPECIES_COLOR; };

function drawData() {
  state.overlays.forEach(l => map.removeLayer(l)); state.overlays = [];
  (state.extraLabels || []).forEach(t => t.remove()); state.extraLabels = [];
  if (!state.data) { state.standLayer = null; return; }
  const L_ = state.data.layers;
  for (const name of ["kortlinjer", "adgangsveje", "ejendomsgraense", "indgange"]) {
    if (!L_[name]) continue; const st = LAYERS[name].style;
    const lyr = L.geoJSON(L_[name], { style: () => st, pointToLayer: (f, ll) => L.circleMarker(ll, st), interactive: false }).addTo(map);
    state.overlays.push(lyr);
  }
  const hidden = hiddenLayers(), extra = state.data.extra?.lag || {};
  const counts = countByStand();
  state.standLayer = L.geoJSON(L_.skovafdelinger, {
    style: f => standStyle(f, counts),
    onEachFeature: (f, lyr) => {
      lyr.on("click", () => selectStand(f));
      lyr.bindTooltip(labelHtml(f.properties, true, counts), { permanent: true, direction: "center", className: "litra-label" });
    },
  }).addTo(map);
  state.overlays.push(state.standLayer);
  // hensyn oven på litraerne: §3-naturtyper, diger, fortidsminder, aflægningspladser
  state.extraLabels = [];
  for (const [key, def] of Object.entries(EXTRA)) {
    if (!extra[key] || hidden.has(key)) continue;
    const lyr = L.geoJSON(extra[key], {
      style: () => def.style, interactive: !!def.info,
      pointToLayer: (f, ll) => L.circleMarker(ll, def.style),
      onEachFeature: (f, l) => {
        if (def.info) l.bindPopup(esc(def.info(f.properties)));
        if (def.label) state.extraLabels.push(L.tooltip({ permanent: true, direction: "center", className: "natur-label", interactive: false })
          .setLatLng(l.getBounds().getCenter()).setContent(esc(def.label(f.properties))));
      },
    }).addTo(map);
    state.overlays.push(lyr);
  }
  if (L_.aflaegningspladser && !hidden.has("aflaegningspladser")) {
    const st = LAYERS.aflaegningspladser.style;
    const lyr = L.geoJSON(L_.aflaegningspladser, { pointToLayer: (f, ll) => L.circleMarker(ll, st),
      onEachFeature: (f, l) => l.bindPopup(esc(["Aflægningsplads", f.properties.navn, f.properties.sortiment, f.properties["bemærkning"]].filter(Boolean).join(" · "))) }).addTo(map);
    state.overlays.push(lyr);
  }
  updateLabels();
  prepareAutoColors(new Set(L_.skovafdelinger.features.map(f => f.properties["træart"]))).then(restyle);
  $("#where").textContent = state.data.name || "";
}
function standStyle(f, counts) {
  const sel = state.selected && standKey(state.selected.properties) === standKey(f.properties);
  const has = counts[standKey(f.properties)];
  return { color: sel ? "#0b57d0" : has ? "#7a1fa2" : "#232323", weight: sel ? 4 : has ? 2.5 : 1,
    fillColor: colorFor(f.properties["træart"]), fillOpacity: state.basemap === 2 ? 0.85 : 0.66 };
}
function restyle() { if (!state.standLayer) return; const c = countByStand(); state.standLayer.eachLayer(l => l.setStyle(standStyle(l.feature, c))); }
/* Mærkaten som på SkovPlans kort (litra, art, år, §3), hvis feltpakken har den; ellers afd+litra.
   Langt ude vises kun litraet, tæt på hele mærkaten. */
function labelHtml(p, full, counts = countByStand()) {
  const m = state.data?.extra?.maerkater?.[p.compartment_id];
  const lines = m ? String(m).split(/\n/).filter(Boolean) : [standLabel(p)];
  const shown = full ? lines : lines.slice(0, 1);
  return shown.map(esc).join("<br>") + (counts[standKey(p)] ? " ●" : "");
}
function updateLabels() {
  if (!state.standLayer) return; const z = map.getZoom(), show = z >= 14, full = z >= 16;
  const counts = countByStand();
  state.standLayer.eachLayer(l => {
    const t = l.getTooltip(); if (!t) return;
    if (t._full !== full) { t.setContent(labelHtml(l.feature.properties, full, counts)); t._full = full; }
    show ? l.openTooltip() : l.closeTooltip();
  });
  (state.extraLabels || []).forEach(t => z >= 15 ? t.addTo(map) : t.remove());
  if (show) requestAnimationFrame(declutter);
}
/* Som i SkovPlan: mærkater må ikke overlappe; det største litra vinder, de mindre skjules. */
function declutter() {
  if (!state.standLayer) return;
  const area = l => { const b = l.getBounds(); return (b.getEast() - b.getWest()) * (b.getNorth() - b.getSouth()); };
  const items = [];
  state.standLayer.eachLayer(l => { const el = l.getTooltip()?.getElement(); if (el) { el.style.visibility = ""; items.push([area(l), el]); } });
  items.sort((a, b) => b[0] - a[0]);
  const placed = [];
  for (const [, el] of items) {
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    if (placed.some(q => r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top)) el.style.visibility = "hidden";
    else placed.push(r);
  }
}
map.on("moveend", () => state.standLayer && map.getZoom() >= 14 && requestAnimationFrame(declutter));
function hiddenLayers() { try { return new Set(JSON.parse(safeLS("hiddenLayers") || "[]")); } catch (e) { return new Set(); } }
function layerMenu() {
  const extra = state.data?.extra?.lag || {}, hidden = hiddenLayers();
  const items = Object.entries(EXTRA).filter(([k]) => extra[k]).map(([k, d]) => [k, d.name, extra[k].features.length]);
  if (state.data?.layers.aflaegningspladser) items.push(["aflaegningspladser", "Aflægningspladser", state.data.layers.aflaegningspladser.features.length]);
  openSheet(`<div class="head"><h3>Vis lag</h3><button class="close">Luk</button></div>
    ${items.length ? items.map(([k, n, c]) => `<label class="check"><input type="checkbox" data-layer="${k}" ${hidden.has(k) ? "" : "checked"}> ${esc(n)} <span class="muted">(${c})</span></label>`).join("")
      : `<p class="muted">Feltpakken har ingen naturtyper eller andre hensyn. Lav en ny feltpakke i SkovPlan, så kommer de med.</p>`}`);
  sheet.querySelectorAll("[data-layer]").forEach(cb => cb.onchange = () => {
    const h = hiddenLayers(); cb.checked ? h.delete(cb.dataset.layer) : h.add(cb.dataset.layer);
    safeLS("hiddenLayers", JSON.stringify([...h])); (state.extraLabels || []).forEach(t => t.remove()); drawData(); restyle();
  });
}
map.on("zoomend", updateLabels);
function countByStand() { const c = {}; state.regs.forEach(r => { if (r.stand) c[r.stand.key] = (c[r.stand.key] || 0) + 1; }); return c; }

/* ------------------------------------------------------------------ GPS */
let meMarker = null, meCircle = null, follow = false;
function startGps() {
  if (!("geolocation" in navigator)) return;
  navigator.geolocation.watchPosition(pos => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    state.me = { lat, lon, accuracy, t: pos.timestamp };
    if (!meMarker) {
      meMarker = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18] }), interactive: false }).addTo(map);
      meCircle = L.circle([lat, lon], { radius: accuracy, color: "#1a73e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
    } else { meMarker.setLatLng([lat, lon]); meCircle.setLatLng([lat, lon]).setRadius(accuracy); }
    const km = kmFromForest(lat, lon);
    if (follow && km <= 1) map.setView([lat, lon], Math.max(map.getZoom(), 16));
    const st = standAt(lon, lat);
    $("#where").textContent = km > 1 ? `${state.data?.name || ""} · du er ${fmt(km, km < 10 ? 1 : 0)} km væk`
      : (st ? `Du står i ${standLabel(st.properties)} · ` : "") + `±${Math.round(accuracy)} m`;
    trackPoint(lat, lon, accuracy, pos.timestamp); remindStand(lat, lon, accuracy); updateNav();
  }, err => toast("GPS er ikke tilgængelig" + (err.message ? ": " + err.message : "")), { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function standAt(lon, lat) {
  if (!state.data) return null;
  for (const f of state.data.layers.skovafdelinger.features) {
    const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    for (const p of polys) if (inRing(lon, lat, p[0]) && !p.slice(1).some(h => inRing(lon, lat, h))) return f;
  }
  return null;
}
/* Afstand (km) fra et punkt til skovens ramme; 0 inde i skoven. */
function kmFromForest(lat, lon) {
  if (!state.data) return 0;
  let b; try { b = L.geoJSON(state.data.layers.skovafdelinger).getBounds(); } catch (e) { return 0; }
  if (!b.isValid()) return 0;
  const near = L.latLng(Math.min(Math.max(lat, b.getSouth()), b.getNorth()), Math.min(Math.max(lon, b.getWest()), b.getEast()));
  return map.distance(L.latLng(lat, lon), near) / 1000;
}
$("#btnLocate").onclick = () => {
  if (!state.me) return toast("Venter på GPS …");
  const km = kmFromForest(state.me.lat, state.me.lon);
  if (km > 1) { follow = false; fitData(); return toast(`Du er ca. ${fmt(km, km < 10 ? 1 : 0)} km fra ${state.data?.name || "skoven"}, så kortet viser skoven.`, 5000); }
  follow = true; map.setView([state.me.lat, state.me.lon], Math.max(map.getZoom(), 16));
  const st = standAt(state.me.lon, state.me.lat); if (st) selectStand(st);
};
/* Knap: vis hele skoven */
L.Control.Fit = L.Control.extend({ options: { position: "bottomright" }, onAdd() {
  const b = L.DomUtil.create("button", "fit-btn"); b.type = "button"; b.title = "Vis hele skoven"; b.setAttribute("aria-label", "Vis hele skoven"); b.textContent = "⤢";
  L.DomEvent.on(b, "click", e => { L.DomEvent.stop(e); follow = false; fitData(); }); return b; } });
new L.Control.Fit().addTo(map);
map.on("dragstart", () => { follow = false; });

/* ------------------------------------------------------------------ bundark (UI) */
const sheet = $("#sheet");
function openSheet(html, full = false) { sheet.innerHTML = '<div class="grab"></div>' + html; sheet.classList.remove("hidden"); sheet.classList.toggle("full", full); sheet.scrollTop = 0; }
function closeSheet() { sheet.classList.add("hidden"); state.selected = null; restyle(); }
sheet.addEventListener("click", e => { if (e.target.closest(".close")) closeSheet(); });

function standProps(key) { return key && state.data ? state.data.layers.skovafdelinger.features.find(f => standKey(f.properties) === key)?.properties : null; }
function standInfo(p) { return { key: standKey(p), label: standLabel(p), afd: p.afdeling_nr, litra: p.litra, compartment_id: p.compartment_id, art: p["træart"], areal: p.areal_ha }; }
function standArea(key) {
  return state.data.layers.skovafdelinger.features.filter(f => standKey(f.properties) === key)
    .reduce((s, f) => s + (num(f.properties.areal_ha) || 0), 0);
}

function selectStand(f) {
  state.selected = f; restyle();
  const p = f.properties, key = standKey(p), regs = state.regs.filter(r => r.stand?.key === key);
  const s = standSummary(regs);
  const fact = (v, lbl, d = 1) => `<div><b>${v === null || v === undefined || v === "" ? "–" : typeof v === "number" ? fmt(v, d) : esc(v)}</b><span>${lbl}</span></div>`;
  openSheet(`
    <div class="head"><h3>${esc(standLabel(p))} · ${esc(p["træart"] || "")}</h3><button class="close">Luk</button></div>
    <div class="facts">
      ${fact(standArea(key), "areal ha", 2)}${fact(p.alder ?? (p.etableringsaar ? YEAR - p.etableringsaar : null), "alder", 0)}${fact(p.etableringsaar ? String(p.etableringsaar) : null, "anlagt")}
      ${fact(num(p.middelhoejde_m), "Hg m")}${fact(num(p.middeldiameter_cm), "Dg cm")}${fact(num(p.stamtal_ha), "stk/ha", 0)}
      ${fact(num(p.grundflade_m2_ha), "G m²/ha")}${fact(num(p.vedmasse_m3_ha), "m³/ha", 0)}${fact(p.taksationsaar || p.dataaar ? String(p.taksationsaar || p.dataaar) : null, "data fra")}
    </div>
    ${p.p3_status === "Ja" ? `<p class="p3">§3-beskyttet${p.p3_naturtyper ? ": " + esc(p.p3_naturtyper) : ""}</p>` : ""}
    ${p["bemærkning"] ? `<p class="muted">${esc(p["bemærkning"])}</p>` : ""}
    <div class="actions">
      <button class="primary" data-act="newPlot">+ Prøveflade</button>
      <button data-act="photo">📷 Foto</button>
      <button data-act="note">✎ Note</button>
    </div>
    <button class="big" data-act="vinkel">◔ Relaskopmåling</button>
    <button class="big" data-act="taksation">Taksér litraet direkte (Hg, Dg, stamtal …)</button>
    <button class="big" data-act="goStand">➜ Gå til ${esc(standLabel(p))}</button>
    ${s.spread && s.spread.n > 1 ? `<p class="muted small">Relaskop: ${s.spread.n} punkter, G ${fmt(s.spread.mean, 1)} m²/ha${s.spread.se !== null ? ` ± ${fmt(s.spread.se, 0)} % (middelfejl)` : ""}${s.spread.se > 10 ? ". Tag flere punkter for et sikrere tal." : ""}</p>` : ""}
    ${s.plots || s.points || s.Hg != null || s.Dg != null ? `<div class="result">${standResultHtml(s, p)}</div>` : ""}
    <ul class="list">${regs.filter(r => !r.data.parent).map(regItem).join("")}</ul>`);
  hydrateThumbs();
}

/* CLAUDE-1162: litraets feltdata. Første linje er hovedartens tal (dem, der går i taksationsarket); «skøn» eksporteres ikke. */
function standResultHtml(s, p) {
  const sk = k => s.skoen?.[k] ? " <i>(skøn)</i>" : "";
  const head = [s.plots ? `${s.plots} prøveflade${s.plots === 1 ? "" : "r"}` : "", s.points ? `${s.points} relaskoppunkt${s.points === 1 ? "" : "er"}` : ""].filter(Boolean).join(" · ");
  const main = [s.Hg != null ? `Hg ${fmt(s.Hg)} m${sk("Hg")}` : "", s.Dg != null ? `Dg ${fmt(s.Dg)} cm${sk("Dg")}` : "", s.N ? `${fmt(s.N, 0)} stk/ha${sk("N")}` : "",
    s.G ? `G ${fmt(s.G)} m²/ha` : "", s.V ? `${fmt(s.V, 0)} m³/ha${s.Vinfo?.hFrom === "planen" ? " (Hg fra planen, eksporteres ikke)" : sk("V")}` : "",
    s.Bk != null ? `Bk ${fmt(s.Bk, 0)} %` : ""].filter(Boolean).join(" · ");
  const lines = [`<b>Feltdata ${YEAR}:</b> ${head}`, (s.arts?.length > 1 ? `<b>Hovedart ${esc(s.main)}</b> (går i taksationsarket): ` : "") + main];
  if (s.arts?.length > 1) {
    lines.push(`Alle arter: G ${fmt(s.total.G)} m²/ha${s.total.N ? ` · ${fmt(s.total.N, 0)} stk/ha · Dg ${fmt(s.total.Dg)} cm` : ""}${s.total.Hg ? ` · Hg ${fmt(s.total.Hg)} m` : ""}${s.total.V ? ` · ${fmt(s.total.V, 0)} m³/ha` : ""}`);
    lines.push(s.arts.map(a => `${esc(a.art)}: G ${fmt(a.G)}${a.N ? `, ${fmt(a.N, 0)} stk/ha, Dg ${fmt(a.Dg)}` : ", ingen målte træer"}${a.skoen ? " (skøn)" : ""}`).join(" · "));
  }
  if (p?.["træart"] && s.main && s.main !== p["træart"] && !s.art)
    lines.push(`<span class="warn">Hovedarten efter grundflade er ${esc(s.main)}, men planen siger ${esc(p["træart"])}. Ret træarten med en taksation, hvis planen er forkert.</span>`);
  if (Object.keys(s.skoen || {}).length) lines.push(`<span class="muted small">Skøn: relaskoppets stamtal, Dg og Hg bygger på under ${MIN_SAMPLED} målte træer af arten og kommer ikke med i taksationsarket. Mål 1–2 træer på hvert punkt, så litraet får mindst 10.</span>`);
  if (s.missing?.length) lines.push(`<span class="muted small">Ingen målte træer af ${s.missing.map(esc).join(", ")}: kun grundflade, ikke stamtal og Dg.</span>`);
  if (s.curve) lines.push(`<span class="muted small">Hg = Loreys middelhøjde over alle træer; højder, der ikke er målt, er aflæst på en højdekurve (Näslund) fra ${s.curve.n} målte højder.</span>`);
  if (s.V) {
    lines.push(`<span class="muted small">${VOL_DEF}.</span>`);
    const dff = dffStand(s.main, s.N, s.Dg, s.Hg);
    if (dff) lines.push(`<span class="muted small">Til sammenligning (Madsen 1987, DFF 350, med grene): ${dff.total ? `totalvolumen ${fmt(dff.total, 0)} m³/ha` : ""}${dff.total && dff.derb ? ", " : ""}${dff.derb ? `til 7 cm top ${fmt(dff.derb, 0)} m³/ha` : ""}.</span>`);
  }
  return lines.join("<br>");
}
function regItem(r) {
  const when = new Date(r.created).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let txt = "";
  if (r.type === "proeveflade") { const s = plotStats(r.data); txt = `Prøveflade r=${fmt(r.data.radius, 2)} m · ${s.n} træer · Dg ${fmt(s.Dg)} · ${fmt(s.N, 0)} stk/ha`; }
  else if (r.type === "foto") txt = "Foto" + (r.data.note ? ": " + esc(r.data.note) : "");
  else if (r.type === "note") { const n = childPhotos(r).length; txt = (r.data.general ? "<b>Generel note</b>" + (r.data.note ? ": " : "") : "") + esc(r.data.note) + (n ? ` · 📷 ${n}` : ""); }
  else if (r.type === "taksation") txt = `Taksation: Hg ${fmt(num(r.data.hg))} · Dg ${fmt(num(r.data.dg))} · ${fmt(num(r.data.n), 0)} stk/ha`;
  else if (r.type === "vinkel") { const s = vinkelStats(r.data); txt = `Relaskop ${fmt(s.baf, 0)} · ${fmtCnt(s.cnt)} træer · G ${fmt(s.G, 1)} m²/ha` + (s.N ? ` · ${fmt(s.N, 0)} stk/ha` : ""); }
  else if (r.type === "stak" || r.type === "stok") txt = pileText(r) + (r.data.note ? ": " + esc(r.data.note) : "");
  else if (r.type === "spor") txt = `Rute ${fmtLen(r.data.length_m)} · ${Math.round(r.data.minutes || 0)} min` + (r.data.note ? ": " + esc(r.data.note) : "");
  const thumb = r.type === "foto" ? r.id : r.type === "note" ? childPhotos(r)[0]?.id : null;
  return `<li data-id="${r.id}">${thumb ? `<img data-thumb="${thumb}" alt="">` : ""}
    <div class="grow">${txt}<br><span class="muted">${when}${r.stand ? " · " + esc(r.stand.label) : ""}${r.exported ? " · eksporteret" : ""}</span></div>
    <button data-act="edit" data-id="${r.id}">Ret</button></li>`;
}
function hydrateThumbs() {
  sheet.querySelectorAll("img[data-thumb]").forEach(img => {
    const r = state.regs.find(x => x.id === img.dataset.thumb);
    if (r?.photo) img.src = URL.createObjectURL(r.photo);
  });
}

const NOT_TREE = /^(sø|søer|å|vand|vandløb|vej|eng|mose|hede|hus|mark|agerjord|krat|overdrev|slette|græs|park|vildtager|liggeplads|lysåben|udyrket|anden anvendelse|andet$|ikke |bygning|naturareal|vådområde|skovbryn|naturlig succession|naturforyngelse)/i;
function speciesOptions(extra) {
  const set = new Set(["Rødgran", "Sitkagran", "Douglasgran", "Ædelgran", "Nobilis", "Grandis", "Skovfyr", "Lærk", "Bøg", "Eg", "Ask", "Ahorn", "Birk", "Rødel", "Andet nåletræ", "Andet løvtræ"]);
  const notTree = NOT_TREE;
  (state.data?.layers.skovafdelinger.features || []).forEach(f => { const a = f.properties["træart"]; if (a && !notTree.test(a)) set.add(a); });
  if (extra) set.add(extra);
  return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b, "da"));
}
function perSpecies(p) {
  const by = {};
  for (const t of p.trees) { if (!num(t.d)) continue; (by[t.art || "?"] = by[t.art || "?"] || []).push(t); }
  return Object.entries(by).map(([art, trees]) => ({ art, ...plotStats({ ...p, hg: null, trees }) })).sort((a, b) => b.G - a.G);
}

/* -------- prøveflade-formular: én række pr. træ, som et taksationsark */
function plotForm(reg) {
  const d = reg.data, defArt = reg.stand?.art || "";
  const arts = speciesOptions(defArt);
  const blank = art => ({ art, d1: "", d2: "", h: "", note: "" });
  const trees = d.trees.map(t => ({ art: t.art || defArt, d1: t.d1 ?? t.d ?? "", d2: t.d2 ?? "", h: t.h ?? "", note: t.note || "" }));
  if (!trees.length) trees.push(blank(defArt));
  /* Krydsklupning: gennemsnittet af de to målinger; kun én måling = den ene. */
  const meanD = t => { const a = num(t.d1), b = num(t.d2); return a && b ? (a + b) / 2 : a || b || null; };
  openSheet(`
    <div class="head"><h3>Prøveflade · ${esc(reg.stand?.label || "uden litra")}</h3><button data-act="cancelForm" class="close">Annullér</button></div>
    <div class="row">
      <div><label>Radius (m, vandret)</label><select id="pRadius">${RADII.map(r => `<option value="${r}" ${r === d.radius ? "selected" : ""}>${fmt(r, 2)} m (${Math.round(Math.PI * r * r)} m²)</option>`).join("")}</select></div>
      <div><label>Position</label><button id="pPos" style="width:100%">${reg.lat ? `±${Math.round(reg.accuracy || 0)} m ✓` : "Brug GPS"}</button></div>
    </div>
    <p class="muted small">Diameteren måles i 1,3 m højde. Radius måles vandret (på skrånende terræn: vandret afstand, ikke langs jorden).
      Et kanttræ tæller med, når stammens midte i 1,3 m ligger inden for radius. Træer under klupningsgrænsen klupes ikke.</p>
    <div class="row"><div><label>Klupningsgrænse (cm)</label><input id="pMinD" inputmode="decimal" value="${esc(d.minD ?? "")}" placeholder="fx 8"></div><div></div></div>
    <label>Enkelttræer – krydsklup i 1,3 m: D1, Enter, D2, Enter … (D = gennemsnit)</label>
    <div class="tablewrap"><table class="trees">
      <thead><tr><th>Nr</th><th>Træart</th><th>D1 (cm)</th><th>D2 (cm)</th><th>D</th><th>H (m)</th><th>Bemærkning</th><th></th></tr></thead>
      <tbody id="pRows"></tbody>
    </table></div>
    <button id="pAdd" style="width:100%;margin-top:6px">+ Træ</button>
    <div class="result" id="pRes"></div>
    <div class="row">
      <div><label>Hg (m) – hvis ikke målt på træer</label><input id="pHg" inputmode="decimal" value="${esc(d.hg ?? "")}"></div>
      <div><label>Bk (%)</label><input id="pBk" inputmode="numeric" value="${esc(d.bk ?? "")}"></div>
    </div>
    <label>Note til prøvefladen</label><textarea id="pNote">${esc(d.note || "")}</textarea>
    <div class="stack">
      <button class="primary big" id="pSave">Gem prøveflade</button>
      ${reg._new ? "" : '<button class="danger" id="pDel">Slet prøveflade</button>'}
      ${!reg._new && reg.lat ? '<button id="goReg">➜ Gå hertil</button>' : ""}
    </div>`, true);
  const body = $("#pRows");
  const opts = sel => arts.map(a => `<option ${a === sel ? "selected" : ""}>${esc(a)}</option>`).join("");
  const rowHtml = (t, i) => `<tr data-i="${i}">
      <td class="nr">${i + 1}</td>
      <td><select data-k="art">${opts(t.art)}</select></td>
      <td><input data-k="d1" inputmode="decimal" value="${esc(t.d1)}" enterkeyhint="next"></td>
      <td><input data-k="d2" inputmode="decimal" value="${esc(t.d2)}" enterkeyhint="next"></td>
      <td class="dm">${meanD(t) ? fmt(meanD(t), 1) : ""}</td>
      <td><input data-k="h" inputmode="decimal" value="${esc(t.h)}" enterkeyhint="next"></td>
      <td><input data-k="note" value="${esc(t.note)}" placeholder=""></td>
      <td><button class="del" data-del="${i}" aria-label="Fjern træ">✕</button></td></tr>`;
  const drawRows = () => { body.innerHTML = trees.map(rowHtml).join(""); };
  const summary = () => {
    const p = { radius: +$("#pRadius").value, trees: trees.filter(meanD).map(t => ({ ...t, d: meanD(t), h: num(t.h) })), hg: $("#pHg").value };
    const s = plotStats(p), arts = perSpecies(p);
    $("#pRes").innerHTML = `<b>${s.n} træer</b> · ${fmt(s.N, 0)} stk/ha · G ${fmt(s.G)} m²/ha · Dg ${fmt(s.Dg)} cm (grundfladevægtet ${fmt(s.Dgw)}) · Hg ${fmt(s.Hg)} m${s.heights ? ` (${s.heights} højder)` : ""}`
      + (arts.length > 1 ? "<br>" + arts.map(a => `${esc(a.art)}: ${a.n} stk, G ${fmt(a.G)}, Dg ${fmt(a.Dg)}`).join(" · ") : "")
      // CLAUDE-1162 (B11): fladens Hg er de målte træers; litraets Hg regnes med højdekurve over alle træer.
      + (s.heights >= 1 ? `<br><span class="muted small">Litraets Hg regnes med en højdekurve (Näslund), når litraet har mindst 3 målte højder.</span>` : "");
  };
  const addRow = () => {
    const last = trees[trees.length - 1];
    trees.push(blank(last ? last.art : defArt));
    drawRows(); summary();
    body.querySelector(`tr[data-i="${trees.length - 1}"] input[data-k="d1"]`).focus();
  };
  body.addEventListener("input", e => {
    const tr = e.target.closest("tr"), k = e.target.dataset.k; if (!tr || !k) return;
    trees[+tr.dataset.i][k] = e.target.value; summary();
    if (k === "d1" || k === "d2") { const m = meanD(trees[+tr.dataset.i]); tr.querySelector(".dm").textContent = m ? fmt(m, 1) : ""; }
  });
  body.addEventListener("change", e => {
    const tr = e.target.closest("tr"), k = e.target.dataset.k; if (!tr || !k) return;
    trees[+tr.dataset.i][k] = e.target.value; summary();
  });
  body.addEventListener("keydown", e => {
    if (e.key !== "Enter") return; e.preventDefault();
    const tr = e.target.closest("tr"), i = +tr.dataset.i, k = e.target.dataset.k;
    if (k === "d1") { if (String(trees[i].d1).trim()) tr.querySelector('input[data-k="d2"]').focus(); return; }
    if (!meanD(trees[i])) return;
    const next = body.querySelector(`tr[data-i="${i + 1}"] input[data-k="d1"]`);
    next ? next.focus() : addRow();
  });
  body.addEventListener("click", e => {
    const b = e.target.closest("[data-del]"); if (!b) return;
    trees.splice(+b.dataset.del, 1); if (!trees.length) trees.push(blank(defArt));
    drawRows(); summary();
  });
  $("#pAdd").onclick = addRow;
  $("#pRadius").onchange = summary; $("#pHg").oninput = summary;
  $("#pPos").onclick = () => { if (!state.me) return toast("Venter på GPS …"); Object.assign(reg, pos()); $("#pPos").textContent = `±${Math.round(reg.accuracy)} m ✓`; };
  $("#pSave").onclick = async () => {
    const badNum = v => String(v).trim() && (!num(v) || num(v) <= 0 || num(v) > 200);
    const bad = trees.find(t => badNum(t.d1) || badNum(t.d2));
    if (bad) return toast(`Træ ${trees.indexOf(bad) + 1}: diameteren skal være et tal i cm`);
    const badH = v => String(v ?? "").trim() && (!num(v) || num(v) < 1.3 || num(v) > 60);
    const badTree = trees.find(t => badH(t.h));
    if (badTree) return toast(`Træ ${trees.indexOf(badTree) + 1}: højden skal være mellem 1,3 og 60 m`);
    const minD = num($("#pMinD").value), small = minD ? trees.find(t => meanD(t) && meanD(t) < minD) : null;   // CLAUDE-1162
    if (small) return toast(`Træ ${trees.indexOf(small) + 1} er under klupningsgrænsen på ${fmt(minD, 0)} cm. Fjern det, eller ret grænsen.`, 4000);
    const kept = trees.filter(meanD).map(t => ({ art: t.art, d1: num(t.d1), d2: num(t.d2), d: +meanD(t).toFixed(2), h: num(t.h), note: String(t.note || "").trim() }));
    reg.data = { radius: +$("#pRadius").value, trees: kept, hg: num($("#pHg").value), bk: num($("#pBk").value), minD, note: $("#pNote").value.trim() };
    if (!kept.length && reg.data.hg === null) return toast("Prøvefladen er tom");
    await saveReg(reg); toast("Prøveflade gemt"); backToStand(reg);
  };
  if ($("#pDel")) $("#pDel").onclick = () => deleteReg(reg);
  if ($("#goReg")) $("#goReg").onclick = () => { closeSheet(); goTo(reg.lat, reg.lon, "Prøveflade " + (reg.stand?.label || "")); };
  drawRows(); summary();
  if (reg._new) body.querySelector('input[data-k="d1"]').focus();
}

/* ------------------------------------------------------------------ vinkeltælling (relaskop, Bitterlich)
   Hvert træ «ind» = BAF m²/ha; et grænsetræ tæller halvt. G = BAF × (ind + ½ × grænse).
   Med diameter (og højde) på nogle af de talte træer: hvert prøvetræ står for (talte/målte) træer af SAMME ART (CLAUDE-1162), og hvert talt træ
   repræsenterer BAF / g træer pr. ha. Derfor N = G × gennemsnit(1/g), Dg (kvadratisk middeldiameter) = √(G / (N·π/4)), Dgw (Σd³/Σd²) = gennemsnittet af de målte diametre
   og Hg (grundfladevægtet) = gennemsnittet af de målte højder.
   Kilder: «To select an appropriate BAF, estimate G and divide by 10» og «a count of 7-12 trees per sample point» (ANU Fenner
   School, Forest mensuration: Angle count sampling); «Do not change prism BAF from plot to plot within a stand» (Marty,
   Point Sampling, Michigan State University Extension E-1757). */
const BAFS = [1, 2, 4];
const fmtCnt = n => fmt(n, n % 1 ? 1 : 0);
const BAF_SOURCES = [["ANU Fenner School: Angle count sampling", "https://fennerschool-associated.anu.edu.au/mensuration/acs.htm"],
  ["Marty: Point Sampling, MSU Extension E-1757", "https://msaf.forest.mtu.edu/ForestInfo/MSUElibrary/E1757_PointSampling.PDF"]];
const BAF_LIT = "Bitterlich, W. (1984): The Relascope Idea. Commonwealth Agricultural Bureaux.";   // CLAUDE-1162: original kilde
const bafFor = G => BAFS.reduce((best, b) => Math.abs(Math.log(G / b / 10)) < Math.abs(Math.log(G / best / 10)) ? b : best, 2);
const reachM = (dcm, baf) => dcm / 100 / (2 * Math.sqrt(baf / 10000));   // grænseafstand: et træ med diameter d tæller ud til d/(2·√(BAF/10000))
function vinkelStats(d) {
  // CLAUDE-1162 (K3): vægten regnes pr. art, w_art = talte_art / målte_art, så et målt bøgetræ ikke giver rødgranens stamtal.
  // Arter uden målte træer får G, men ikke N, Dg og Hg; punktets samlede N og Dg kræver målte træer af alle talte arter.
  const baf = num(d.baf) || 2, rows = d.counts || [], by = {};
  for (const r of rows) { const n = (num(r.ind) || 0) + 0.5 * (num(r.gr) || 0); if (!n) continue; const a = r.art || "Blandet"; (by[a] = by[a] || { art: a, n: 0 }).n += n; }
  const arts = Object.keys(by), match = artMatcher(arts), samp = (d.trees || []).filter(t => num(t.d) > 0);
  const cnt = arts.reduce((s, a) => s + by[a].n, 0), G = baf * cnt;
  const out = { baf, cnt, n: cnt, G, byArt: [], sampled: samp.length, N: null, Dg: null, Dgw: null, Hg: null, heights: 0, complete: arts.length > 0 };
  let sN = 0, s2 = 0, s3 = 0, gh = 0, gH = 0;
  for (const a of arts) {
    const mine = samp.filter(t => match(t.art) === a), row = { art: a, n: by[a].n, G: baf * by[a].n, sampled: mine.length, N: null, Dg: null, Dgw: null, Hg: null, heights: 0 };
    if (mine.length) {
      const w = by[a].n / mine.length; let n = 0, q2 = 0, q3 = 0, qh = 0, qH = 0;
      for (const t of mine) {
        const dd = num(t.d), g = Math.PI / 4 * (dd / 100) ** 2, Ni = w * baf / g, h = num(t.h);
        n += Ni; q2 += Ni * dd * dd; q3 += Ni * dd ** 3; if (h) { qh += Ni * g * h; qH += Ni * g; row.heights++; }
      }
      Object.assign(row, { N: n, Dg: Math.sqrt(q2 / n), Dgw: q3 / q2, Hg: qH ? qh / qH : null });
      sN += n; s2 += q2; s3 += q3; gh += qh; gH += qH; out.heights += row.heights;
    } else out.complete = false;
    out.byArt.push(row);
  }
  out.byArt.sort((x, y) => y.G - x.G);
  if (sN) { out.Dgw = s3 / s2; out.Hg = gH ? gh / gH : null; if (out.complete) { out.N = sN; out.Dg = Math.sqrt(s2 / sN); } }
  return out;
}
/* Spredning mellem punkterne i et litra: gennemsnit, standardafvigelse og middelfejl i %. */
function vinkelSpread(regs) {
  const gs = regs.filter(r => r.type === "vinkel").map(r => vinkelStats(r.data).G);
  if (!gs.length) return null;
  const m = gs.reduce((a, b) => a + b, 0) / gs.length;
  const sd = gs.length > 1 ? Math.sqrt(gs.reduce((a, g) => a + (g - m) ** 2, 0) / (gs.length - 1)) : null;
  return { n: gs.length, mean: m, sd, se: sd !== null && m ? sd / Math.sqrt(gs.length) / m * 100 : null };
}
/* Hvilken BAF og hvorfor: låst af litraets andre punkter > foreslået fra litraets G > spørg om skovtypen. */
function bafAdvice(reg) {
  // CLAUDE-1162: faktoren låses kun til punkter fra samme år; en ny taksation et andet år må vælge en anden faktor.
  const yr = r => String(r.created || "").slice(0, 4), year = yr(reg) || String(YEAR);
  const others = reg.stand ? state.regs.filter(r => r.type === "vinkel" && r.id !== reg.id && r.stand?.key === reg.stand.key && yr(r) === year) : [];
  if (others.length) { const b = num(others[0].data.baf) || 2;
    return { baf: b, locked: true, why: `Samme faktor som litraets ${others.length === 1 ? "første punkt" : others.length + " andre punkter"} fra ${year}, så punkterne kan lægges sammen.` }; }
  const f = reg.stand && state.data?.layers.skovafdelinger.features.find(x => standKey(x.properties) === reg.stand.key);
  const G = num(f?.properties.grundflade_m2_ha);
  if (G) { const b = bafFor(G); return { baf: b, why: `Litraet har G ≈ ${fmt(G, 0)} m²/ha i planen, så du tæller ca. ${Math.round(G / b)} træer pr. punkt med faktor ${b}.` }; }
  return { baf: null, why: "" };
}
/* ------------------------------------------------------------------ vedmasse: SkovPlans stammekurve (stem_taper.py, CLAUDE-708)
   Merriman, Brownell, Meilby, Riis-Nielsen, Mason & Nord-Larsen: Multi-species stem taper and volume model, 41 species groups
   (SSRN 7242941), Kozak (2004) model 02. Formtal F = v / (π/4·D²·H); vedmasse = G × Hg × F, som i SkovPlan. */
const TAPER_FIX = { a0: 1.1018, a1: 1.0210, a2: 0.0462, b1: 0.3306, b2: -0.5190, b3: 0.5479, b4: 0.1430, b5: 0.2113, b6: -0.6422 };
const TAPER_SP = {
  "Abies alba": [-0.1835, 0.0201, -0.1154, -0.0103, -0.1990, 0.0173], "Abies balsamea": [-0.0473, 0.0001, -0.0724, -0.0461, 0.1973, 0.0228],
  "Abies grandis": [-0.0875, 0.0499, 0.0124, 0.0058, -0.1683, 0.0052], "Abies nordmanniana": [-0.2087, 0.0294, -0.1950, 0.0330, -0.3148, 0.0177],
  "Abies procera": [-0.0175, -0.1534, 0.0840, -0.1949, 0.5085, 0.3578], "Acer pseudoplatanus": [-0.0378, 0.0879, -0.0088, 0.0664, -0.1789, 0.0022],
  "Alnus glutinosa": [0.4904, -0.0290, 0.0393, 0.0074, 0.3243, 0.0010], "Alnus incana": [0.0352, 0.0329, 0.0633, 0.0032, -0.2911, 0.0010],
  "Betula pendula/pubescens": [0.3984, 0.0513, 0.0951, 0.0721, 0.2693, 0.0010], "Carpinus betulus": [0.1144, 0.0853, -0.1737, 0.2646, -0.7634, 0.0048],
  "Chamaecyparis lawsoniana": [-0.1258, 0.2076, -0.4473, 0.3307, -0.1148, 0.0044], "Fagus orientalis": [-0.1251, 0.2857, -0.0253, 0.3226, -0.7459, 0.0010],
  "Fagus sylvatica": [-0.1241, 0.2002, -0.0149, 0.1793, -0.4132, 0.0014], "Fraxinus excelsior": [-0.1554, 0.1277, -0.0571, 0.1274, -0.4464, 0.0036],
  "Larix decidua": [0.0532, -0.0052, -0.0492, -0.0204, 0.0409, 0.0066], "Larix gmelinii": [-0.0429, -0.0233, -0.0941, 0.0034, -0.1478, 0.0212],
  "Larix kaempferi": [-0.1328, -0.0176, -0.0777, -0.0214, -0.2638, 0.0279], "Larix x marschlinsii": [-0.2756, -0.0874, 0.1986, -0.1932, 0.5034, 0.3730],
  "Picea abies": [-0.0270, 0.0050, -0.1295, 0.0269, -0.0380, 0.0138],   // CLAUDE-1162: Picea glauca fjernet (d(1,3) = 1,7·D, F > 0,9)
  "Picea omorika": [0.3786, -0.1168, -0.0356, -0.0328, 0.1298, 0.0089], "Picea sitchensis": [-0.1220, 0.0586, -0.0599, 0.0527, -0.2715, 0.0080],
  "Pinus contorta": [0.1497, 0.0377, -0.0870, 0.0263, 0.1485, 0.0010], "Pinus mugo": [0.5025, -0.0195, -0.1727, -0.0009, 0.7157, 0.0010],
  "Pinus nigra": [-0.4285, -0.0916, -0.0575, -0.1946, 0.5929, 0.6197], "Pinus sylvestris": [0.1781, 0.0174, -0.0173, -0.0522, 0.5541, 0.0013],
  "Populus balsamifera": [-0.0017, 0.0746, 0.1735, -0.0350, 0.2149, 0.0011], "Populus deltoides": [-0.2290, 0.0401, 0.1075, -0.0223, -0.4181, 0.0122],
  "Populus tremula": [-0.0589, 0.0432, 0.0273, 0.0618, -0.4570, 0.0057], "Populus trichocarpa": [-0.1980, -0.0496, 0.1956, -0.1497, 0.2150, 0.1104],
  "Populus x berolinensis": [-0.1287, 0.0927, 0.0488, 0.0876, -0.5520, 0.0036], "Populus x canadensis": [0.7631, -0.4692, 0.2665, -0.1731, 0.5226, 0.6267],
  "Populus x canescens": [0.1698, -0.2303, 0.2723, -0.1654, 0.3813, 0.2953], "Populus x wettsteinii": [-0.0147, 0.0572, 0.1349, -0.0068, -0.2762, 0.0010],
  "Prunus avium": [-0.1051, -0.1043, 0.0807, -0.1531, 0.4845, 0.2238], "Pseudotsuga menziesii": [0.0297, 0.0061, 0.0124, -0.0163, -0.0421, 0.0058],
  "Quercus robur/petraea": [-0.0659, 0.1638, -0.0805, 0.1644, -0.2812, 0.0013], "Quercus rubra": [-0.1542, 0.0295, -0.0847, 0.0455, -0.3394, 0.0153],
  "Thuja plicata": [0.2101, -0.1260, -0.0925, -0.0058, -0.0005, 0.0403], "Tilia cordata": [0.1146, -0.1242, 0.1944, -0.1889, 0.4066, 0.1391],
  "Tsuga heterophylla": [-0.2337, -0.0399, 0.0555, -0.1074, 0.0620, 0.1870],
};
const TAPER_DK = {
  "rødgran": "Picea abies", "rgr": "Picea abies", "gran": "Picea abies", "sitkagran": "Picea sitchensis", "sgr": "Picea sitchensis",
  "omorika": "Picea omorika", "serbisk gran": "Picea omorika", "hvidgran": "Picea abies", "picea glauca": "Picea abies",
  "douglasgran": "Pseudotsuga menziesii", "douglas": "Pseudotsuga menziesii", "dgr": "Pseudotsuga menziesii",
  "ædelgran": "Abies alba", "almindelig ædelgran": "Abies alba", "ægr": "Abies alba", "grandis": "Abies grandis", "kæmpegran": "Abies grandis",
  "nordmannsgran": "Abies nordmanniana", "nordmann": "Abies nordmanniana", "nobilis": "Abies procera", "nobilisgran": "Abies procera",
  "edelgran": "Abies alba", "balsamgran": "Abies balsamea", "japansk lærk": "Larix kaempferi", "lærk": "Larix kaempferi",
  "europæisk lærk": "Larix decidua", "hybridlærk": "Larix x marschlinsii", "dahurisk lærk": "Larix gmelinii",
  "skovfyr": "Pinus sylvestris", "contortafyr": "Pinus contorta", "bjergfyr": "Pinus mugo", "østrigsk fyr": "Pinus nigra", "sortfyr": "Pinus nigra",
  "thuja": "Thuja plicata", "kæmpethuja": "Thuja plicata", "tsuga": "Tsuga heterophylla", "vestamerikansk hemlock": "Tsuga heterophylla", "hemlock": "Tsuga heterophylla",
  "cypres": "Chamaecyparis lawsoniana", "ædelcypres": "Chamaecyparis lawsoniana", "bøg": "Fagus sylvatica", "orientalsk bøg": "Fagus orientalis",
  "eg": "Quercus robur/petraea", "stilkeg": "Quercus robur/petraea", "vintereg": "Quercus robur/petraea", "rødeg": "Quercus rubra",
  "ask": "Fraxinus excelsior", "ahorn": "Acer pseudoplatanus", "ær": "Acer pseudoplatanus", "løn": "Acer pseudoplatanus",
  "birk": "Betula pendula/pubescens", "vortebirk": "Betula pendula/pubescens", "dunbirk": "Betula pendula/pubescens",
  "rødel": "Alnus glutinosa", "gråel": "Alnus incana", "avnbøg": "Carpinus betulus", "lind": "Tilia cordata",
  "fuglekirsebær": "Prunus avium", "kirsebær": "Prunus avium", "asp": "Populus tremula", "bævreasp": "Populus tremula",
  "hybridasp": "Populus x wettsteinii", "poppel": "Populus x canadensis", "op42": "Populus trichocarpa", "balsampoppel": "Populus balsamifera",
};
/* CLAUDE-1162 (B3): arter uden egen gruppe («Andet nåletræ», «Andet løvtræ», «Blandet», ukendte navne) bruger rødgran
   (nåletræ) eller bøg (løvtræ) i stedet for populationsgennemsnittet, der gav formtal 15–25 % under begge. */
const CONIFER_WORDS = ["nål", "gran", "fyr", "lærk", "cypres", "thuja", "hemlock", "tsuga", "douglas", "nobilis", "taks", "ceder"];
function taperGroup(art) {
  const k = String(art || "").normalize("NFC").toLowerCase().replace(/×/g, "x").split(/\s+/).filter(Boolean).join(" ");
  return Object.keys(TAPER_SP).find(n => n.toLowerCase() === k) || TAPER_DK[k]
    || (CONIFER_WORDS.some(w => k.includes(w)) ? "Picea abies" : "Fagus sylvatica");
}
function taperParams(art) {
  const f = TAPER_FIX, u = TAPER_SP[taperGroup(art)];
  return [f.a0 + u[0], f.a1 + u[1], f.b3 + u[2], f.b5 + u[3], f.b6 + u[4], u[5]];
}
function taperRaw(P, D, H, h) {
  if (D <= 0 || H <= 1.3 || h < 0 || h >= H) return 0;
  const [a0, a1, b3, b5, b6, p] = P, f = TAPER_FIX, z = h / H, q = 1 - Math.cbrt(z), x = q / (1 - Math.cbrt(p));
  if (x <= 0) return 0;
  const c = f.b1 * z ** 4 + f.b2 / Math.exp(D / H) + b3 * x ** 0.1 + f.b4 / D + b5 * H ** q + b6 * x, d = a0 * D ** a1 * H ** f.a2 * x ** c;
  return Number.isFinite(d) && d > 0 ? d : 0;
}
/* CLAUDE-1162 (B3): kontrol af, at kurven går gennem D i 1,3 m. Ligger d(1,3)/D uden for 0,95–1,05, skaleres hele
   profilen, så forholdet lander på grænsen (kontinuert; inden for ±5 % røres modellen ikke). Samme regel i stem_taper.py. */
const DBH_TOL = 0.05;
function taperScale(P, D, H) {
  const r = taperRaw(P, D, H, 1.3) / D;
  return r > 0 ? Math.min(Math.max(r, 1 - DBH_TOL), 1 + DBH_TOL) / r : 1;
}
function taperDiam(P, D, H, h, k) { return taperRaw(P, D, H, h) * (k ?? taperScale(P, D, H)); }
/* Formtal for et træ med diameter D (cm) og højde H (m): skaftmasse m. bark fra 10 cm stub til top, uden grene,
   divideret med π/4·D²·H. CLAUDE-1162: klemmes ind i [0,30; 0,70] i stedet for at springe til 0,50. */
const F_MIN = 0.30, F_MAX = 0.70;
function formFactor(art, D, H) {
  D = num(D) || 0; H = num(H) || 0; if (D <= 0 || H <= 1.3) return 0.50;
  const P = taperParams(art), k = taperScale(P, D, H), a = 0.1, n0 = Math.max(20, Math.ceil((H - a) / 0.1)), n = n0 + n0 % 2, st = (H - a) / n;
  const area = h => (taperDiam(P, D, H, h, k) / 200) ** 2 * Math.PI;
  let s = area(a) + area(H); for (let i = 1; i < n; i++) s += area(a + i * st) * (i % 2 ? 4 : 2);
  const F = s * st / 3 / (Math.PI / 4 * (D / 100) ** 2 * H);
  return Number.isFinite(F) ? Math.min(Math.max(F, F_MIN), F_MAX) : 0.50;
}
const VOL_DEF = "Vedmasse = skaftmasse m. bark til top, uden grene (SkovPlans stammekurve)";   // CLAUDE-1162 (B1)
/* Vedmasse pr. art: G_art × H × formtal(art, D, H). H = artens Hg, ellers litraets/punktets Hg, ellers planens.
   CLAUDE-1162 (K3): formtallet regnes pr. art (før: hovedartens formtal for alle arter). «Blandet» bruger litraets art. */
function vinkelVolume(s, standProps, artHint) {
  const p = standProps || {}, Hplan = num(p.middelhoejde_m), Dplan = num(p.middeldiameter_cm);
  const arts = s.byArt?.length ? s.byArt : [{ art: artHint || p["træart"] || "", G: s.G, Hg: s.Hg, Dg: s.Dg }];
  let V = 0, G = 0, from = "målt";
  const parts = [];
  for (const a of arts) {
    if (!a.G) continue;
    const H = a.Hg || s.Hg || Hplan, D = a.Dg || s.Dg || Dplan || arts.find(x => x.Dg)?.Dg;   // CLAUDE-1162: ellers en målt arts Dg
    if (!H) return null;
    const hFrom = a.Hg ? "målt" : s.Hg ? "litraet" : "planen";
    if (hFrom === "planen") from = "planen";
    const art = a.art && a.art !== "Blandet" ? a.art : (artHint || p["træart"] || a.art || ""), F = D ? formFactor(art, D, H) : 0.50;
    V += a.G * H * F; G += a.G; parts.push({ key: a.art, art, G: a.G, H, D, F, V: a.G * H * F, hFrom });
  }
  if (!s.G || !G) return null;
  const main = [...parts].sort((x, y) => y.G - x.G)[0];
  return { V, F: main.F, H: main.H, hFrom: from, art: main.art, parts };
}
/* CLAUDE-1162 (B1): Madsen (1987), DFF beretning 350, tabel 11–13 (bøg, eg, ask), samme koefficienter som dff350_volume.py.
   top 0 = totalvolumen inkl. grene og bark; top 7 = volumen til 7 cm (derbholz). Kun inden for kildens højde- og Dg-domæne. */
const DFF350 = {
  "Bøg": [[6.0, 36.7], [0.04, 0.76], { 0: [0.467065, { 1: 2.100761, 2: 0.715347, 3: 0.235416, 5: 0.064329 }, 0.002777, 1],
    7: [-0.825426, { 1: 2.181697, 2: 0.994047, 17: 0.957453, 18: 1.008783, 25: 0.148965 }, 0.001925, 2] }],
  "Eg": [[3.3, 32.4], [0.02, 0.88], { 0: [-0.172852, { 1: 2.084477, 2: 0.801886, 4: 1.079690, 24: 0.280564 }, 0.003174, 1],
    7: [-0.855221, { 1: 2.125952, 2: 0.945090, 17: 0.794239, 18: 0.991454, 24: 0.728208, 25: -0.388666 }, 0.001630, 3] }],
  "Ask": [[4.7, 31.3], [0.03, 0.59], { 0: [-1.088694, { 1: 2.002341, 2: 1.022051, 4: 2.174706, 24: 0.697865, 25: -0.614073 }, 0.002518, 1],
    7: [-1.515177, { 1: 1.991150, 2: 1.125761, 17: 0.558633, 18: 1.070868, 24: 0.297575 }, 0.001774, 2] }],
};
const DFF_ALIAS = { "bøg": "Bøg", "eg": "Eg", "stilkeg": "Eg", "vintereg": "Eg", "ask": "Ask" };
function dffTreeVolume(art, dcm, hm, dgcm, top = 0) {
  const spec = DFF350[DFF_ALIAS[String(art || "").trim().toLowerCase()]];
  if (!spec || !spec[2][top]) return null;
  const d = dcm / 100, h = hm, dg = dgcm / 100, a = top / 100;
  if (!(d > a && dg > 0 && h > 1.3) || h < spec[0][0] || h > spec[0][1] || dg < spec[1][0] || dg > spec[1][1]) return null;
  const x = { 1: Math.log(d), 2: Math.log(h), 3: Math.log(dg), 4: Math.log(h / (h - 1.3)), 5: Math.log(dg) ** 2, 24: dg, 25: dg * dg };
  if (a) { x[17] = Math.log1p(((a / d) * ((h - 1.3) / h)) ** 1.5); x[18] = Math.log1p(-((a / d) ** 4) * ((h - 1.3) / h) ** 2); }
  const [b0, terms, bias, wt] = spec[2][top];
  const w = wt === 1 ? 1 : (1 - (a / d) ** 2) * (1 - d / 2) ** (wt - 1);
  if (w <= 0) return null;
  const v = Math.exp(b0 + Object.entries(terms).reduce((s, [i, c]) => s + c * x[i], 0) + bias / w);
  return Number.isFinite(v) ? v : null;
}
/* Middeltræ: N × v(Dg, Hg) med Dg også som bevoksningens Dg. Returnerer {total, derb} m³/ha eller null. */
function dffStand(art, N, Dg, Hg) {
  if (!N || !Dg || !Hg) return null;
  const t = dffTreeVolume(art, Dg, Hg, Dg, 0), d7 = dffTreeVolume(art, Dg, Hg, Dg, 7);
  return t === null && d7 === null ? null : { total: t === null ? null : N * t, derb: d7 === null ? null : N * d7 };
}
const SKOVTYPER = [["Åben skov, få og store træer", "Relaskop på 1", 1], ["Almindelig skov", "Relaskop på 2", 2], ["Tæt skov, fx tæt nåleskov", "Relaskop på 4", 4]];
/* ------------------------------------------------------------------ kamerasigte til vinkeltælling
   Kameraet virker som et nålehulskamera: et punkt i vinklen θ fra midten står f·tan θ pixels fra midten (f = brændvidde i
   skærm-pixels). Kalibrering: et A4-ark på langs (29,7 cm) i kendt afstand D fylder S pixels → f = S·D/W.
   Et træ er «ind», når d/(2R) > √BAF/100, dvs. vinklen er over 2·asin(√BAF/100); sigtet er 2·f·tan(asin(√BAF/100)) pixels bredt.
   Kalibreringen gemmes på telefonen (pr. skærmbredde i stående format). */
const CAL_KEY = "sigteKalibrering";
function sightCal() { try { const c = JSON.parse(safeLS(CAL_KEY) || "null"); return c && c.f > 0 ? c : null; } catch (e) { return null; } }
const sightF = c => c.f * innerWidth / c.w;           // skalér, hvis skærmbredden har ændret sig (fx drejet)
const sightPx = (baf, f) => 2 * f * Math.tan(Math.asin(Math.sqrt(baf) / 100));
/* Find stammens bredde, hvor brugeren trykker: et vandret bånd af billedet (5 rækkeblokke) undersøges fra trykpunktet
   og ud til hver side, til farven skifter tydeligt fra stammens. Medianen af blokkenes bredder bruges.
   Returnerer bredden i skærm-pixels og kanterne, eller null hvis stammen ikke kan skelnes fra baggrunden. */
function trunkWidth(video, sx, sy) {
  const vw = video.videoWidth, vh = video.videoHeight; if (!vw || !vh) return null;
  const W = innerWidth, H = innerHeight, k = Math.max(W / vw, H / vh), x0 = (W - vw * k) / 2, y0 = (H - vh * k) / 2;
  const vx = Math.round((sx - x0) / k), vy = Math.round((sy - y0) / k);
  const band = Math.max(10, Math.round(vh * 0.02)), blocks = 5, rows = band * blocks;
  const top = Math.max(0, Math.min(vh - rows, vy - Math.floor(rows / 2)));
  const cv = trunkWidth.cv || (trunkWidth.cv = document.createElement("canvas"));
  cv.width = vw; cv.height = rows;
  const g = cv.getContext("2d", { willReadFrequently: true }); g.drawImage(video, 0, top, vw, rows, 0, 0, vw, rows);
  const px = g.getImageData(0, 0, vw, rows).data, widths = [], lefts = [], rights = [];
  for (let b = 0; b < blocks; b++) {
    const prof = new Float32Array(vw * 3);                    // gennemsnitsfarve pr. kolonne i blokken
    for (let y = b * band; y < (b + 1) * band; y++) for (let x = 0; x < vw; x++) { const i = (y * vw + x) * 4; prof[x * 3] += px[i]; prof[x * 3 + 1] += px[i + 1]; prof[x * 3 + 2] += px[i + 2]; }
    for (let i = 0; i < prof.length; i++) prof[i] /= band;
    const col = x => [prof[x * 3], prof[x * 3 + 1], prof[x * 3 + 2]];
    const ref = [0, 0, 0]; let n = 0;
    for (let x = Math.max(0, vx - 3); x <= Math.min(vw - 1, vx + 3); x++) { const c = col(x); ref[0] += c[0]; ref[1] += c[1]; ref[2] += c[2]; n++; }
    ref[0] /= n; ref[1] /= n; ref[2] /= n;
    const dist = x => { const c = col(x); return Math.hypot(c[0] - ref[0], c[1] - ref[1], c[2] - ref[2]); };
    // tærskel: halvvejs mellem stammens egen variation og kontrasten til omgivelserne
    const inner = Math.max(...[-2, -1, 1, 2].map(o => dist(Math.max(0, Math.min(vw - 1, vx + o)))));
    const far = Math.max(dist(Math.max(0, vx - Math.round(vw * 0.15))), dist(Math.min(vw - 1, vx + Math.round(vw * 0.15))));
    const T = Math.max(28, inner * 2.5, Math.min(far * 0.5, 80));
    const edge = dir => { let x = vx; for (; x > 0 && x < vw - 1; x += dir) if (dist(x) > T && dist(x + dir) > T) return x; return null; };
    const L = edge(-1), R = edge(1);
    if (L !== null && R !== null && R - L > 3) { widths.push(R - L - 1); lefts.push(L + 0.5); rights.push(R - 0.5); }   // L og R er første kolonne uden for stammen
  }
  if (widths.length < 3) return null;
  const med = a => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
  const w = med(widths), spread = (Math.max(...widths) - Math.min(...widths)) / w;
  if (spread > 0.35) return null;                              // blokkene er uenige: kanten er ikke tydelig
  return { w: w * k, left: x0 + med(lefts) * k, right: x0 + med(rights) * k, sure: spread < 0.15 };
}
async function openSight(d, api) {
  const box = document.createElement("div"); box.id = "sight";
  box.innerHTML = `<video id="sgVid" playsinline muted autoplay></video>
    <div id="sgOver"></div>
    <div class="sg-top"><div class="bafbig"><span>Relaskop</span><b>${fmt(d.baf, 0)}</b></div>
      <div class="grow" id="sgMsg"></div><button id="sgClose" aria-label="Luk">✕</button></div>
    <div class="sg-bottom" id="sgBottom"></div>`;
  document.body.appendChild(box);
  let stream = null;
  const close = () => { stream?.getTracks().forEach(t => t.stop()); box.remove(); keepAwake(!!state.track); api.done(); };
  $("#sgClose").onclick = close;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
    const track = stream.getVideoTracks()[0], caps = track.getCapabilities?.() || {};
    if (caps.zoom) { try { await track.applyConstraints({ advanced: [{ zoom: Math.max(caps.zoom.min, Math.min(1, caps.zoom.max)) }] }); } catch (e) { /* fast zoom */ } }
    $("#sgVid").srcObject = stream; keepAwake(true);
  } catch (e) {
    $("#sgMsg").innerHTML = `<b>Kameraet kunne ikke åbnes.</b><br>${esc(e.message || e.name)}. Giv appen lov til kameraet i telefonens indstillinger, eller tæl med dit eget relaskop.`;
    return;
  }
  const count = () => {
    const c = sightCal(); if (!c) return calibrate();
    const w = sightPx(d.baf, sightF(c)), s = vinkelStats(d);
    $("#sgOver").innerHTML = `<div class="sg-gap" style="width:${w.toFixed(1)}px"></div>`;
    $("#sgMsg").innerHTML = `<b>Tryk på stammen</b> i 1,3 m højde, så måler appen, om den er bredere end åbningen. Du kan også selv trykke Ind eller Grænse.
      <br><span class="small">Drej en hel omgang. Et træ på 30 cm er grænsetræ i ${fmt(reachM(30, d.baf), 1)} m afstand. Kamerasigtet er en hjælp, ikke et kalibreret relaskop (ingen hældningskorrektion).</span>`;
    const ov = $("#sgOver");
    ov.onpointerdown = e => {
      const i = Math.min(api.art(), d.counts.length - 1), r = trunkWidth($("#sgVid"), e.clientX, e.clientY);
      const mark = (cls, txt, x = e.clientX) => { ov.querySelectorAll(".sg-det,.sg-edge").forEach(n => n.remove());
        ov.insertAdjacentHTML("beforeend", (r ? `<div class="sg-edge" style="left:${r.left}px;top:${e.clientY - 60}px"></div><div class="sg-edge" style="left:${r.right}px;top:${e.clientY - 60}px"></div>` : "")
          + `<div class="sg-det ${cls}" style="left:${Math.min(Math.max(x, 130), innerWidth - 130)}px;top:${e.clientY + 70}px">${txt}</div>`); };
      if (!r) { mark("unk", "Kan ikke se stammens kanter. Vurdér selv."); return; }
      // stammens vinkelbredde (rigtig også uden for midten af billedet) sammenlignet med sigtets vinkel
      const f = sightF(c), cx = innerWidth / 2, ang = Math.atan((r.right - cx) / f) - Math.atan((r.left - cx) / f);
      const ratio = ang / (2 * Math.asin(Math.sqrt(d.baf) / 100));
      // ±8 % om åbningens bredde regnes som grænsetræ; sikre ind-træer tælles med det samme
      if (ratio > 1.08 && r.sure) { api.bump(i, "ind"); count(); mark("in", `Ind ✓ (${fmt(ratio, 2)}× åbningen)`); }
      else if (ratio < 0.92 && r.sure) mark("out", `Ude (${fmt(ratio, 2)}× åbningen) – tælles ikke`);
      else mark("bord", `Tæt på grænsen (${fmt(ratio, 2)}×). Tryk Ind eller Grænse selv.`);
    };
    const i = Math.min(api.art(), d.counts.length - 1), row = d.counts[i];
    $("#sgBottom").innerHTML = `
      <div class="sg-arts">${d.counts.map((r, k) => `<button data-art="${k}" class="${k === i ? "on" : ""}">${esc(r.art)} <b>${fmtCnt((num(r.ind) || 0) + 0.5 * (num(r.gr) || 0))}</b></button>`).join("")}</div>
      <div class="sg-sum">${fmtCnt(s.cnt)} træer · G ${fmt(s.G, 1)} m²/ha${s.cnt > 20 ? " · mange træer: overvej højere faktor" : ""}</div>
      <div class="sg-btns"><button id="sgUndo">↶</button><button id="sgGr" class="vgr">Grænse<b>${fmt(num(row.gr) || 0, 0)}</b></button>
        <button id="sgIn" class="vin">Ind<b>${fmt(num(row.ind) || 0, 0)}</b></button></div>
      <div class="sg-links"><button id="sgCal" class="linklike">Kalibrér igen</button><button id="sgDone" class="linklike">Færdig</button></div>`;
    $("#sgIn").onclick = () => { api.bump(i, "ind"); count(); };
    $("#sgGr").onclick = () => { api.bump(i, "gr"); count(); };
    $("#sgUndo").onclick = () => { api.undo(); count(); };
    $("#sgBottom").querySelector(".sg-arts").onclick = e => { const b = e.target.closest("[data-art]"); if (b) { api.art(+b.dataset.art); count(); } };
    $("#sgCal").onclick = calibrate; $("#sgDone").onclick = close;
  };
  const calibrate = () => {
    let L = innerWidth * 0.3, R = innerWidth * 0.7;
    const old = sightCal();
    const draw = () => { $("#sgOver").innerHTML = `<div class="sg-line" style="left:${L}px"></div><div class="sg-line" style="left:${R}px"></div>
      <div class="sg-span" style="left:${Math.min(L, R)}px;width:${Math.abs(R - L)}px"></div>`; };
    $("#sgMsg").innerHTML = `<b>Kalibrér kameraet (én gang pr. telefon)</b>
      <br><span class="small">1. Sæt et A4-ark <b>på langs</b> på en stamme eller væg. 2. Stil dig præcis i afstanden nedenfor (mål med målebånd), og hold telefonen lodret i 1× zoom.
      3. Træk de to streger ud til arkets kanter.</span>`;
    $("#sgBottom").innerHTML = `<div class="row"><div><label>Afstand til arket (m)</label><input id="sgDist" inputmode="decimal" value="${fmt(old?.dist || 3, 2)}"></div>
      <div><label>Arkets bredde (cm)</label><input id="sgW" inputmode="decimal" value="${fmt(old?.width || 29.7, 1)}"></div></div>
      <div class="sg-btns"><button id="sgCancel">${old ? "Annullér" : "Luk"}</button><button id="sgSave" class="vin">Gem kalibrering</button></div>`;
    draw();
    const ov = $("#sgOver"); let drag = null;
    ov.onpointerdown = e => { drag = Math.abs(e.clientX - L) < Math.abs(e.clientX - R) ? "L" : "R"; ov.setPointerCapture(e.pointerId); ov.onpointermove(e); };
    ov.onpointermove = e => { if (!drag) return; if (drag === "L") L = e.clientX; else R = e.clientX; draw(); };
    ov.onpointerup = ov.onpointercancel = () => { drag = null; };
    $("#sgCancel").onclick = () => { ov.onpointerdown = ov.onpointermove = null; old ? count() : close(); };
    $("#sgSave").onclick = () => {
      const D = num($("#sgDist").value), W = num($("#sgW").value) / 100, S = Math.abs(R - L);
      if (!D || D < 0.5 || !W || S < 10) return toast("Udfyld afstand og bredde, og træk stregerne ud til arkets kanter");
      safeLS(CAL_KEY, JSON.stringify({ f: S * D / W, w: innerWidth, dist: D, width: W * 100, at: new Date().toISOString() }));
      ov.onpointerdown = ov.onpointermove = null; toast("Kameraet er kalibreret"); count();
    };
  };
  count();
}

function vinkelForm(reg) {
  const d = reg.data, adv = bafAdvice(reg), defArt = reg.stand?.art || "";
  const sp = reg.stand && state.data?.layers.skovafdelinger.features.find(x => standKey(x.properties) === reg.stand.key)?.properties;
  if (!d.baf) d.baf = adv.baf;
  d.counts = d.counts?.length ? d.counts : [{ art: defArt || "Blandet", ind: 0, gr: 0 }];
  d.trees = d.trees || [];
  const hist = [], arts = ["Blandet", ...speciesOptions(defArt)];
  let cur = 0, showBaf = false, showHelp = false;
  openSheet(`
    <div class="head"><h3>Relaskop · ${esc(reg.stand?.label || "uden litra")}</h3><button data-act="cancelForm" class="close">Annullér</button></div>
    <div id="vTop"></div><div id="vBody"></div>`, true);
  /* Øverst: kun den faktor, relaskopet skal stå på. Valg og forklaring ligger bag «skift» og «?». */
  const drawTop = () => {
    if (!d.baf) {
      $("#vTop").innerHTML = `<div class="bafask"><b>Hvor tæt er skoven her?</b>
        ${SKOVTYPER.map(([t, g, b]) => `<button class="big" data-baf="${b}"><b>${t}</b><br><span class="muted small">${g}</span></button>`).join("")}</div>`;
      $("#vBody").innerHTML = ""; return;
    }
    const why = d.baf === adv.baf ? adv.why : adv.locked ? `Litraets andre punkter er talt med faktor ${adv.baf}.` : (d.bafWhy || "");
    $("#vTop").innerHTML = `<div class="rbar"><span>Stil relaskopet på</span><b class="rfak">${fmt(d.baf, 0)}</b>
        <button id="vChange" class="linklike">skift</button><button id="vHelp" class="qhelp" aria-label="Forklaring">?</button></div>
      ${showBaf ? `<div class="seg rseg">${BAFS.map(b => `<button data-baf="${b}" class="${b === d.baf ? "on" : ""}">${b}</button>`).join("")}</div>
        ${adv.locked ? `<p class="warn small">Litraets andre punkter er talt med ${adv.baf}. Brug helst samme faktor.</p>` : ""}` : ""}
      ${showHelp ? `<div class="help small"><p>${esc(why)} Hvert træ <b>ind</b> tæller ${fmt(d.baf, 0)} m²/ha, et <b>grænsetræ</b> det halve.</p>
        <p>Faktoren vælges, så du tæller omkring 10 træer pr. punkt (G ÷ 10), og den samme bruges i hele litraet.</p>
        <p>Tæl i 1,3 m højde. Kamerasigtet er en hjælp, ikke et kalibreret relaskop: det har ingen hældningskorrektion, og linsen kan forvrænge. Brug et rigtigt relaskop, når tallene skal ind i planen.</p>
        <p class="muted">Kilder: ${BAF_LIT} · ${BAF_SOURCES.map(([n, u]) => `<a href="${u}" target="_blank" rel="noopener">${esc(n)}</a>`).join(" · ")}</p></div>` : ""}`;
    $("#vChange").onclick = () => { showBaf = !showBaf; drawTop(); };
    $("#vHelp").onclick = () => { showHelp = !showHelp; drawTop(); };
    if (!$("#vBody").innerHTML) drawBody(); else result();
  };
  $("#vTop").onclick = e => { const b = e.target.closest("[data-baf]"); if (!b) return;
    const first = !d.baf; d.baf = +b.dataset.baf; showBaf = false;
    d.bafWhy = first ? `Valgt ud fra skovtypen (${SKOVTYPER.find(x => x[2] === d.baf)[0].toLowerCase()}).` : "Valgt af dig."; drawTop(); };
  const drawBody = () => {
    $("#vBody").innerHTML = `
      <div class="rarts" id="vArts"></div>
      <div class="rbtns"><button class="vgr" id="vGr" type="button">Grænse<b></b></button><button class="vin" id="vIn" type="button">Ind<b></b></button></div>
      <div class="rtools"><button id="vUndo" type="button">↶ Fortryd</button><button id="vCam" type="button" title="En hjælp, ikke et kalibreret relaskop">📷 Kamerasigte (hjælp)</button></div>
      <div class="result" id="vRes"></div>
      <details class="help"${d.trees.length ? " open" : ""}><summary>Mål et par træer (giver stamtal, Dg og Hg)</summary>
        <p class="muted small">Mål 1–2 træer på hvert punkt, så litraet får mindst 10 (mindst ${MIN_SAMPLED} af hver art, der skal have stamtal). Mål de talte træer, ikke de pæneste, i 1,3 m.</p>
        <table class="stokke"><thead><tr><th>#</th><th>Træart</th><th>Diam. cm</th><th>Højde m</th><th></th></tr></thead><tbody id="vTrees"></tbody></table>
        <button id="vAddTree" type="button">+ Målt træ</button></details>
      <details class="help"${d.note ? " open" : ""}><summary>Note</summary><textarea id="vNote">${esc(d.note || "")}</textarea></details>
      <div class="stack"><button class="primary big" id="vSave">Gem</button>
        ${reg._new ? "" : '<button class="danger" id="vDel">Slet</button>'}${!reg._new && reg.lat ? '<button id="goReg">➜ Gå hertil</button>' : ""}</div>`;
    drawRows(); drawTrees(); wire();
  };
  /* Træarter som knapper; de store knapper tæller på den valgte. */
  const drawRows = () => {
    cur = Math.min(cur, d.counts.length - 1);
    $("#vArts").innerHTML = d.counts.map((r, i) => `<button data-art="${i}" class="${i === cur ? "on" : ""}">${esc(r.art)} <b>${fmtCnt((num(r.ind) || 0) + 0.5 * (num(r.gr) || 0))}</b></button>`).join("")
      + `<select id="vArt" aria-label="Tilføj træart"><option value="">+ art</option>${arts.filter(a => !d.counts.some(r => r.art === a)).map(a => `<option>${esc(a)}</option>`).join("")}</select>`;
    const row = d.counts[cur];
    $("#vIn b").textContent = fmt(num(row.ind) || 0, 0); $("#vGr b").textContent = fmt(num(row.gr) || 0, 0);
    result();
  };
  const result = () => {
    if (!$("#vRes")) return;
    const s = vinkelStats(d), v = vinkelVolume(s, sp, defArt);
    let warn = "";
    if (s.cnt > 20) { const b = BAFS.find(x => x > s.baf); warn = `${fmtCnt(s.cnt)} træer er mange. ${b ? `Brug ${b} på næste punkt.` : ""}`; }
    else if (s.cnt > 0 && s.cnt < 5 && d.done) { const b = [...BAFS].reverse().find(x => x < s.baf); warn = `Kun ${fmtCnt(s.cnt)} træer. ${b ? `Faktor ${b} giver et sikrere tal.` : ""}`; }
    // CLAUDE-1162 (K3): tal pr. art; punktets egne få målte træer er altid et skøn – litraets tal ses på litraet.
    const multi = s.byArt.length > 1;
    $("#vRes").innerHTML = `<b>${fmtCnt(s.cnt)} træer · G ${fmt(s.G, 1)} m²/ha${v ? ` · ${fmt(v.V, 0)} m³/ha` : ""}</b>` +
      (s.N ? `<br>${fmt(s.N, 0)} stk/ha · Dg ${fmt(s.Dg, 1)} cm${s.Hg ? ` · Hg ${fmt(s.Hg, 1)} m` : ""} <i>(skøn ud fra ${s.sampled} målte træer)</i>` : "") +
      (multi || (s.sampled && !s.N) ? "<br>" + s.byArt.map(a => `${esc(a.art)}: G ${fmt(a.G, 1)}${a.N ? `, ${fmt(a.N, 0)} stk/ha, Dg ${fmt(a.Dg, 1)}` : s.sampled ? ", ingen målte træer" : ""}`).join(" · ") : "") +
      (v ? `<br><span class="muted small">Vedmasse = ${v.parts.length > 1 ? "Σ arter " : ""}G × Hg ${fmt(v.H, 1)} m (${v.hFrom}) × formtal ${v.parts.length > 1 ? v.parts.map(x => `${esc(x.art)} ${fmt(x.F, 2)}`).join(", ") : fmt(v.F, 2)}. ${VOL_DEF}.</span>` : s.G ? `<br><span class="muted small">Mål en højde for at få vedmassen.</span>` : "") +
      (warn ? `<div class="warn">${esc(warn)}</div>` : "");
  };
  const drawTrees = () => {
    $("#vTrees").innerHTML = d.trees.map((t, i) => `<tr><td>${i + 1}</td>
      <td><select data-i="${i}" data-k="art">${arts.map(a => `<option${a === t.art ? " selected" : ""}>${esc(a)}</option>`).join("")}</select></td>
      <td><input data-i="${i}" data-k="d" inputmode="decimal" value="${esc(t.d ?? "")}"></td>
      <td><input data-i="${i}" data-k="h" inputmode="decimal" value="${esc(t.h ?? "")}"></td>
      <td><button type="button" data-rm="${i}" aria-label="Fjern">×</button></td></tr>`).join("");
  };
  const wire = () => {
    const bump = (i, k) => { d.counts[i][k] = (num(d.counts[i][k]) || 0) + 1; hist.push([i, k]); if (navigator.vibrate) navigator.vibrate(25); drawRows(); };
    const undo = () => { const h = hist.pop(); if (!h) return toast("Intet at fortryde"); d.counts[h[0]][h[1]] = Math.max(0, (num(d.counts[h[0]][h[1]]) || 0) - 1); drawRows(); };
    $("#vIn").onclick = () => bump(cur, "ind");
    $("#vGr").onclick = () => bump(cur, "gr");
    $("#vUndo").onclick = undo;
    $("#vArts").onclick = e => { const b = e.target.closest("[data-art]"); if (b) { cur = +b.dataset.art; drawRows(); } };
    $("#vArts").onchange = e => { if (e.target.id !== "vArt" || !e.target.value) return; const a = e.target.value;
      if (d.counts.length === 1 && d.counts[0].art === "Blandet" && !num(d.counts[0].ind) && !num(d.counts[0].gr)) d.counts = [];
      d.counts.push({ art: a, ind: 0, gr: 0 }); cur = d.counts.length - 1; drawRows(); };
    $("#vCam").onclick = () => {
      if (!navigator.mediaDevices?.getUserMedia) return toast("Telefonens browser giver ikke adgang til kameraet her");
      openSight(d, { bump, undo, art: v => { if (v !== undefined) cur = v; return cur; }, done: () => drawRows() });
    };
    $("#vTrees").oninput = $("#vTrees").onchange = e => { const x = e.target; if (x.dataset.k) { d.trees[+x.dataset.i][x.dataset.k] = x.value.trim(); result(); } };
    $("#vTrees").onclick = e => { const b = e.target.closest("[data-rm]"); if (!b) return; d.trees.splice(+b.dataset.rm, 1); drawTrees(); result(); };
    $("#vAddTree").onclick = () => { d.trees.push({ art: d.counts[cur]?.art || defArt, d: "", h: "" }); drawTrees();
      $(`#vTrees input[data-i="${d.trees.length - 1}"][data-k="d"]`).focus(); };
    $("#vSave").onclick = async () => {
      const s = vinkelStats(d);
      if (!s.cnt) return toast("Tryk «Ind» for hvert træ, der tæller med");
      d.done = true;
      if (s.cnt < 5 && !confirm(`Du har kun talt ${fmtCnt(s.cnt)} træer. ${s.baf > 1 ? "En lavere faktor giver et sikrere tal. " : ""}Gem alligevel?`)) { result(); return; }
      d.counts = d.counts.filter(r => num(r.ind) || num(r.gr));
      d.trees = d.trees.filter(t => num(t.d)).map(t => ({ art: t.art, d: num(t.d), h: num(t.h) }));
      d.note = $("#vNote").value.trim(); delete d.done;
      if (!reg.lat && state.me) Object.assign(reg, pos());
      await saveReg(reg);
      const spr = vinkelSpread(state.regs.filter(r => r.stand?.key === reg.stand?.key)), v = vinkelVolume(vinkelStats(d), sp, defArt);
      toast(`Gemt: G ${fmt(s.G, 1)} m²/ha${v ? ` · ${fmt(v.V, 0)} m³/ha` : ""}` + (spr && spr.n > 1 ? ` · litraet: ${spr.n} punkter, G ${fmt(spr.mean, 1)}${spr.se !== null ? ` ± ${fmt(spr.se, 0)} %` : ""}` : ""), 5000);
      backToStand(reg);
    };
    if ($("#vDel")) $("#vDel").onclick = () => deleteReg(reg);
    if ($("#goReg")) $("#goReg").onclick = () => { closeSheet(); goTo(reg.lat, reg.lon, "Relaskop " + (reg.stand?.label || "")); };
  };
  drawTop();
}

/* -------- direkte taksation */
function taxForm(reg) {
  const d = reg.data, f = (id, lbl, v, mode = "decimal") => `<div><label>${lbl}</label><input id="${id}" inputmode="${mode}" value="${esc(v ?? "")}"></div>`;
  openSheet(`
    <div class="head"><h3>Taksation · ${esc(reg.stand.label)}</h3><button data-act="cancelForm" class="close">Annullér</button></div>
    <p class="muted">Udfyld kun det, du har vurderet. Tomme felter beholder SkovPlans tal ved indlæsning.</p>
    <div class="row">${f("tHg", "Hg (m)", d.hg)}${f("tDg", "Dg (cm)", d.dg)}</div>
    <div class="row">${f("tN", "Stamtal (pr. ha)", d.n, "numeric")}${f("tG", "Grundflade (m²/ha)", d.g)}</div>
    <div class="row">${f("tV", "Vedmasse (m³/ha)", d.v)}${f("tBk", "Bk (%)", d.bk, "numeric")}</div>
    <label>Ny træart (kun hvis den er forkert)</label><select id="tArt"><option value="">Uændret (${esc(reg.stand.art || "–")})</option>
      ${speciesOptions(d.art).map(a => `<option${a === d.art ? " selected" : ""}>${esc(a)}</option>`).join("")}</select>
    <label>Note</label><textarea id="tNote">${esc(d.note || "")}</textarea>
    <div class="stack"><button class="primary big" id="tSave">Gem taksation</button>
    ${reg._new ? "" : '<button class="danger" id="tDel">Slet</button>'}</div>`, true);
  $("#tSave").onclick = async () => {
    reg.data = { hg: num($("#tHg").value), dg: num($("#tDg").value), n: num($("#tN").value), g: num($("#tG").value),
      v: num($("#tV").value), bk: num($("#tBk").value), art: $("#tArt").value.trim(), note: $("#tNote").value.trim() };
    if (!reg.lat && state.me) Object.assign(reg, pos());
    await saveReg(reg); toast("Taksation gemt"); backToStand(reg);
  };
  if ($("#tDel")) $("#tDel").onclick = () => deleteReg(reg);
}

/* -------- note / foto
   En note kan have flere billeder. Hvert billede gemmes som sin egen «foto»-registrering med data.parent = notens id,
   så SkovPlan, synk og eksport behandler dem som før. En generel note hører ikke til et litra (stand = null). */
const childPhotos = reg => state.regs.filter(r => r.type === "foto" && r.data.parent === reg.id);
function noteForm(reg) {
  if (reg.type === "foto" && reg.data.parent) { const p = state.regs.find(r => r.id === reg.data.parent); if (p) return editReg(p.id); }
  const isNote = reg.type === "note";
  reg._add = reg._add || []; reg._drop = reg._drop || [];
  const title = reg.type === "foto" ? "Foto" : reg.data.general ? "Generel note" : "Note";
  openSheet(`
    <div class="head"><h3>${title}${reg.data.general ? "" : " · " + esc(reg.stand?.label || "uden litra")}</h3><button data-act="cancelForm" class="close">Annullér</button></div>
    ${reg.photo ? `<img id="nImg" style="width:100%;border-radius:10px;margin:6px 0" alt="">` : ""}
    <label>${reg.type === "foto" ? "Tekst til billedet" : "Note"}</label><textarea id="nNote">${esc(reg.data.note || "")}</textarea>
    ${isNote ? `<div id="nPhotos" class="thumbs"></div>
    <div class="actions"><button id="nCam">📷 Tag billede</button><button id="nGal">🖼 Vælg billeder</button></div>` : ""}
    <div class="stack"><button class="primary big" id="nSave">Gem</button>${reg._new ? "" : '<button class="danger" id="nDel">Slet</button>'}
    ${!reg._new && reg.lat ? '<button id="goReg">➜ Gå hertil</button>' : ""}</div>`);
  if (reg.photo) $("#nImg").src = URL.createObjectURL(reg.photo);
  if (isNote) {
    state.noteDraft = reg;
    const draw = () => {
      const kept = childPhotos(reg).filter(c => !reg._drop.includes(c.id)).map(c => ({ id: c.id, blob: c.photo }));
      const all = [...kept, ...reg._add];
      $("#nPhotos").innerHTML = all.map(x => `<span class="thumb"><img data-ph="${x.id}" alt=""><button data-rm="${x.id}" aria-label="Fjern">×</button></span>`).join("");
      all.forEach(x => { const img = $("#nPhotos").querySelector(`img[data-ph="${x.id}"]`); if (img && x.blob) img.src = URL.createObjectURL(x.blob); });
      $("#nPhotos").querySelectorAll("button[data-rm]").forEach(b => b.onclick = ev => {
        ev.preventDefault(); ev.stopPropagation(); const id = b.dataset.rm;
        if (reg._add.some(x => x.id === id)) reg._add = reg._add.filter(x => x.id !== id); else reg._drop.push(id);
        draw();
      });
    };
    reg._draw = draw; draw();
    $("#nCam").onclick = () => $("#photoInput").click();
    $("#nGal").onclick = () => $("#galleryInput").click();
  }
  $("#nSave").onclick = async () => {
    reg.data.note = $("#nNote").value.trim();
    const photos = isNote ? childPhotos(reg).filter(c => !reg._drop.includes(c.id)).length + reg._add.length : 0;
    if (isNote && !reg.data.note && !photos) return toast("Skriv en note eller tilføj et billede");
    const add = reg._add || [], drop = reg._drop || [];
    for (const k of ["_add", "_drop", "_draw"]) delete reg[k];
    state.noteDraft = null;
    await saveReg(reg);
    if (isNote) {
      if (drop.length) markGone(drop, "slettet");   // CLAUDE-1162 (K4)
      for (const id of drop) { await db.del("regs", id); dropRegs(r => r.id === id); }
      for (const c of childPhotos(reg)) if (c.data.note !== reg.data.note) { c.data.note = reg.data.note; await saveReg(c); }
      for (const x of add) await saveReg({ id: x.id, type: "foto", created: x.created, lat: reg.lat, lon: reg.lon, accuracy: reg.accuracy,
        stand: reg.stand, data: { note: reg.data.note, parent: reg.id, general: !!reg.data.general }, photo: x.blob });
      if (drop.length) { drawRegMarkers(); refreshMenuInfo(); scheduleSync(true); }
    }
    toast("Gemt"); backToStand(reg);
  };
  if ($("#nDel")) $("#nDel").onclick = () => deleteReg(reg);
  if ($("#goReg")) $("#goReg").onclick = () => { closeSheet(); goTo(reg.lat, reg.lon, (reg.data.general ? "Generel note" : reg.type === "foto" ? "Foto" : "Note") + (reg.stand ? " · " + reg.stand.label : "")); };
}
async function takePhoto(file) {
  const blob = await shrinkImage(file, 1600, 0.82);
  const draft = state.noteDraft;
  if (draft && $("#nPhotos")) { draft._add.push({ id: uid(), blob, created: new Date().toISOString() }); return draft._draw(); }
  const stand = currentStand();
  noteForm({ id: uid(), _new: true, type: "foto", created: new Date().toISOString(), ...pos(), stand, data: { note: "", filename: file.name }, photo: blob });
}
async function shrinkImage(file, max, q) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(res => c.toBlob(b => res(b || file), "image/jpeg", q));
  } catch (e) { return file; }
}

/* -------- fælles */
const pos = () => state.me ? { lat: state.me.lat, lon: state.me.lon, accuracy: state.me.accuracy } : {};
function currentStand() {
  if (state.selected) return standInfo(state.selected.properties);
  if (state.me) { const f = standAt(state.me.lon, state.me.lat); if (f) return standInfo(f.properties); }
  return null;
}
function newReg(type, general = false) {
  const stand = general ? null : currentStand();
  const base = { id: uid(), _new: true, type, created: new Date().toISOString(), ...pos(), stand };
  if (type === "proeveflade") return plotForm({ ...base, data: { radius: 10, trees: [], hg: null, bk: null, note: "" } });
  if (type === "vinkel") return vinkelForm({ ...base, data: { counts: [], trees: [], note: "" } });
  if (type === "taksation") return stand ? taxForm({ ...base, data: {} }) : toast("Vælg et litra først");
  if (type === "note") return noteForm({ ...base, data: general ? { note: "", general: true } : { note: "" } });
}
/* state.allRegs: alle registreringer på telefonen; state.regs: kun den aktive ejendoms. */
function dropRegs(pred) { state.regs = state.regs.filter(r => !pred(r)); state.allRegs = state.allRegs.filter(r => !pred(r)); }
const regsFor = d => state.allRegs.filter(r => !r.ejendom || !d || r.ejendom === d.name);
async function saveReg(reg) {
  delete reg._new; reg.updated = new Date().toISOString(); delete reg.exported; delete reg.synced;
  if (!reg.ejendom) reg.ejendom = state.data?.name || null;
  await db.put("regs", reg);
  for (const list of [state.regs, state.allRegs]) { const i = list.findIndex(r => r.id === reg.id); i >= 0 ? list[i] = reg : list.push(reg); }
  drawRegMarkers(); restyle(); refreshMenuInfo(); scheduleSync();
}
/* CLAUDE-1162 (K4): hvad der er slettet (sendes med i næste eksport) og ryddet efter eksport (må ikke regnes som slettet). */
function tombstones() { try { const t = JSON.parse(safeLS("feltSlettet") || "null"); return t && t.slettet ? t : { slettet: {}, ryddet: {} }; } catch (e) { return { slettet: {}, ryddet: {} }; } }
function markGone(ids, kind) {
  const t = tombstones(), dato = new Date().toISOString();
  for (const id of ids) { const r = state.allRegs.find(x => x.id === id); t[kind][id] = { dato, ejendom: r?.ejendom || state.data?.name || null }; }
  safeLS("feltSlettet", JSON.stringify(t));
}
function deviceId() { let id = safeLS("enhedId"); if (!id) { id = "enhed-" + uid(); safeLS("enhedId", id); } return id || "ukendt"; }
async function deleteReg(reg) {
  if (!confirm("Slet denne registrering?")) return;
  const gone = new Set([reg.id, ...childPhotos(reg).map(c => c.id)]);
  if (!reg._new) markGone([...gone], "slettet");
  for (const id of gone) await db.del("regs", id);
  dropRegs(r => gone.has(r.id)); state.noteDraft = null;
  drawRegMarkers(); restyle(); refreshMenuInfo(); backToStand(reg); scheduleSync(true);
}
function backToStand(reg) {
  state.noteDraft = null;
  const f = reg.stand && state.data?.layers.skovafdelinger.features.find(x => standKey(x.properties) === reg.stand.key);
  f ? selectStand(f) : listAll();
}
let regLayer = null;
function drawRegMarkers() {
  if (regLayer) map.removeLayer(regLayer);
  regLayer = L.layerGroup(state.regs.filter(r => r.lat).map(r => r.type === "spor"
    ? L.polyline(r.data.points.map(p => [p[0], p[1]]), { color: "#e8710a", weight: 3, opacity: 0.8, dashArray: "1 6", lineCap: "round" }).on("click", () => editReg(r.id))
    : L.circleMarker([r.lat, r.lon], {
    radius: r.type === "proeveflade" || r.type === "vinkel" ? 7 : 5, color: "#fff", weight: 2, fillOpacity: 1,
    fillColor: { proeveflade: "#7a1fa2", foto: "#e8710a", note: "#1a73e8", taksation: "#0b8043", vinkel: "#c2185b", stak: "#8d5524", stok: "#5d4037" }[r.type],
  }).on("click", () => editReg(r.id)))).addTo(map);
}
function editReg(id) {
  const r = state.regs.find(x => x.id === id); if (!r) return;
  const copy = { ...r, data: JSON.parse(JSON.stringify(r.data)) };
  ({ proeveflade: plotForm, vinkel: vinkelForm, taksation: taxForm, foto: noteForm, note: noteForm, spor: trackForm, stak: stakForm, stok: stokForm })[r.type](copy);
}
function listAll() {
  state.selected = null; restyle();
  const regs = state.regs.filter(r => !r.data.parent).sort((a, b) => b.created.localeCompare(a.created));
  openSheet(`<div class="head"><h3>Alle registreringer (${regs.length})</h3><button class="close">Luk</button></div>
    <div class="actions"><button class="primary" data-act="newPlot">+ Prøveflade</button><button data-act="photo">📷 Foto</button><button data-act="note">✎ Note</button></div>
    <button class="big" data-act="vinkel">◔ Relaskopmåling</button>
    <button class="big" data-act="generalNote">✎ Generel note (ikke knyttet til et litra)</button>
    <button class="big" data-act="pileList">Stakke og stokke (opmåling)</button>
    ${regs.length ? `<ul class="list">${regs.map(regItem).join("")}</ul>` : '<p class="muted">Ingen registreringer endnu. Tryk på et litra på kortet for at begynde.</p>'}
    <button class="primary big" data-act="export">Eksportér til SkovPlan</button>`);
  hydrateThumbs();
}

/* ------------------------------------------------------------------ stakke og stokke
   Stak: længde × dybde × højde = rummeter; × fastmasse-% = m³ fast (beregnet); flis: × flisfaktor = rm flis (løs).
   Stok: stokke målt med længde og midtdiameter (Hubers formel: π/4 · d² · L), evt. flere ens stokke pr. linje.
   Flere mål i ét felt (fx højden målt tre steder: «2,1 2,4 2,2») giver gennemsnittet. «+» og «/» afvises (CLAUDE-1162).
   CLAUDE-1162 (B4): flisfaktoren er 2,6 rm flis pr. m³ fast som i SkovPlan (domain/prices.py CHIP_RM_PER_SOLID_M3).
   CLAUDE-1162 (B6): stokke kan være målt med eller uden bark; med bark trækkes artens dobbelte barktykkelse fra. Med
   nedrunding (handelspraksis) rundes d ned til hel cm og L ned til 0,1 m, efter at et evt. overmål er trukket fra L. */
const STAK_TYPES = { flis: "Flis", braende: "Brænde", rundtrae: "Rundtræ" };
const FASTMASSE = [["Grot / toppe", 20], ["Heltræ, små træer", 35], ["Energitræ, rundtræ", 55], ["Rundtræ stablet", 65], ["Brænde stablet", 65], ["Brænde løst kastet", 45]];
const SORTIMENTER = ["Skovflis", "Heltræ", "Grot", "Energitræ", "Brænde", "Industritræ", "Gavntræ", "Kævler", "Savtømmer", "Pæle"];
const CHIP_RM_PER_M3 = 2.6;   // CLAUDE-1162
const chipFactor = () => num(state.data?.pakke?.flisfaktor) || CHIP_RM_PER_M3;   // CLAUDE-1162: feltpakken har SkovPlans tal
const badMulti = v => /[+\/]/.test(String(v ?? ""));   // CLAUDE-1162 (B7)
const avgNum = v => { if (badMulti(v)) return null; const xs = String(v ?? "").trim().split(/[\s;]+/).map(num).filter(x => x !== null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
/* Forslag til barkfradrag (dobbelt barktykkelse i midten, cm). Erfaringstal, ikke en norm: ret til den aftale, der gælder med køberen. */
const BARK_CM = { "Bøg": 1, "Avnbøg": 1, "Ahorn": 1, "Ask": 1.5, "Birk": 1.5, "Rødel": 1.5, "Eg": 2.5, "Rødgran": 1.5, "Sitkagran": 1.5,
  "Ædelgran": 1.5, "Grandis": 1.5, "Nobilis": 1.5, "Douglasgran": 2.5, "Lærk": 2.5, "Skovfyr": 2 };
const barkFor = art => BARK_CM[art] ?? 1.5;
const floorTo = (x, step) => Math.floor(x / step + 1e-9) * step;
/* Én linje stokke efter bark, overmål og nedrunding: {n, l, d} som de afregnes. */
function stokRow(t, o) {
  o = o || {}; const n = num(t.n) ?? 1; let L = num(t.l), dcm = num(t.d);
  if (!L || !dcm) return null;
  L -= (num(o.overmaal) || 0) / 100;
  if (o.bark === "med") dcm -= num(o.barkcm) || 0;
  if (o.nedrund) { L = +floorTo(L, 0.1).toFixed(1); dcm = Math.floor(dcm + 1e-9); }
  return L > 0 && dcm > 0 ? { n, l: L, d: dcm } : null;
}
function stakCalc(d) {
  const L = avgNum(d.l), D = avgNum(d.d), H = avgNum(d.h), pct = num(d.pct), k = num(d.faktor);
  const rm = L && D && H ? L * D * H : null, fast = rm !== null && pct ? rm * pct / 100 : null;
  return { L, D, H, rm, fast, flis: d.type === "flis" && fast !== null && k ? fast * k : null, bad: [d.l, d.d, d.h].some(badMulti) };
}
const stokVol = (t, o) => { const r = stokRow(t, o); return r ? Math.PI / 4 * (r.d / 100) ** 2 * r.l * r.n : 0; };
function stokCalc(d) { const rows = (d.stokke || []).filter(t => num(t.l) && num(t.d)); return { n: rows.reduce((a, t) => a + (num(t.n) ?? 1), 0), m3: rows.reduce((a, t) => a + stokVol(t, d), 0) }; }
const pileM3 = r => r.type === "stak" ? stakCalc(r.data).fast : r.type === "stok" ? stokCalc(r.data).m3 : null;
function nextPileNr() {
  const nrs = state.allRegs.filter(r => r.type === "stak" || r.type === "stok").map(r => parseInt(r.data.nr, 10)).filter(Number.isFinite);
  return String(Math.max(nrs.length ? Math.max(...nrs) : 0, parseInt(safeLS("sidsteStakNr") || "0", 10) || 0) + 1);
}
function pileText(r) {
  const d = r.data, what = r.type === "stak" ? "Stak" : "Stok";
  const m3 = pileM3(r), extra = r.type === "stak" ? stakCalc(d) : stokCalc(d);
  return `<b>${what} ${esc(d.nr || "")}</b> · ${m3 ? fmt(m3, 1) + " m³ fast" : "ikke målt"}` +
    (r.type === "stak" && extra.flis ? ` · ${fmt(extra.flis, 1)} rm flis` : "") + (r.type === "stok" && extra.n ? ` · ${fmt(extra.n, 0)} stk` : "") +
    [d.sortiment, d.art].filter(Boolean).map(x => " · " + esc(x)).join("");
}
function pileBase(reg, extra = "") {
  const d = reg.data, inp = (id, lbl, v, list) => `<label>${lbl}</label><input id="${id}" value="${esc(v ?? "")}"${list ? ` list="${list}"` : ""} autocomplete="off">`;
  const known = k => [...new Set(state.allRegs.filter(r => r.data?.[k]).map(r => r.data[k]))];
  return `
    <div class="row"><div><label>Nr.</label><input id="pNr" inputmode="numeric" value="${esc(d.nr ?? "")}"></div>
      <div><label>&nbsp;</label><button id="pNext" type="button">Næste nr.</button></div></div>
    <div class="row"><div><label>Træart</label><select id="pArt"><option value="">–</option>
      ${["Blandet", ...speciesOptions(d.art)].map(a => `<option${a === d.art ? " selected" : ""}>${esc(a)}</option>`).join("")}</select></div>
      <div>${inp("pSort", "Sortiment", d.sortiment, "dlSort")}</div></div>
    ${extra}
    <datalist id="dlSort">${[...new Set([...SORTIMENTER, ...known("sortiment")])].map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pKunde", "Kunde (køber)", d.kunde, "dlKunde")}<datalist id="dlKunde">${known("kunde").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pOrdre", "Ordre", d.ordre, "dlOrdre")}<datalist id="dlOrdre">${known("ordre").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pHugst", "Hugstopgave", d.hugst, "dlHugst")}<datalist id="dlHugst">${known("hugst").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pAfd", "Afdeling", d.afdeling ?? reg.stand?.label ?? "")}
    ${inp("pSkover", "Skover", d.skover, "dlSkover")}<datalist id="dlSkover">${known("skover").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    ${inp("pUdk", "Udkører", d.udkoerer, "dlUdk")}<datalist id="dlUdk">${known("udkoerer").map(s => `<option value="${esc(s)}">`).join("")}</datalist>
    <label>Bemærkning</label><textarea id="pNote">${esc(d.note || "")}</textarea>`;
}
function readPileBase(reg) {
  Object.assign(reg.data, { nr: $("#pNr").value.trim(), art: $("#pArt").value, sortiment: $("#pSort").value.trim(), kunde: $("#pKunde").value.trim(),
    ordre: $("#pOrdre").value.trim(), hugst: $("#pHugst").value.trim(), afdeling: $("#pAfd").value.trim(), skover: $("#pSkover").value.trim(),
    udkoerer: $("#pUdk").value.trim(), note: $("#pNote").value.trim() });
}
function pileFooter(reg) {
  return `<div class="stack"><button class="primary big" id="pSave">Gem</button>
    ${reg._new ? "" : '<button class="danger" id="pDel">Slet</button>'}${!reg._new && reg.lat ? '<button id="goReg">➜ Gå hertil</button>' : ""}</div>`;
}
function wirePile(reg, read, check) {
  $("#pNext").onclick = () => { $("#pNr").value = nextPileNr(); };
  $("#pSave").onclick = async () => {
    readPileBase(reg); read();
    const bad = check && check(); if (bad) return toast(bad, 6000);   // CLAUDE-1162
    if (!reg.data.nr) return toast("Skriv et nummer (eller tryk «Næste nr.»)");
    if (!reg.lat && state.me) Object.assign(reg, pos());
    if (parseInt(reg.data.nr, 10)) safeLS("sidsteStakNr", String(Math.max(parseInt(reg.data.nr, 10), parseInt(safeLS("sidsteStakNr") || "0", 10) || 0)));
    await saveReg(reg); toast((reg.type === "stak" ? "Stak " : "Stok ") + reg.data.nr + " er gemt"); pileList();
  };
  if ($("#pDel")) $("#pDel").onclick = async () => { await deleteReg(reg); pileList(); };
  if ($("#goReg")) $("#goReg").onclick = () => { closeSheet(); goTo(reg.lat, reg.lon, (reg.type === "stak" ? "Stak " : "Stok ") + reg.data.nr); };
}
function stakForm(reg) {
  const d = reg.data, f = (id, lbl, v) => `<div><label>${lbl}</label><input id="${id}" inputmode="decimal" value="${esc(typeof v === "number" ? String(v).replace(".", ",") : v ?? "")}"></div>`;
  openSheet(`
    <div class="head"><h3>${reg._new ? "Ny stak" : "Stak " + esc(d.nr)}${reg.stand ? " · " + esc(reg.stand.label) : ""}</h3><button data-act="pileList" class="close">Fortryd</button></div>
    <h4>Grunddata</h4>${pileBase(reg, `<label>Type</label>
    <div class="seg" id="sType">${Object.entries(STAK_TYPES).map(([k, v]) => `<button type="button" data-t="${k}" class="${d.type === k ? "on" : ""}">${v}</button>`).join("")}</div>`)}
    <h4>Målinger</h4>
    <div class="row3">${f("sL", "Længde (m)", d.l)}${f("sD", "Dybde (m)", d.d)}${f("sH", "Højde (m)", d.h)}</div>
    <p class="muted small">Målt flere steder? Skriv målene med mellemrum, fx «2,1 2,4 2,2», så bruges gennemsnittet. «+» og «/» bruges ikke: er stakken delt i sektioner, så opret en stak pr. sektion.</p>
    <div class="row"><div><label>Fastmasse</label><select id="sPre">${FASTMASSE.map(([n, p]) => `<option value="${p}">${n} (${p} %)</option>`).join("")}<option value="">Egen</option></select></div>
      ${f("sPct", "Fastmasse (%)", d.pct)}</div>
    <div class="row"><div><label>Rummeter (L × D × H)</label><input id="sRm" readonly tabindex="-1"></div><div><label>m³ fast (beregnet)</label><input id="sVol" readonly tabindex="-1"></div></div>
    <div class="row">${f("sK", "Flisfaktor (rm flis pr. m³ fast)", d.faktor)}<div><label>rm flis (løs)</label><input id="sFlis" readonly tabindex="-1"></div></div>
    <p class="muted small">SkovPlan bruger ${fmt(chipFactor(), 1)} rm flis pr. m³ fast (${fmt(1 / chipFactor(), 2)} m³ fast pr. rm flis).</p>
    <p class="muted small" id="sRes"></p>
    ${pileFooter(reg)}`, true);
  const pre = $("#sPre"), match = FASTMASSE.find(([n, p]) => n === d.preset) || FASTMASSE.find(([, p]) => p === num(d.pct));
  pre.selectedIndex = match ? FASTMASSE.indexOf(match) : FASTMASSE.length;
  const read = () => Object.assign(d, { l: $("#sL").value.trim(), d: $("#sD").value.trim(), h: $("#sH").value.trim(), pct: num($("#sPct").value),
    faktor: num($("#sK").value), preset: pre.value ? FASTMASSE[pre.selectedIndex][0] : "" });
  const show = () => {
    read(); const c = stakCalc(d);
    $("#sRm").value = c.rm === null ? "" : fmt(c.rm, 2); $("#sVol").value = c.fast === null ? "" : fmt(c.fast, 2);
    $("#sFlis").value = c.flis === null ? (d.type === "flis" ? "" : "– (kun flis)") : fmt(c.flis, 2);
    $("#sRes").textContent = c.bad ? "«+» og «/» bruges ikke i målene. Skriv flere mål med mellemrum (så bruges gennemsnittet), eller opret en stak pr. sektion." :
      c.rm === null ? "Udfyld længde, dybde og højde; resten regnes ud." :
      ([c.L, c.D, c.H].some((x, i) => x !== null && String([d.l, d.d, d.h][i]).trim().split(/[\s;]+/).length > 1) ? `Gennemsnit: ${fmt(c.L, 2)} × ${fmt(c.D, 2)} × ${fmt(c.H, 2)} m` : "");
  };
  pre.onchange = () => { if (pre.value) $("#sPct").value = pre.value; show(); };
  $("#sType").onclick = e => { const b = e.target.closest("[data-t]"); if (!b) return; d.type = b.dataset.t;
    $("#sType").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    const want = { flis: 0, braende: 4, rundtrae: 3 }[d.type];
    if (pre.value && reg._new) { pre.selectedIndex = want; $("#sPct").value = FASTMASSE[want][1]; }
    show(); };
  for (const id of ["sL", "sD", "sH", "sPct", "sK"]) $("#" + id).oninput = show;
  $("#sPct").addEventListener("input", () => { if (num($("#sPct").value) !== num(pre.value)) pre.selectedIndex = FASTMASSE.length; });
  show(); wirePile(reg, read, () => stakCalc(d).bad ? "«+» og «/» bruges ikke i målene. Skriv flere mål med mellemrum, eller opret en stak pr. sektion." : null);
}
function stokForm(reg) {
  const d = reg.data; d.stokke = d.stokke?.length ? d.stokke : [{ n: 1, l: "", d: "" }];
  // CLAUDE-1162 (B6): bark, barkfradrag, nedrunding og overmål. Ældre stokke uden felterne regnes som før (ingen fradrag).
  const bTxt = v => typeof v === "number" ? String(v).replace(".", ",") : v ?? "";
  openSheet(`
    <div class="head"><h3>${reg._new ? "Ny stok" : "Stok " + esc(d.nr)}${reg.stand ? " · " + esc(reg.stand.label) : ""}</h3><button data-act="pileList" class="close">Fortryd</button></div>
    <h4>Grunddata</h4>${pileBase(reg)}
    <h4>Målinger</h4>
    <p class="muted small">Længde og diameter på midten af stokken (Hubers formel). Ens stokke kan stå på samme linje med et antal.</p>
    <label>Diameteren er målt</label><div class="seg" id="kBark"><button type="button" data-b="med" class="${d.bark === "med" ? "on" : ""}">med bark</button><button type="button" data-b="uden" class="${d.bark === "uden" ? "on" : ""}">uden bark</button></div>
    <div class="row"><div><label>Barkfradrag (cm, dobbelt bark)</label><input id="kBarkCm" inputmode="decimal" value="${esc(bTxt(d.barkcm))}"></div>
      <div><label>Overmål på længden (cm)</label><input id="kOver" inputmode="decimal" value="${esc(bTxt(d.overmaal))}"></div></div>
    <label class="check"><input type="checkbox" id="kRound" ${d.nedrund ? "checked" : ""}> Rund d ned til hel cm og L ned til 0,1 m (handelspraksis)</label>
    <p class="muted small" id="kBarkInfo"></p>
    <table class="stokke"><thead><tr><th>#</th><th>Antal</th><th>Længde m</th><th>Midtdiam. cm</th><th>m³</th><th></th></tr></thead><tbody id="kRows"></tbody></table>
    <button id="kAdd" type="button">+ Stok</button>
    <div class="result" id="kRes"></div>
    ${pileFooter(reg)}`, true);
  const draw = (focus) => {
    $("#kRows").innerHTML = d.stokke.map((t, i) => `<tr><td>${i + 1}</td>
      <td><input data-i="${i}" data-k="n" inputmode="numeric" value="${esc(t.n ?? 1)}"></td>
      <td><input data-i="${i}" data-k="l" inputmode="decimal" value="${esc(t.l ?? "")}"></td>
      <td><input data-i="${i}" data-k="d" inputmode="decimal" value="${esc(t.d ?? "")}"></td>
      <td class="v" id="kV${i}"></td><td><button type="button" data-rm="${i}" aria-label="Fjern">×</button></td></tr>`).join("");
    sum(); if (focus !== undefined) $(`#kRows input[data-i="${focus}"][data-k="l"]`)?.focus();
  };
  const readOpts = () => Object.assign(d, { barkcm: num($("#kBarkCm").value), overmaal: num($("#kOver").value), nedrund: $("#kRound").checked });
  const sum = () => {
    readOpts();
    d.stokke.forEach((t, i) => { const v = stokVol(t, d); $("#kV" + i).textContent = v ? fmt(v, 2) : ""; });
    const c = stokCalc(d); $("#kRes").innerHTML = c.n ? `<b>${fmt(c.n, 0)} stokke · ${fmt(c.m3, 2)} m³${d.bark === "uden" || (d.bark === "med" && num(d.barkcm)) ? " uden bark" : d.bark === "med" ? " med bark" : ""}</b>` : "Udfyld længde og diameter.";
    $("#kBarkInfo").textContent = !d.bark ? "Vælg, om diameteren er målt med eller uden bark." :
      d.bark === "med" ? `Fra diameteren trækkes ${fmt(num(d.barkcm) || 0, 1)} cm (forslag for ${d.art || "arten"}: ${fmt(barkFor(d.art), 1)} cm; ret efter aftalen med køberen).` : "Ingen barkfradrag.";
  };
  $("#kBark").onclick = e => { const b = e.target.closest("[data-b]"); if (!b) return; d.bark = b.dataset.b;
    $("#kBark").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); sum(); };
  for (const id of ["kBarkCm", "kOver"]) $("#" + id).oninput = sum;
  $("#kRound").onchange = sum;
  $("#pArt").addEventListener("change", () => { if (d.bark === "med" && !reg._barkEdited) { $("#kBarkCm").value = bTxt(barkFor($("#pArt").value)); d.art = $("#pArt").value; sum(); } });
  $("#kBarkCm").addEventListener("input", () => { reg._barkEdited = true; });
  $("#kRows").oninput = e => { const x = e.target; if (x.dataset.k) { d.stokke[+x.dataset.i][x.dataset.k] = x.value.trim(); sum(); } };
  $("#kRows").onclick = e => { const b = e.target.closest("[data-rm]"); if (!b) return; d.stokke.splice(+b.dataset.rm, 1); if (!d.stokke.length) d.stokke.push({ n: 1, l: "", d: "" }); draw(); };
  $("#kAdd").onclick = () => { const last = d.stokke[d.stokke.length - 1] || {}; d.stokke.push({ n: 1, l: last.l || "", d: "" }); draw(d.stokke.length - 1); };
  draw();
  wirePile(reg, () => { readOpts(); delete reg._barkEdited; d.stokke = d.stokke.filter(t => num(t.l) || num(t.d)); },
    () => d.stokke.some(t => badMulti(t.l) || badMulti(t.d) || badMulti(t.n)) ? "«+» og «/» bruges ikke i målene. Skriv én stok pr. linje." : !d.bark ? "Vælg, om diameteren er målt med eller uden bark." : null);
}
function newPile(type) {
  const base = { id: uid(), _new: true, type, created: new Date().toISOString(), ...pos(), stand: currentStand() };
  const last = state.allRegs.filter(r => r.type === type).sort((a, b) => b.created.localeCompare(a.created))[0]?.data || {};
  const keep = { art: last.art || "", sortiment: last.sortiment || "", kunde: last.kunde || "", ordre: last.ordre || "", hugst: last.hugst || "", skover: last.skover || "", udkoerer: last.udkoerer || "" };
  // CLAUDE-1162 (B4): 2,6 rm flis pr. m³ fast som i SkovPlan; den gamle standard 2,8 fra appen tages ikke med videre.
  if (type === "stak") return stakForm({ ...base, data: { nr: nextPileNr(), type: last.type || "flis", pct: last.pct ?? 20, preset: last.preset ?? FASTMASSE[0][0], faktor: last.faktor && last.faktor !== 2.8 ? last.faktor : chipFactor(), ...keep } });
  stokForm({ ...base, data: { nr: nextPileNr(), stokke: [], bark: last.bark || "med", barkcm: last.bark ? last.barkcm : barkFor(keep.art), nedrund: last.nedrund ?? true, overmaal: last.overmaal ?? null, ...keep } });
}
function pileList(q) {
  state.selected = null; restyle();
  q = q ?? state.pileQuery ?? ""; state.pileQuery = q;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const all = state.regs.filter(r => r.type === "stak" || r.type === "stok").sort((a, b) => b.created.localeCompare(a.created));
  const hay = r => [r.type, r.data.nr, r.data.art, r.data.sortiment, r.data.kunde, r.data.ordre, r.data.hugst, r.data.udkoerer, r.data.skover, r.data.afdeling, r.data.note, r.stand?.label,
    STAK_TYPES[r.data.type], r.created.slice(0, 10)].filter(Boolean).join(" ").toLowerCase();
  const shown = all.filter(r => words.every(w => hay(r).includes(w)));
  const total = shown.reduce((a, r) => a + (pileM3(r) || 0), 0), flis = shown.reduce((a, r) => a + (r.type === "stak" ? stakCalc(r.data).flis || 0 : 0), 0);
  openSheet(`<div class="head"><h3>Stakke og stokke</h3><button class="close">Luk</button></div>
    <div class="actions"><button class="primary" data-act="newStak">+ Stak</button><button class="primary" data-act="newStok">+ Stok</button></div>
    <div class="search"><input id="pQ" type="search" placeholder="Søg: nr., art, sortiment, køber, hugst …" value="${esc(q)}"><button id="pClr" type="button">Ryd</button></div>
    ${all.length ? `<p class="muted">${shown.length} af ${all.length} · ${fmt(total, 1)} m³ fast${flis ? ` · ${fmt(flis, 1)} rm flis` : ""}</p>
      <ul class="list">${shown.map(regItem).join("")}</ul>` : '<p class="muted">Ingen stakke eller stokke endnu.</p>'}`, true);
  const qi = $("#pQ");
  qi.oninput = () => { clearTimeout(pileList.t); pileList.t = setTimeout(() => { const p = qi.selectionStart; pileList(qi.value); const n = $("#pQ"); n.focus(); n.setSelectionRange(p, p); }, 250); };
  $("#pClr").onclick = () => pileList("");
}

/* ------------------------------------------------------------------ eksport */
const TAX_HEADERS = ["Afd", "Litra", "Areal (ha)", "Træart", "Sidste taksation", "Taksationsår", "Hg (m)", "Dg (cm)",
  "Stamtal (pr. ha)", "Grundflade (m²/ha)", "Vedmasse (m³/ha)", "Bk (%)", "Ny bemærkning", "Ny træart", "Etableringsår"];
const csvCell = v => { const s = String(v ?? ""); return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function buildTaxCsv() {
  const by = {};
  state.regs.filter(r => r.stand).forEach(r => (by[r.stand.key] = by[r.stand.key] || []).push(r));
  const lines = [TAX_HEADERS.join(";")];
  const keys = Object.keys(by).sort((a, b) => { const [x, y] = [a, b].map(k => k.split("|")); return (+x[0] - +y[0]) || x[1].localeCompare(y[1], "da"); });
  let rows = 0;
  for (const key of keys) {
    const regs = by[key], st = regs[0].stand, s = standSummary(regs);
    // Noter og fotos går ikke i litraets bemærkning; SkovPlan viser dem for sig under «Fra felten».
    // CLAUDE-1162: kun det, der er målt for hovedarten (s.exp): skøn fra relaskop og vedmasse med planens Hg står tomme (B2, B10, K3).
    const e = s.exp || {};
    const hasMeasure = ["Hg", "Dg", "N", "G", "V", "Bk"].some(k => e[k] !== undefined && e[k] !== null) || s.art;
    if (!hasMeasure) continue;
    lines.push([st.afd, st.litra, csvNum(standArea(key) || st.areal, 2), st.art, "", hasMeasure ? YEAR : "",
      csvNum(e.Hg, 1), csvNum(e.Dg, 1), csvNum(e.N, 0), csvNum(e.G, 1), csvNum(e.V, 0), csvNum(e.Bk, 0), "", s.art || "", ""].map(csvCell).join(";"));
    rows++;
  }
  return { csv: "﻿" + lines.join("\r\n") + "\r\n", rows };
}
/* Alle målte træer, én række pr. træ – åbner direkte i Excel. */
function buildTreeCsv() {
  const head = ["Afd", "Litra", "Prøveflade", "Dato", "Radius (m)", "Træ nr", "Træart", "D1 (cm)", "D2 (cm)", "Diameter (cm)", "Højde (m)", "Bemærkning", "Bk (%)", "Note til prøvefladen", "Bredde", "Længde", "GPS ± (m)"];
  const lines = [head.join(";")]; let rows = 0;
  const plots = state.regs.filter(r => r.type === "proeveflade").sort((a, b) => (a.stand?.label || "").localeCompare(b.stand?.label || "", "da") || a.created.localeCompare(b.created));
  const nrBy = {};
  for (const p of plots) {
    const key = p.stand?.key || "-"; nrBy[key] = (nrBy[key] || 0) + 1;
    p.data.trees.forEach((t, i) => {
      lines.push([p.stand?.afd ?? "", p.stand?.litra ?? "", nrBy[key], p.created.slice(0, 10), csvNum(p.data.radius, 2), i + 1, t.art || p.stand?.art || "",
        csvNum(num(t.d1 ?? t.d), 1), csvNum(num(t.d2), 1), csvNum(num(t.d), 1), csvNum(num(t.h), 1), t.note || "", i === 0 ? csvNum(num(p.data.bk), 0) : "", i === 0 ? (p.data.note || "") : "",
        p.lat ? p.lat.toFixed(6).replace(".", ",") : "", p.lon ? p.lon.toFixed(6).replace(".", ",") : "", p.accuracy ? Math.round(p.accuracy) : ""].map(csvCell).join(";"));
      rows++;
    });
  }
  return { csv: "\ufeff" + lines.join("\r\n") + "\r\n", rows };
}
/* Stakke og stokke, én række pr. stak/stok – åbner direkte i Excel. */
function buildPileCsv() {
  const head = ["Hvad", "Nr", "Dato", "Type", "Træart", "Sortiment", "Kunde", "Ordre", "Hugstopgave", "Afdeling", "Skover", "Udkører", "Afd", "Litra", "Længde (m)", "Dybde (m)", "Højde (m)",
    "Rummeter", "Fastmasse (%)", "m³ fast", "Flisfaktor (rm/m³)", "rm flis", "Antal stokke", "Diameter målt", "Barkfradrag (cm)", "Nedrundet", "Overmål (cm)", "Bemærkning", "Bredde", "Længde"];
  const lines = [head.join(";")];
  const piles = state.regs.filter(r => r.type === "stak" || r.type === "stok").sort((a, b) => (parseInt(a.data.nr, 10) || 0) - (parseInt(b.data.nr, 10) || 0));
  for (const r of piles) {
    const d = r.data, c = r.type === "stak" ? stakCalc(d) : {}, k = r.type === "stok" ? stokCalc(d) : {};
    lines.push([r.type === "stak" ? "Stak" : "Stok", d.nr, r.created.slice(0, 10), r.type === "stak" ? STAK_TYPES[d.type] || "" : "", d.art, d.sortiment, d.kunde, d.ordre, d.hugst, d.afdeling ?? r.stand?.label ?? "", d.skover, d.udkoerer,
      r.stand?.afd ?? "", r.stand?.litra ?? "", csvNum(c.L, 2), csvNum(c.D, 2), csvNum(c.H, 2), csvNum(c.rm, 2), r.type === "stak" ? csvNum(num(d.pct), 0) : "",
      csvNum(r.type === "stak" ? c.fast : k.m3, 2), r.type === "stak" && d.type === "flis" ? csvNum(num(d.faktor), 2) : "", csvNum(c.flis, 2), r.type === "stok" ? k.n : "",
      r.type === "stok" && d.bark ? d.bark + " bark" : "", r.type === "stok" && d.bark === "med" ? csvNum(num(d.barkcm) || 0, 1) : "", r.type === "stok" ? (d.nedrund ? "ja" : "nej") : "",
      r.type === "stok" ? csvNum(num(d.overmaal), 0) : "", d.note || "",
      r.lat ? r.lat.toFixed(6).replace(".", ",") : "", r.lon ? r.lon.toFixed(6).replace(".", ",") : ""].map(csvCell).join(";"));
  }
  return { csv: "\ufeff" + lines.join("\r\n") + "\r\n", rows: piles.length };
}
function photoName(r) { return `fotos/${(r.stand?.label || "uden-litra").replace(/[^\wæøåÆØÅ-]+/g, "_")}_${r.created.slice(0, 19).replace(/[:T]/g, "-")}_${r.id.slice(-4)}.jpg`; }
function buildGeoJSON() {
  return {
    type: "FeatureCollection",
    features: state.regs.map(r => {
      const props = { id: r.id, type: r.type, oprettet: r.created, rettet: r.updated || r.created, gps_noejagtighed_m: r.accuracy ? Math.round(r.accuracy) : null,
        afd: r.stand?.afd ?? null, litra: r.stand?.litra ?? null, litra_navn: r.stand?.label ?? null, compartment_id: r.stand?.compartment_id ?? null,
        note: r.data.note || null, note_id: r.data.parent || null, generel: r.data.general ? 1 : null };
      if (r.type === "proeveflade") { const s = plotStats(r.data); Object.assign(props, { radius_m: r.data.radius, antal_traeer: s.n, stamtal_ha: s.N != null ? Math.round(s.N) : null,
        grundflade_m2_ha: s.G != null ? +s.G.toFixed(2) : null, dg_cm: s.Dg && +s.Dg.toFixed(1), hg_m: s.Hg && +s.Hg.toFixed(1), bk_pct: r.data.bk, traeer_json: JSON.stringify(r.data.trees) }); }
      if (r.type === "vinkel") { const s = vinkelStats(r.data); Object.assign(props, { baf: s.baf, antal_traeer: s.cnt, grundflade_m2_ha: +s.G.toFixed(2),
        // CLAUDE-1162: punktets N/Dg/Hg bygger på få træer og er et skøn; litraets tal går via taksationsarket.
        stamtal_ha: s.N ? Math.round(s.N) : null, dg_cm: s.Dg && +s.Dg.toFixed(1), hg_m: s.Hg && +s.Hg.toFixed(1), traeer_json: JSON.stringify({ counts: r.data.counts, trees: r.data.trees }) });
        const v = vinkelVolume(s, standProps(r.stand?.key), r.stand?.art); if (v) props.vedmasse_m3_ha = Math.round(v.V); }
      if (r.type === "taksation") Object.assign(props, { hg_m: r.data.hg, dg_cm: r.data.dg, stamtal_ha: r.data.n, grundflade_m2_ha: r.data.g, vedmasse_m3_ha: r.data.v, bk_pct: r.data.bk, ny_traeart: r.data.art || null });
      if (r.type === "foto") props.foto = photoName(r);
      if (r.type === "stak" || r.type === "stok") {
        const d = r.data, c = r.type === "stak" ? stakCalc(d) : null, k = r.type === "stok" ? stokCalc(d) : null;
        Object.assign(props, { stak_nr: d.nr || null, sortiment: d.sortiment || null, traeart: d.art || null, koeber: d.kunde || null, ordre: d.ordre || null,
          hugst: d.hugst || null, udkoerer: d.udkoerer || null, skover: d.skover || null, afdeling: d.afdeling || null, volumen_m3: (c ? c.fast : k.m3) != null ? +(c ? c.fast : k.m3).toFixed(2) : null,
          rummeter: c?.rm != null ? +c.rm.toFixed(2) : null, flis_rm: c?.flis != null ? +c.flis.toFixed(2) : null, fastmasse_pct: c ? d.pct : null,
          stak_type: c ? STAK_TYPES[d.type] || null : null, antal_stokke: k ? k.n : null, maal_json: JSON.stringify(d) });
      }
      if (r.type === "spor") {
        Object.assign(props, { laengde_m: r.data.length_m, varighed_min: Math.round(r.data.minutes || 0), slut: r.data.points.length ? new Date(r.data.points[r.data.points.length - 1][2] * 1000).toISOString() : null });
        return { type: "Feature", geometry: { type: "LineString", coordinates: r.data.points.map(p => [p[1], p[0]]) }, properties: props };
      }
      return { type: "Feature", geometry: r.lat ? { type: "Point", coordinates: [+r.lon.toFixed(7), +r.lat.toFixed(7)] } : null, properties: props };
    }),
  };
}
function buildExportZip(withPhotos = true) {
  const zip = new JSZip(), stamp = today(), { csv, rows } = buildTaxCsv();
  zip.file(`taksationsark_felt_${stamp}.csv`, csv);
  // CLAUDE-1162 (K4): eksporten er fuld (alle registreringer for ejendommen på denne telefon). SkovPlan opdaterer ændrede
  // registreringer og markerer dem, der er slettet her, som slettet. «Ryddede» (fjernet efter eksport) er ikke slettet.
  const ej = state.data?.name || null, tomb = tombstones(), forEj = o => Object.entries(o).filter(([, v]) => !ej || !v.ejendom || v.ejendom === ej);
  zip.file("registreringer.geojson", JSON.stringify({ ...buildGeoJSON(), skovplan: { ejendom: ej, ...(state.data?.pakke || {}),
    fuld: true, enhed: deviceId(), eksporteret: new Date().toISOString(),
    slettede: forEj(tomb.slettet).map(([id, v]) => ({ id, dato: v.dato })), ryddede: forEj(tomb.ryddet).map(([id]) => id) } }, null, 1));
  const trees = buildTreeCsv(); if (trees.rows) zip.file(`enkelttraeer_${stamp}.csv`, trees.csv);
  const piles = buildPileCsv(); if (piles.rows) zip.file(`stakke_og_stokke_${stamp}.csv`, piles.csv);
  if (withPhotos) state.regs.filter(r => r.photo).forEach(r => zip.file(photoName(r), r.photo));
  zip.file("LAES-MIG.txt", [
    `SkovPlan Felt – eksport ${new Date().toLocaleString("da-DK")}`, `Skov: ${state.data?.name || ""}`, "",
    "Hent filen ind i SkovPlan med «Hent data fra app» (Import og ældre driftsplaner).", "",
    `taksationsark_felt_${stamp}.csv: ${rows} litra (indlæses automatisk af «Hent data fra app»).`,
    "  Tomme celler betyder «behold SkovPlans tal». Tallene er litraets HOVEDART (største grundflade); de andre arter står i appen.",
    "  Dg er den kvadratiske middeldiameter (G = N·π/4·Dg²). Hg er Loreys middelhøjde (Σg·h/Σg) over alle træer; højder, der ikke er målt,",
    "  aflæses på en Näslund-højdekurve pr. litra, når litraet har mindst 3 målte højder.",
    `  Relaskop: stamtal, Dg og Hg regnes pr. art og kommer kun med, når litraet har mindst ${MIN_SAMPLED} målte træer af arten; ellers er de et skøn.`,
    "  Vedmasse = skaftmasse m. bark til top, uden grene (SkovPlans stammekurve). Er Hg taget fra planen, står vedmassen tom.",
    "enkelttraeer_<dato>.csv: alle målte træer, én række pr. træ (art, diameter, højde, bemærkning). Åbner i Excel.",
    `stakke_og_stokke_<dato>.csv: opmålte stakke og stokke med rummeter, m³ fast og rm flis (løs; standard ${String(chipFactor()).replace(".", ",")} rm flis pr. m³ fast). Åbner i Excel.`,
    "registreringer.geojson: alle prøveflader, fotos og noter som punkter (WGS84). Kan trækkes direkte ind i QGIS.",
    "fotos/: billederne; filnavnet står i feltet «foto» i geojson-filen.",
  ].join("\r\n"));
  return { zip, rows, stamp };
}
async function doExport() {
  if (!state.regs.length) return toast("Der er intet at eksportere endnu");
  const { zip, rows, stamp } = buildExportZip(true);
  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const name = `skovplan-felt_${(state.data?.name || "skov").replace(/[^\wæøåÆØÅ-]+/g, "_")}_${stamp}.zip`;
  const file = new File([blob], name, { type: "application/zip" });
  const canShare = !!(navigator.canShare && navigator.canShare({ files: [file] }));
  openSheet(`<div class="head"><h3>Gem eksporten</h3><button class="close">Luk</button></div>
    ${syncCfg() ? `<p class="ok-note">Online-synk er slået til, så registreringerne sendes automatisk til SkovPlan, når telefonen har net. Filen her er kun en ekstra sikkerhedskopi.</p>` : ""}
    <p><b>${esc(name)}</b> · ${blob.size < 1048576 ? Math.max(1, Math.round(blob.size / 1024)) + " kB" : fmt(blob.size / 1048576, 1) + " MB"} · ${state.regs.length} registrering${state.regs.length === 1 ? "" : "er"}</p>
    ${canShare ? `<p>Tryk <b>Gem på Drev</b>, vælg <b>Drev</b> og gem i mappen <b>SkovPlan Felt</b>.
      Drev husker mappen næste gang.</p>` : `<p>Filen hentes til telefonens Overførsler. Læg den i Drev-mappen <b>SkovPlan Felt</b>.</p>`}
    <p class="muted">På pc'en henter SkovPlan den selv med «Hent data fra app».</p>
    <button class="primary big" id="btnShare">${canShare ? "Gem på Drev" : "Hent filen"}</button>`);
  const download = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
  $("#btnShare").onclick = async () => {
    if (canShare) {
      // Nogle telefoner afviser zip-filer i del-menuen; så prøves som almindelig fil, og ellers gemmes den i Overførsler.
      let ok = false, err = null;
      for (const f of [file, new File([blob], name, { type: "application/octet-stream" })]) {
        try { await navigator.share({ files: [f] }); ok = true; break; }
        catch (e) { if (e.name === "AbortError") return; err = e; console.warn("share", e); }
      }
      if (!ok) { download(); toast("Telefonen ville ikke dele filen (" + (err?.name || "fejl") + "), så den er gemt i Overførsler. Læg den i Drev-mappen SkovPlan Felt.", 9000); }
    } else download();
    const t = new Date().toISOString();
    for (const r of state.regs) { r.exported = t; await db.put("regs", r); }
    closeSheet(); refreshMenuInfo(); toast(`Eksporteret: ${state.regs.length} registreringer, ${rows} litra i taksationsarket`, 4000);
  };
}
async function clearExported() {
  const done = state.regs.filter(r => r.exported);
  if (!done.length) return toast("Ingen eksporterede registreringer at slette");
  if (!confirm(`Slet ${done.length} registreringer, der allerede er eksporteret?`)) return;
  markGone(done.map(r => r.id), "ryddet");   // CLAUDE-1162 (K4): ryddet fra telefonen, ikke slettet i SkovPlan
  for (const r of done) await db.del("regs", r.id);
  dropRegs(r => r.exported); drawRegMarkers(); restyle(); refreshMenuInfo(); closeSheet();
}

/* ------------------------------------------------------------------ online synkronisering
   Har feltpakken en «sync»-blok (Supabase), sendes registreringerne automatisk, når der er net:
   først nye fotos (ét ad gangen), derefter hele eksporten uden fotos som én zip. SkovPlan henter selv. */
const syncCfg = () => state.data?.pakke?.sync?.rest && state.data.pakke.sync.noegle ? state.data.pakke.sync : null;
let syncTimer = null, syncing = false;
function scheduleSync(force) {
  if (!syncCfg()) return;
  if (force) state.syncHash = null;
  clearTimeout(syncTimer); syncTimer = setTimeout(syncNow, 2500);
}
async function rpc(fn, body) {
  const c = syncCfg();
  const res = await fetch(`${c.rest}/rpc/${fn}`, { method: "POST",
    headers: Object.assign({ "Content-Type": "application/json", apikey: c.anon },
      /^eyJ/.test(c.anon) ? { Authorization: "Bearer " + c.anon } : {}), body: JSON.stringify(body) });
  if (!res.ok) { let m = ""; try { m = (await res.json()).message; } catch (e) { /* ok */ } throw new Error(m || "HTTP " + res.status); }
  return res.json();
}
const b64 = async blob => { const b = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
async function syncNow(manual) {
  const c = syncCfg();
  if (!c) { if (manual) toast("Feltpakken har ingen online-synkronisering. Lav en ny feltpakke i SkovPlan.", 5000); return; }
  if (syncing) return; if (!navigator.onLine) { if (manual) toast("Ingen forbindelse – sendes, når der er net"); return; }
  syncing = true; setSyncStatus("sender …");
  try {
    const mine = state.regs.filter(r => !r.ejendom || r.ejendom === state.data.name);
    for (const r of mine.filter(r => r.photo && !r.photoSynced)) {
      await rpc("felt_foto", { p_noegle: c.noegle, p_navn: photoName(r).split("/").pop(), p_data: await b64(r.photo) });
      r.photoSynced = new Date().toISOString(); await db.put("regs", r);
    }
    const hash = JSON.stringify(mine.map(r => [r.id, r.updated || r.created]));
    if (mine.length && (hash !== state.syncHash || manual)) {
      const all = state.regs; state.regs = mine;
      let built; try { built = buildExportZip(false); } finally { state.regs = all; }
      const zip64 = await built.zip.generateAsync({ type: "base64", compression: "DEFLATE" });
      await rpc("felt_indsend", { p_noegle: c.noegle, p_navn: `skovplan-felt_${(state.data.name || "skov").replace(/[^\wæøåÆØÅ-]+/g, "_")}_${built.stamp}.zip`, p_zip: zip64, p_antal: mine.length });
      state.syncHash = hash; safeLS("syncHash:" + c.noegle, hash);
      const t = new Date().toISOString();
      for (const r of mine) { r.synced = t; r.exported = r.exported || t; await db.put("regs", r); }
    }
    safeLS("syncAt:" + c.noegle, new Date().toISOString());
    setSyncStatus("sendt " + new Date().toLocaleTimeString("da-DK", { hour: "2-digit", minute: "2-digit" }));
    if (manual) toast(`Sendt til SkovPlan: ${mine.length} registreringer`, 3500);
  } catch (err) {
    console.warn("sync", err); setSyncStatus("ikke sendt (" + err.message + ")");
    if (manual) toast("Kunne ikke sende: " + err.message, 6000);
  } finally { syncing = false; refreshMenuInfo(); }
}
function setSyncStatus(t) { state.syncStatus = t; refreshMenuInfo(); }
window.addEventListener("online", () => scheduleSync());

/* ------------------------------------------------------------------ handlinger */
function refreshMenuInfo() {
  const n = state.regs.length, ne = state.regs.filter(r => !r.exported).length;
  const c = syncCfg(), ns = state.regs.filter(r => !r.synced).length;
  $("#menuInfo").textContent = `${state.data ? (state.data.name + " · indlæst " + new Date(state.data.loaded).toLocaleDateString("da-DK")) : "Intet skovkort"} · ${state.ortho ? "ortofoto gemt" : "intet ortofoto"} · ${n} registreringer` +
    (c ? ` · online: ${ns ? ns + " venter" : "alt sendt"}${state.syncStatus ? " (" + state.syncStatus + ")" : ""}` : (ne ? `, ${ne} ikke eksporteret` : ""));
  $("#btnSync")?.classList.toggle("hidden", !c);
  $("#btnMenu").classList.toggle("pending", c ? ns > 0 : ne > 0);
  $("#btnMenu").title = c ? (ns ? `${ns} venter på at blive sendt` : "Alt er sendt til SkovPlan") : (ne ? `${ne} ikke eksporteret` : "");
  $("#btnUpdatePkg")?.classList.toggle("hidden", !onlinePackageUrl());
  propertyList().then(l => $("#btnChoose")?.classList.toggle("hidden", !(l.length > 1 || safeLS("kundeUrl"))));
}
const ACTIONS = {
  openGpkg: () => $("#gpkgInput").click(),
  welcome: () => showWelcome(true),
  layers: layerMenu,
  sync: () => syncNow(true),
  closeWelcome: () => { if (!state.ortho) safeLS("skipOrtho", "1"); $("#empty").classList.add("hidden"); },
  listAll, export: doExport, clearRegs: clearExported,
  basemap: () => { setBasemap((state.basemap + 1) % BASEMAPS.length); restyle(); toast(BASEMAPS[state.basemap].name); },
  newPlot: () => newReg("proeveflade"), vinkel: () => newReg("vinkel"), note: () => newReg("note"), taksation: () => newReg("taksation"),
  generalNote: () => newReg("note", true),
  goStand: () => { const f = state.selected; if (!f) return; const c = standTarget(f); closeSheet(); goTo(c.lat, c.lng, "Litra " + standLabel(f.properties)); },
  track: toggleTrack,
  pileList: () => pileList(), newStak: () => newPile("stak"), newStok: () => newPile("stok"),
  packageLink: askPackageLink,
  chooseProperty: () => propertySheet(),
  updatePackage: () => { const u = onlinePackageUrl(); u ? downloadPackage(u) : askPackageLink(); },
  install: async () => {
    if (state.installPrompt) { state.installPrompt.prompt(); const r = await state.installPrompt.userChoice; state.installPrompt = null;
      if (r.outcome === "accepted") $("#btnInstall").classList.add("hidden"); return; }
    alert("Tryk på Del-knappen (firkanten med pilen) i Safari og vælg «Føj til hjemmeskærm». Så ligger SkovPlan Felt som en app.");
  },
  photo: () => $("#photoInput").click(),
  edit: el => editReg(el.dataset.id),
  cancelForm: () => { const f = state.selected; f ? selectStand(f) : closeSheet(); },
};
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  if (el) { e.preventDefault(); $("#menu").classList.add("hidden"); ACTIONS[el.dataset.act]?.(el); return; }
  if (!e.target.closest("#menu, #btnMenu")) $("#menu").classList.add("hidden");
});
$("#btnMenu").onclick = () => { refreshMenuInfo(); $("#menu").classList.toggle("hidden"); };
$("#photoInput").onchange = e => { const f = e.target.files[0]; e.target.value = ""; if (f) takePhoto(f); };
$("#galleryInput").onchange = async e => { const fs = [...e.target.files]; e.target.value = ""; for (const f of fs) await takePhoto(f); };
$("#gpkgInput").onchange = async e => {
  const files = [...e.target.files]; e.target.value = ""; if (files.length) openFiles(files);
};
/* Åbn hvad som helst fra SkovPlan: en feltpakke (zip med kort + ortofoto), skovdriftsplan.gpkg eller ortofoto-mbtiles.
   Filtypen afgøres af indholdet, ikke navnet, så «skovdriftsplan (1).gpkg» fra Drev også virker. */
async function openFiles(files) {
  const items = [];
  for (const f of files) {
    try {
      const head = new Uint8Array(await f.slice(0, 16).arrayBuffer());
      if (head[0] === 0x50 && head[1] === 0x4b) {           // PK = zip
        toast("Pakker " + f.name + " ud …", 60000);
        const zip = await JSZip.loadAsync(f);
        let meta = null;
        const mj = zip.file(/feltpakke\.json$/i)[0];
        if (mj) try { meta = JSON.parse(await mj.async("string")); } catch (err) { /* ok */ }
        const fl = zip.file(/feltlag\.json$/i)[0];
        if (fl) try { meta = { ...(meta || {}), _extra: JSON.parse(await fl.async("string")) }; } catch (err) { console.warn("feltlag", err); }
        const inner = zip.file(/\.(gpkg|mbtiles)$/i);
        if (!inner.length) throw new Error(zip.file(/registreringer\.geojson$/i).length
          ? "det er en eksport fra appen. Den skal hentes ind i SkovPlan med «Hent data fra app»"
          : "zip-filen indeholder hverken skovkort eller ortofoto");
        for (const z of inner) items.push({ file: new File([await z.async("blob")], z.name.split("/").pop()), meta });
      } else if (new TextDecoder().decode(head).startsWith("SQLite format 3")) items.push({ file: f });
      else throw new Error("filen er hverken en feltpakke, et skovkort (.gpkg) eller et ortofoto (.mbtiles)");
    } catch (err) { console.error(err); toast("Kunne ikke åbne " + f.name + ": " + err.message, 7000); }
  }
  // skovkortet først, så ortofotoet kan zoome til skoven
  items.sort((a, b) => /\.mbtiles$/i.test(a.file.name) - /\.mbtiles$/i.test(b.file.name));
  for (const { file, meta } of items) {
    let g = null;
    try {
      toast("Læser " + file.name + " …", 60000);
      g = await openSqlite(file);
      if (hasTable(g, "tiles") && hasTable(g, "metadata")) await loadOrtho(g, file);
      else if (hasTable(g, "gpkg_contents")) await loadGpkg(g, file, meta);
      else throw new Error("ukendt filtype");
    } catch (err) { console.error(err); toast("Kunne ikke læse " + file.name + ": " + err.message, 7000); }
    finally { g?.close(); }
  }
  showWelcome();
}
/* Feltpakke online: SkovPlan lægger pakken i Supabase og giver et link …/?pakke=<adresse>. */
function onlinePackageUrl() {
  const c = state.data?.pakke?.sync;
  if (c?.rest && c?.noegle) return c.rest.replace(/\/rest\/v1\/?$/, "") + `/storage/v1/object/public/feltpakker/${c.noegle}/feltpakke.zip`;
  return safeLS("pakkeUrl");
}
function packageUrlFrom(text) {
  text = String(text || "").trim(); if (!text) return null;
  try { const u = new URL(text); const p = u.searchParams.get("pakke"); return p ? new URL(p).href : u.href; } catch (e) { return null; }
}
async function downloadPackage(url) {
  if (!url) return;
  if (!navigator.onLine) return toast("Telefonen har ikke net lige nu. Prøv igen, når den har.", 5000);
  try {
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error(res.status === 400 || res.status === 404 ? "pakken findes ikke (er linket rigtigt?)" : "HTTP " + res.status);
    const total = +res.headers.get("content-length") || 0, reader = res.body.getReader(), parts = []; let got = 0;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      parts.push(value); got += value.length;
      toast(`Henter feltpakken … ${total ? Math.round(got / total * 100) + " %" : Math.round(got / 1048576) + " MB"}`, 60000);
    }
    safeLS("pakkeUrl", url);
    await openFiles([new File(parts, "feltpakke.zip", { type: "application/zip" })]);
  } catch (err) { console.error(err); toast("Feltpakken kunne ikke hentes: " + err.message, 7000); }
}
/* Kunde med flere ejendomme: …/?kunde=<kunde.json>. Kunden vælger ejendom; én ad gangen ligger på telefonen. */
async function chooseProperty(url) {
  if (url) safeLS("kundeUrl", url);
  if (!safeLS("kundeUrl")) return askPackageLink();
  if (!navigator.onLine) toast("Telefonen har ikke net lige nu, så kun ejendomme på telefonen vises.", 5000);
  return propertySheet();
}
function askPackageLink() {
  const text = prompt("Indsæt linket, som du har fået fra SkovPlan:");
  try { const k = new URL(String(text || "").trim()).searchParams.get("kunde"); if (k) return chooseProperty(new URL(k).href); } catch (e) { /* ikke et kundelink */ }
  const url = packageUrlFrom(text);
  if (url) downloadPackage(url); else toast("Det ligner ikke et link fra SkovPlan");
}
async function loadGpkg(g, f, meta) {
  const data = readGpkg(g, f);
  if (meta) { const { _extra, ...pakke } = meta; data.pakke = pakke; if (_extra) data.extra = _extra; }
  data.id = propId(data);
  await db.put("kv", data, "skovkort:" + data.id);
  await activateProperty(data, await db.get("kv", "ortofoto:" + data.id));
  await rememberProperty(data);
  scheduleSync();
  toast(`Indlæst: ${data.layers.skovafdelinger.features.length} litradele`);
}
/* Læs ortofotoet (MBTiles fra SkovPlan) og læg fliserne i telefonens lager, så det virker uden net. */
async function loadOrtho(g, f) {
  {
    const meta = {};
    (g.exec("SELECT name, value FROM metadata")[0]?.values || []).forEach(([k, v]) => meta[k] = v);
    const total = g.exec("SELECT count(*) FROM tiles")[0].values[0][0];
    if (!total) throw new Error("filen har ingen fliser");
    const id = state.data?.id || "uden-skovkort", prefix = id + "|";
    await removeTiles(await db.get("kv", "ortofoto:" + id));
    const st = g.prepare("SELECT zoom_level, tile_column, tile_row, tile_data FROM tiles");
    const type = /png/i.test(meta.format || "") ? "image/png" : "image/jpeg";
    let batch = [], done = 0, minz = 99, maxz = 0;
    while (st.step()) {
      const [z, x, row, data] = st.get();
      minz = Math.min(minz, z); maxz = Math.max(maxz, z);
      batch.push([`${prefix}${z}/${x}/${(1 << z) - 1 - row}`, new Blob([data], { type })]);
      if (batch.length >= 300) { await db.putMany("tiles", batch); done += batch.length; batch = []; toast(`Gemmer ortofoto … ${Math.round(done / total * 100)} %`, 60000); }
    }
    st.free(); if (batch.length) await db.putMany("tiles", batch);
    state.ortho = { name: f.name, minzoom: minz, maxzoom: maxz, attribution: meta.attribution || "Ortofoto",
      bounds: meta.bounds ? meta.bounds.split(",").map(Number) : null, loaded: new Date().toISOString(), tiles: total, prefix };
    await db.put("kv", state.ortho, "ortofoto:" + id);
    if (state.data) await rememberProperty(state.data);
    setBasemap(0); restyle();
    if (!state.data && state.ortho.bounds) { const b = state.ortho.bounds; map.fitBounds([[b[1], b[0]], [b[3], b[2]]]); }
    toast(`Ortofoto gemt (${total} fliser) – virker uden net`, 4000);
  }
}
/* Velkomstkortet viser, hvad der mangler: skovkort og/eller ortofoto. */
function showWelcome(force) {
  const hasMap = !!state.data, hasOrtho = !!state.ortho;
  $("#stMap").className = hasMap ? "ok" : ""; $("#stMap").textContent = hasMap ? "Skovkort: " + state.data.name : "Skovkort mangler";
  $("#stOrtho").className = hasOrtho ? "ok" : ""; $("#stOrtho").textContent = hasOrtho ? "Ortofoto gemt" : "Ortofoto mangler";
  $("#welcomeClose").classList.toggle("hidden", !hasMap);
  $("#empty").classList.toggle("hidden", !force && hasMap && hasOrtho || !force && hasMap && safeLS("skipOrtho") === "1");
}
function fitData() { try { map.fitBounds(L.geoJSON(state.data.layers.skovafdelinger).getBounds(), { padding: [20, 20] }); } catch (e) { /* tom */ } }


/* ------------------------------------------------------------------ «Gå til»: kompas, afstand og linje på kortet */
let navLine = null, navMarker = null, heading = null;
const toRad = d => d * Math.PI / 180;
function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const compassName = b => ["N", "NØ", "Ø", "SØ", "S", "SV", "V", "NV"][Math.round(b / 45) % 8];
const fmtLen = m => m >= 1000 ? fmt(m / 1000, m < 10000 ? 2 : 1) + " km" : Math.round(m || 0) + " m";
/* Et punkt inde i litraet (midten af den største del, hvis midten ligger udenfor: et punkt i polygonen). */
function standTarget(f) {
  const layer = L.geoJSON(f), parts = [];
  layer.eachLayer(l => parts.push(l));
  let best = parts[0], area = 0;
  for (const l of parts) { const b = l.getBounds(), a = (b.getNorth() - b.getSouth()) * (b.getEast() - b.getWest()); if (a > area) { area = a; best = l; } }
  const c = best.getBounds().getCenter();
  if (standAt(c.lng, c.lat)?.properties === f.properties) return c;
  const ring = best.getLatLngs().flat(3); return ring.length ? L.latLngBounds(ring.slice(0, 3)).getCenter() : c;
}
async function goTo(lat, lon, label) {
  state.nav = { lat, lon, label };
  try {   // iPhone kræver tilladelse til kompasset
    if (typeof DeviceOrientationEvent !== "undefined" && DeviceOrientationEvent.requestPermission) await DeviceOrientationEvent.requestPermission();
  } catch (e) { /* uden kompas */ }
  startCompass();
  if (navMarker) map.removeLayer(navMarker);
  navMarker = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="nav-target"></div>', iconSize: [22, 22] }) }).addTo(map);
  $("#navbar").classList.remove("hidden"); $("#navLabel").textContent = label || "Punkt";
  if (state.me) map.fitBounds(L.latLngBounds([[lat, lon], [state.me.lat, state.me.lon]]).pad(0.3), { maxZoom: 18 });
  else map.setView([lat, lon], Math.max(map.getZoom(), 16));
  follow = false; updateNav();
}
function stopNav() {
  state.nav = null; $("#navbar").classList.add("hidden");
  for (const l of [navLine, navMarker]) if (l) map.removeLayer(l);
  navLine = navMarker = null;
}
let compassOn = false;
function startCompass() {
  if (compassOn) return; compassOn = true;
  const on = e => {
    let h = null;
    if (typeof e.webkitCompassHeading === "number") h = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === "number") h = 360 - e.alpha;
    if (h === null) return;
    heading = (h + (screen.orientation?.angle || 0) + 360) % 360; updateNav();
  };
  if ("ondeviceorientationabsolute" in window) window.addEventListener("deviceorientationabsolute", on);
  else window.addEventListener("deviceorientation", on);
}
function updateNav() {
  const n = state.nav; if (!n) return;
  if (!state.me) { $("#navDist").textContent = "Venter på GPS …"; return; }
  const me = L.latLng(state.me.lat, state.me.lon), to = L.latLng(n.lat, n.lon);
  const d = map.distance(me, to), b = bearing(me, to);
  if (navLine) navLine.setLatLngs([me, to]);
  else navLine = L.polyline([me, to], { color: "#1a73e8", weight: 3, dashArray: "6 6", interactive: false }).addTo(map);
  const here = d <= Math.max(5, state.me.accuracy || 0);
  $("#navDist").textContent = here ? "Du er fremme" : `${fmtLen(d)} mod ${compassName(b)}`;
  $("#navArrow").style.transform = `rotate(${heading === null ? b : b - heading}deg)`;
  $("#navArrow").classList.toggle("here", here);
  $("#navHint").textContent = heading === null ? "Pilen peger i forhold til kortet (nord op)" : "Pilen peger, hvor du skal gå";
}
$("#navStop").onclick = stopNav;
map.on("contextmenu", e => {
  L.popup().setLatLng(e.latlng).setContent('<button class="primary" id="goHere">➜ Gå hertil</button>').openOn(map);
  setTimeout(() => { const b = document.getElementById("goHere"); if (b) b.onclick = () => { map.closePopup(); goTo(e.latlng.lat, e.latlng.lng, "Punkt på kortet"); }; }, 0);
});

/* ------------------------------------------------------------------ spor: optag den rute, der er gået
   Punkter gemmes, når GPS'en er god nok (±25 m) og man har flyttet sig 5 m. Undervejs gemmes sporet i kv «spor-igang»,
   så det ikke går tabt, hvis appen lukkes. Skærmen holdes tændt (wake lock), fordi telefonen ellers stopper GPS'en. */
let trackLine = null, wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { /* ikke understøttet */ }
}
document.addEventListener("visibilitychange", () => { if (state.track && document.visibilityState === "visible") keepAwake(true); });
function trackLength(pts) { let m = 0; for (let i = 1; i < pts.length; i++) m += map.distance(pts[i - 1], pts[i]); return m; }
function drawTrack() {
  const pts = state.track?.points.map(p => [p[0], p[1]]) || [];
  if (!state.track) { if (trackLine) map.removeLayer(trackLine); trackLine = null; }
  else if (trackLine) trackLine.setLatLngs(pts);
  else trackLine = L.polyline(pts, { color: "#e8710a", weight: 4, opacity: 0.9, interactive: false }).addTo(map);
  const b = $("#btnTrack");
  if (b) b.textContent = state.track ? `■ Stop ruten (${fmtLen(trackLength(pts))})` : "● Optag ruten, jeg går";
  $("#trackDot").classList.toggle("hidden", !state.track);
}
function trackPoint(lat, lon, acc, t) {
  const tr = state.track; if (!tr || acc > 25) return;
  const last = tr.points[tr.points.length - 1];
  if (last && map.distance([last[0], last[1]], [lat, lon]) < 5) return;
  tr.points.push([+lat.toFixed(6), +lon.toFixed(6), Math.round((t || Date.now()) / 1000)]);
  db.put("kv", tr, "spor-igang").catch(() => {});
  drawTrack();
}
/* Påmindelse på ruten: går du ind i et bevokset litra uden målinger i år (prøveflade, relaskop eller taksation), siger appen til
   én gang pr. litra pr. rute. Litraet skal være det samme i to GPS-målinger i træk, så det ikke blinker ved skellet. */
const MEASURE_TYPES = ["proeveflade", "vinkel", "taksation"];
const isForestStand = p => !!p["træart"] && !NOT_TREE.test(p["træart"]);
const standMeasured = key => state.regs.some(r => r.stand?.key === key && MEASURE_TYPES.includes(r.type) && String(r.created).startsWith(String(YEAR)));
function unmeasuredStands() {
  const keys = new Set();
  for (const f of state.data?.layers.skovafdelinger.features || []) { const k = standKey(f.properties); if (isForestStand(f.properties) && !standMeasured(k)) keys.add(k); }
  return keys;
}
function hideRemind() { $("#remind").classList.add("hidden"); }
function remindStand(lat, lon, acc) {
  const tr = state.track; if (!tr || !state.data || acc > 25) return;
  const f = standAt(lon, lat), key = f ? standKey(f.properties) : null;
  if (key !== remindStand.cand) { remindStand.cand = key; return; }
  if (key === remindStand.last) return; remindStand.last = key;
  if (!f || !isForestStand(f.properties) || standMeasured(key)) return hideRemind();
  tr.reminded = tr.reminded || [];
  if (tr.reminded.includes(key)) return; tr.reminded.push(key);
  const left = unmeasuredStands().size;
  $("#remindTxt").innerHTML = `<b>${esc(standLabel(f.properties))}${f.properties["træart"] ? " · " + esc(f.properties["træart"]) : ""}</b> har ingen målinger i år.`
    + `<br><span class="small">${left === 1 ? "Det er det sidste litra uden målinger." : `${left} litraer mangler stadig.`}</span>`;
  $("#remind").classList.remove("hidden");
  $("#remindGo").onclick = () => { hideRemind(); selectStand(f); };
  if (navigator.vibrate) navigator.vibrate([120, 80, 120]);
  clearTimeout(remindStand.t); remindStand.t = setTimeout(hideRemind, 30000);
}
$("#remindX").onclick = hideRemind;
async function toggleTrack() {
  if (!state.track) {
    state.track = { id: uid(), start: new Date().toISOString(), ejendom: state.data?.name || null, points: [] };
    await db.put("kv", state.track, "spor-igang"); keepAwake(true); drawTrack();
    if (state.me) trackPoint(state.me.lat, state.me.lon, state.me.accuracy, Date.now());
    remindStand.cand = remindStand.last = undefined;
    const left = unmeasuredStands().size;
    return toast("Ruten optages. Hold appen åben, så GPS'en kører." + (left ? ` Appen siger til, når du går ind i et af de ${left} litraer uden målinger i år.` : ""), 6000);
  }
  const tr = state.track; state.track = null; keepAwake(false); drawTrack(); await db.del("kv", "spor-igang"); hideRemind();
  if (tr.points.length < 2) return toast("Ruten var for kort til at blive gemt");
  const len = trackLength(tr.points.map(p => [p[0], p[1]]));
  const reg = { id: tr.id, type: "spor", created: tr.start, lat: tr.points[0][0], lon: tr.points[0][1], stand: null, ejendom: tr.ejendom,
    data: { points: tr.points, length_m: Math.round(len), minutes: (tr.points[tr.points.length - 1][2] - tr.points[0][2]) / 60, note: "" } };
  await saveReg(reg); trackForm({ ...reg, data: { ...reg.data } });
}
function trackForm(reg) {
  openSheet(`<div class="head"><h3>Rute · ${fmtLen(reg.data.length_m)}</h3><button class="close">Luk</button></div>
    <p class="muted">${new Date(reg.created).toLocaleString("da-DK", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} ·
      ${Math.round(reg.data.minutes || 0)} min · ${reg.data.points.length} punkter</p>
    <label>Note til ruten</label><textarea id="sNote">${esc(reg.data.note || "")}</textarea>
    <div class="stack"><button class="primary big" id="sSave">Gem</button><button class="danger" id="sDel">Slet ruten</button></div>`);
  map.fitBounds(L.latLngBounds(reg.data.points.map(p => [p[0], p[1]])).pad(0.2));
  $("#sSave").onclick = async () => { reg.data.note = $("#sNote").value.trim(); await saveReg(reg); closeSheet(); toast("Ruten er gemt"); };
  $("#sDel").onclick = () => deleteReg(reg);
}

/* ------------------------------------------------------------------ flere ejendomme på telefonen
   Hver ejendom gemmes for sig: kv «skovkort:<id>», kv «ortofoto:<id>» og fliser med nøglen «<id>|z/x/y».
   kv «ejendomme» er listen, kv «aktiv» er den viste. Registreringerne har ejendommens navn (reg.ejendom). */
const propId = d => d.pakke?.sync?.noegle || "navn:" + (d.name || "skov");
async function removeTiles(ortho) {
  if (!ortho) return;
  if (ortho.prefix) return db.delPrefix("tiles", ortho.prefix);
  const keys = await db.keys("tiles");               // ældre version: fliser uden ejendom foran
  await db.tx("tiles", "readwrite", s => { for (const k of keys) if (/^\d+\/\d+\/\d+$/.test(k)) s.delete(k); });
}
async function propertyList() { return (await db.get("kv", "ejendomme")) || []; }
async function rememberProperty(d) {
  const list = (await propertyList()).filter(p => p.id !== d.id);
  const o = await db.get("kv", "ortofoto:" + d.id);
  list.push({ id: d.id, name: d.name, kunde: d.pakke?.kunde || null, loaded: d.loaded, ortho: !!o, tiles: o?.tiles || 0, url: onlinePackageUrlFor(d) });
  list.sort((a, b) => a.name.localeCompare(b.name, "da"));
  await db.put("kv", list, "ejendomme");
}
function onlinePackageUrlFor(d) {
  const c = d?.pakke?.sync;
  return c?.rest && c?.noegle ? c.rest.replace(/\/rest\/v1\/?$/, "") + `/storage/v1/object/public/feltpakker/${c.noegle}/feltpakke.zip` : null;
}
async function activateProperty(d, ortho) {
  state.data = d; state.ortho = ortho || null; state.selected = null;
  await db.put("kv", d.id, "aktiv");
  state.regs = regsFor(d); state.syncHash = syncCfg() ? safeLS("syncHash:" + syncCfg().noegle) : null;
  drawData(); fitData(); setBasemap(state.ortho ? 0 : (state.basemap || 1)); drawRegMarkers(); restyle(); refreshMenuInfo();
}
async function switchProperty(id) {
  if (state.data?.id === id) return closeSheet();
  if (syncCfg() && state.regs.some(r => !r.synced)) { try { await syncNow(false); } catch (e) { /* sendes senere */ } }
  const d = await db.get("kv", "skovkort:" + id);
  if (!d) return toast("Ejendommen findes ikke længere på telefonen");
  closeSheet(); await activateProperty(d, await db.get("kv", "ortofoto:" + id)); toast(d.name);
}
async function removeProperty(id) {
  const p = (await propertyList()).find(x => x.id === id); if (!p) return;
  const waiting = state.allRegs.filter(r => r.ejendom === p.name && !r.synced && !r.exported).length;
  if (!confirm(`Fjern ${p.name} fra telefonen?` + (waiting ? `\n\n${waiting} registreringer er ikke sendt endnu og bliver også slettet.` : ""))) return;
  await removeTiles(await db.get("kv", "ortofoto:" + id));
  await db.del("kv", "skovkort:" + id); await db.del("kv", "ortofoto:" + id);
  for (const r of state.allRegs.filter(r => r.ejendom === p.name)) await db.del("regs", r.id);
  dropRegs(r => r.ejendom === p.name);
  await db.put("kv", (await propertyList()).filter(x => x.id !== id), "ejendomme");
  if (state.data?.id === id) {
    const next = (await propertyList())[0];
    if (next) await switchProperty(next.id); else { state.data = null; state.ortho = null; state.regs = []; drawData(); setBasemap(1); await db.del("kv", "aktiv"); showWelcome(true); }
  }
  propertySheet();
}
/* Gamle versioner havde én ejendom i kv «skovkort»/«ortofoto». */
async function migrateSingle() {
  const old = await db.get("kv", "skovkort"); if (!old) return;
  old.id = propId(old);
  await db.put("kv", old, "skovkort:" + old.id);
  const o = await db.get("kv", "ortofoto"); if (o) await db.put("kv", { ...o, prefix: "" }, "ortofoto:" + old.id);
  await db.put("kv", old.id, "aktiv"); await rememberProperty(old);
  await db.del("kv", "skovkort"); await db.del("kv", "ortofoto");
}
async function propertySheet() {
  const list = await propertyList();
  let customer = null;
  const url = safeLS("kundeUrl");
  if (url && navigator.onLine) {
    try { const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(), { cache: "no-store" }); if (res.ok) customer = await res.json(); } catch (e) { /* uden net */ }
  }
  const local = new Set(list.map(p => p.name));
  const remote = (customer?.ejendomme || []).filter(e => !local.has(e.navn));
  const mb = n => n ? ` · ortofoto` : " · uden ortofoto";
  $("#empty").classList.add("hidden");
  openSheet(`<div class="head"><h3>Ejendomme</h3><button class="close">Luk</button></div>
    ${list.length ? `<p class="muted">På telefonen (virker uden net):</p><ul class="list">${list.map(p => `<li><div class="grow"><b>${esc(p.name)}</b>
      <br><span class="muted">${p.id === state.data?.id ? "vises nu" : "hentet " + new Date(p.loaded).toLocaleDateString("da-DK")}${mb(p.ortho)}</span></div>
      ${p.id === state.data?.id ? "" : `<button class="primary" data-open="${esc(p.id)}">Åbn</button>`}
      ${p.url ? `<button data-update="${esc(p.id)}" title="Hent nyeste version">↻</button>` : ""}
      <button class="danger" data-remove="${esc(p.id)}" title="Fjern fra telefonen">✕</button></li>`).join("")}</ul>` : ""}
    ${remote.length ? `<p class="muted">${esc(customer.kunde || "Flere ejendomme")} – kan hentes:</p><ul class="list">${remote.map((e, i) => `<li><div class="grow"><b>${esc(e.navn)}</b></div>
      <button class="primary" data-get="${i}">Hent</button></li>`).join("")}</ul>` : ""}
    ${url && !customer ? `<p class="muted">Kundens øvrige ejendomme vises, når telefonen har net.</p>` : ""}
    <button class="big" data-act="packageLink">Indsæt link fra SkovPlan</button>
    <button class="big" data-act="openGpkg">Vælg feltpakke-fil</button>`);
  sheet.querySelectorAll("[data-open]").forEach(b => b.onclick = () => switchProperty(b.dataset.open));
  sheet.querySelectorAll("[data-remove]").forEach(b => b.onclick = () => removeProperty(b.dataset.remove));
  sheet.querySelectorAll("[data-update]").forEach(b => b.onclick = () => { const p = list.find(x => x.id === b.dataset.update); closeSheet(); downloadPackage(p.url); });
  sheet.querySelectorAll("[data-get]").forEach(b => b.onclick = async () => {
    const e = remote[+b.dataset.get]; closeSheet();
    if (syncCfg() && state.regs.some(r => !r.synced)) { try { await syncNow(false); } catch (err) { /* sendes senere */ } }
    downloadPackage(e.url);
  });
}

/* ------------------------------------------------------------------ start */
/* ------------------------------------------------------------------ skovkortet opdaterer sig selv
   SkovPlan lægger en lille skovkort.zip og version.json i ejendommens mappe online, når planen ændres.
   Appen kigger efter ved start, når den kommer frem igen, når nettet kommer, og hvert 10. minut.
   Kun skovkortet hentes automatisk (lille); et nyt ortofoto er stort, så appen siger det bare. */
const storageBase = d => { const c = d?.pakke?.sync; return c?.rest && c?.noegle ? c.rest.replace(/\/rest\/v1\/?$/, "") + `/storage/v1/object/public/feltpakker/${c.noegle}/` : null; };
let checkingMaps = false;
async function checkMapUpdates() {
  if (checkingMaps || !navigator.onLine) return; checkingMaps = true;
  try {
    for (const p of await propertyList()) {
      const d = await db.get("kv", "skovkort:" + p.id), base = storageBase(d); if (!base) continue;
      let v; try { const r = await fetch(base + "version.json?t=" + Date.now(), { cache: "no-store" }); if (!r.ok) continue; v = await r.json(); } catch (e) { continue; }
      if (v.kort && v.kort > (d.pakke.kort_version || d.pakke.lavet || "")) {
        if (d.id === state.data?.id && !sheet.classList.contains("hidden")) continue;   // ikke midt i en formular; næste gang
        try { await updateMap(d, base, v.kort); } catch (e) { console.warn("skovkort", e); }
      }
      const o = await db.get("kv", "ortofoto:" + d.id);
      if (v.ortho && o && (o.loaded || "") < v.ortho && safeLS("orthoNote:" + d.id) !== v.ortho) {
        safeLS("orthoNote:" + d.id, v.ortho);
        toast(`Der er et nyt ortofoto til ${d.name}. Hent det under ☰ › «Hent nyeste feltpakke», gerne på wifi.`, 7000);
      }
    }
  } finally { checkingMaps = false; }
}
async function updateMap(d, base, version) {
  const res = await fetch(base + "skovkort.zip?t=" + Date.now(), { cache: "no-store" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const zip = await JSZip.loadAsync(await res.blob());
  const meta = JSON.parse(await zip.file("feltpakke.json").async("string"));
  const fl = zip.file("feltlag.json"), extra = fl ? JSON.parse(await fl.async("string")) : d.extra;
  const file = new File([await zip.file("skovdriftsplan.gpkg").async("blob")], "skovdriftsplan.gpkg");
  const g = await openSqlite(file);
  let data; try { data = readGpkg(g, file); } finally { g.close(); }
  data.pakke = { ...d.pakke, ...meta, kort_version: meta.kort_version || version }; data.extra = extra; data.id = propId(data);
  if (data.id !== d.id) return;
  await db.put("kv", data, "skovkort:" + data.id);
  if (state.data?.id === data.id) {           // den viste ejendom: tegn kortet igen uden at flytte udsnittet
    state.data = data; state.regs = regsFor(data); state.selected = null;
    drawData(); drawRegMarkers(); restyle(); refreshMenuInfo();
  }
  await rememberProperty(data);
  toast(`Skovkortet for ${data.name} er opdateret fra SkovPlan`, 4000);
}

(async function start() {
  try { await navigator.storage?.persist?.(); } catch (e) { /* ok */ }
  try {
    await migrateSingle();
    state.allRegs = await db.all("regs");
    const aktiv = await db.get("kv", "aktiv");
    if (aktiv) { state.data = await db.get("kv", "skovkort:" + aktiv); state.ortho = await db.get("kv", "ortofoto:" + aktiv); }
    state.regs = regsFor(state.data);
    const running = await db.get("kv", "spor-igang");
    if (running) { state.track = running; keepAwake(true); setTimeout(() => { drawTrack(); toast("Ruten optages stadig", 4000); }, 500); }
  } catch (e) { console.error(e); toast("Telefonens lager kunne ikke åbnes: " + e.message, 6000); }
  const saved = safeLS("basemap"); setBasemap(saved === null ? 0 : +saved % BASEMAPS.length);
  if (state.data) { drawData(); fitData(); }
  showWelcome();
  drawRegMarkers(); startGps();
  const params = new URLSearchParams(location.search);
  const linked = packageUrlFrom(params.get("pakke") ? location.href : "");
  let customer = null; try { customer = params.get("kunde") ? new URL(params.get("kunde")).href : null; } catch (e) { /* ugyldigt */ }
  if (linked || customer) history.replaceState(null, "", location.pathname);
  if (customer) chooseProperty(customer); else if (linked) downloadPackage(linked);
  if (syncCfg()) { state.syncHash = safeLS("syncHash:" + syncCfg().noegle); scheduleSync(); }
  setTimeout(checkMapUpdates, 4000); setInterval(checkMapUpdates, 10 * 60 * 1000);
  window.addEventListener("online", () => checkMapUpdates());
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkMapUpdates(); });
  // Installér som app (Android/Chrome viser sin egen dialog; iPhone: Del › Føj til hjemmeskærm)
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); state.installPrompt = e; $("#btnInstall")?.classList.remove("hidden"); });
  if (!standalone && /iPhone|iPad/.test(navigator.userAgent)) $("#btnInstall")?.classList.remove("hidden");
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then(r => r.update()).catch(e => console.warn("SW", e));
    // Ny version installeret: genindlæs, når der ikke står en formular åben; ellers sig det.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!had) return;
      if (sheet.classList.contains("hidden")) location.reload(); else toast("Ny version af appen er klar. Luk og åbn appen for at få den.", 6000);
    });
  }
})();
