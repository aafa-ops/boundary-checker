const DATA = "data/";
const FULL_COLOUR = "#2f9e44";
const SPLIT_COLOUR = "#e8590c";

const state = {
  districtsFC: null,        // GeoJSON FeatureCollection of districts (also used for point-in-polygon)
  unitLayerGroup: null,     // current Leaflet layer for postcodes/suburbs/lgas
  unitLayerKind: "none",    // which kind is currently shown
  unitLayerIndex: {},       // id -> leaflet layer, for the currently shown unit layer (click-to-locate)
  unitCache: {},            // cache of loaded+converted unit GeoJSON by type
  lookup: {},               // postcodes/suburbs/lgas lookup JSON, loaded on demand
  crosswalk: null,
  boundaryWeight: 2.5,
  partyOpacity: 0.55,
};

const LABEL_ZOOM = { postcodes: 10, suburbs: 12, lgas: 8 };

const map = L.map("map", { zoomControl: true }).setView([-36.9, 144.4], 7);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

async function fetchJSON(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`Failed to load ${url}`);
  return r.json();
}

async function fetchTopoAsGeoJSON(path) {
  const topo = await fetchJSON(DATA + path);
  return topojson.feature(topo, topo.objects.data);
}

function districtPopupHTML(props) {
  const margin = props.margin_pct_points != null ? `${props.margin_pct_points}%` : "n/a";
  return `
    <h3>${props.district_label}</h3>
    <div>${props.region_label || ""}</div>
    <table>
      <tr><td><b>Member</b></td><td>${props.member}</td></tr>
      <tr><td><b>Party</b></td><td><span class="swatch" style="background:${props.party_colour};display:inline-block;width:10px;height:10px;border-radius:2px;"></span> ${props.party}</td></tr>
      <tr><td><b>Margin</b></td><td>${margin} (2022, over ${props.runner_up_party || "runner-up"})</td></tr>
    </table>`;
}

function unitPopupHTML(name, kindLabel, props) {
  const badge = props.is_split
    ? `<span class="status-badge status-split">Split</span>`
    : `<span class="status-badge status-full">Fully within one district</span>`;
  return `<h3>${name}</h3>${badge}<div>${kindLabel} — primary district: <b>${props.primary_district}</b> (${props.primary_pct}%)</div>
    <div style="margin-top:4px;font-size:12px;color:#666;">${props.district_count} district${props.district_count === 1 ? "" : "s"} touched.</div>`;
}

async function loadBoundary() {
  const fc = await fetchTopoAsGeoJSON("vic_boundary.topojson");
  L.geoJSON(fc, {
    style: { color: "#1c596e", weight: 2, dashArray: "4 3", fill: false },
    interactive: false,
  }).addTo(map);
}

async function loadDistricts() {
  const fc = await fetchTopoAsGeoJSON("vic_districts.topojson");
  state.districtsFC = fc;
  const layer = L.geoJSON(fc, {
    style: (f) => ({
      color: "#444",
      weight: state.boundaryWeight,
      fillColor: f.properties.party_colour,
      fillOpacity: state.partyOpacity,
    }),
    onEachFeature: (f, l) => l.bindPopup(districtPopupHTML(f.properties)),
  });
  state.districtsLayer = layer;
  layer.addTo(map);
  buildPartyLegend(fc);
}

function applyBoundaryWeight(weight) {
  state.boundaryWeight = weight;
  if (state.districtsLayer) state.districtsLayer.setStyle({ weight });
  if (state.unitLayerGroup) state.unitLayerGroup.setStyle({ weight: weight + 0.5 });
}

function applyPartyOpacity(opacity) {
  state.partyOpacity = opacity;
  if (state.districtsLayer) state.districtsLayer.setStyle({ fillOpacity: opacity });
}

function buildPartyLegend(fc) {
  const seen = new Map();
  fc.features.forEach((f) => {
    if (!seen.has(f.properties.party)) seen.set(f.properties.party, f.properties.party_colour);
  });
  const el = document.getElementById("party-legend");
  el.innerHTML = "";
  for (const [party, colour] of seen) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<span class="swatch" style="background:${colour}"></span> ${party}`;
    el.appendChild(row);
  }
}

const UNIT_CONFIG = {
  postcodes: { file: "vic_postcodes.topojson", idProp: "POA_CODE21", nameProp: "POA_NAME21", label: "Postcode" },
  suburbs: { file: "vic_suburbs.topojson", idProp: "SAL_CODE21", nameProp: "SAL_NAME21", label: "Suburb" },
  lgas: { file: "vic_lgas.topojson", idProp: "LGA_CODE25", nameProp: "LGA_NAME25", label: "LGA" },
};

async function setUnitLayer(kind) {
  if (state.unitLayerGroup) {
    map.removeLayer(state.unitLayerGroup);
    state.unitLayerGroup = null;
  }
  state.unitLayerKind = kind;
  state.unitLayerIndex = {};
  if (kind === "none") return;

  const cfg = UNIT_CONFIG[kind];
  if (!state.unitCache[kind]) {
    state.unitCache[kind] = await fetchTopoAsGeoJSON(cfg.file);
  }
  const fc = state.unitCache[kind];
  const layer = L.geoJSON(fc, {
    style: (f) => ({
      color: f.properties.is_split ? SPLIT_COLOUR : FULL_COLOUR,
      weight: state.boundaryWeight + 0.5,
      fill: false,
    }),
    onEachFeature: (f, l) => {
      const name = f.properties[cfg.nameProp];
      l.bindPopup(unitPopupHTML(name, cfg.label, f.properties));
      l.bindTooltip(name, { permanent: true, direction: "center", className: "unit-label" });
      l.closeTooltip();
      state.unitLayerIndex[f.properties[cfg.idProp]] = l;
    },
  });
  state.unitLayerGroup = layer;
  layer.addTo(map);
  updateLabelVisibility();
}

function updateLabelVisibility() {
  const kind = state.unitLayerKind;
  if (!state.unitLayerGroup || kind === "none") return;
  const shouldShow = map.getZoom() >= LABEL_ZOOM[kind];
  state.unitLayerGroup.eachLayer((l) => {
    if (shouldShow) l.openTooltip();
    else l.closeTooltip();
  });
}
map.on("zoomend", updateLabelVisibility);

document.querySelectorAll('input[name="unit-layer"]').forEach((radio) => {
  radio.addEventListener("change", (e) => setUnitLayer(e.target.value));
});
document.getElementById("slider-boundary").addEventListener("input", (e) => applyBoundaryWeight(parseFloat(e.target.value)));
document.getElementById("slider-party").addEventListener("input", (e) => applyPartyOpacity(parseFloat(e.target.value)));

// ---------- Splits table ----------
const SPLITS_CONFIG = {
  postcodes: { lookupFile: "lookup_postcodes.json" },
  suburbs: { lookupFile: "lookup_suburbs.json" },
  lgas: { lookupFile: "lookup_lgas.json" },
};

async function getLookup(kind) {
  if (!state.lookup[kind]) {
    state.lookup[kind] = await fetchJSON(DATA + SPLITS_CONFIG[kind].lookupFile);
  }
  return state.lookup[kind];
}

async function renderSplitTable(kind, filterText) {
  const lookup = await getLookup(kind);
  const tbody = document.querySelector("#split-table tbody");
  tbody.innerHTML = "";
  const rows = [];
  for (const unitId in lookup) {
    const entry = lookup[unitId];
    if (!entry.is_split) continue;
    if (filterText && !entry.name.toLowerCase().includes(filterText.toLowerCase())) continue;
    for (const d of entry.districts) {
      rows.push({ unitId, name: entry.name, ...d });
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || b.pct_area - a.pct_area);
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" id="split-table-empty">No matches.</td></tr>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const r of rows.slice(0, 1000)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.name}</td><td>${r.district_label}</td><td>${r.member}</td><td>${r.party}</td><td>${r.pct_area}%</td>`;
    tr.addEventListener("click", () => locateUnitOnMap(kind, r.unitId));
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);
}

async function locateUnitOnMap(kind, unitId) {
  const radio = document.querySelector(`input[name="unit-layer"][value="${kind}"]`);
  if (radio && !radio.checked) {
    radio.checked = true;
    await setUnitLayer(kind);
  } else if (!state.unitLayerGroup || state.unitLayerKind !== kind) {
    await setUnitLayer(kind);
  }
  const target = state.unitLayerIndex[unitId];
  if (!target) return;
  map.fitBounds(target.getBounds(), { maxZoom: Math.max(map.getZoom(), LABEL_ZOOM[kind] + 1) });
  target.openPopup();
}

let currentSplitKind = "postcodes";
document.querySelectorAll('input[name="split-type"]').forEach((radio) => {
  radio.addEventListener("change", (e) => {
    currentSplitKind = e.target.value;
    renderSplitTable(currentSplitKind, document.getElementById("split-search").value);
  });
});
document.getElementById("split-search").addEventListener("input", (e) => {
  renderSplitTable(currentSplitKind, e.target.value);
});

// ---------- Lookup panel: postcode -> suburb -> address ----------
function districtRowHTML(d) {
  const margin = d.margin_pct_points != null ? `${d.margin_pct_points}%` : "n/a";
  return `<div class="district-row">
    <span><span class="swatch" style="background:${d.party_colour}"></span>${d.district_label}</span>
    <span>${d.pct_area}%</span>
  </div>
  <div style="font-size:12px;color:#555;margin:-4px 0 6px 16px;">${d.member} (${d.party}), margin ${margin}</div>`;
}

async function handlePostcodeInput(value) {
  const el = document.getElementById("lookup-result");
  const code = value.trim();
  if (!/^\d{4}$/.test(code)) {
    el.innerHTML = code ? `<div class="hint">Enter a 4-digit VIC postcode (3xxx).</div>` : "";
    return;
  }
  const lookup = await getLookup("postcodes");
  const entry = lookup[code];
  if (!entry) {
    el.innerHTML = `<div class="hint">No VIC postcode "${code}" found in this dataset.</div>`;
    return;
  }

  let html = entry.is_split
    ? `<span class="status-badge status-split">Split across ${entry.district_count} districts</span>`
    : `<span class="status-badge status-full">Fully within one district</span>`;
  html += entry.districts.map(districtRowHTML).join("");

  if (entry.is_split) {
    const crosswalk = state.crosswalk || (state.crosswalk = await fetchJSON(DATA + "crosswalk_postcode_suburbs.json"));
    const suburbs = crosswalk[code] || [];
    if (suburbs.length > 1) {
      html += `<div class="hint">Postcode ${code} spans multiple suburbs — pick yours for a more precise answer:</div>`;
      html += `<select id="suburb-select"><option value="">Select suburb...</option>${suburbs
        .map((s) => `<option value="${s.sal_code}">${s.suburb}</option>`)
        .join("")}</select>`;
    }
  }
  el.innerHTML = html;

  const select = document.getElementById("suburb-select");
  if (select) select.addEventListener("change", (e) => handleSuburbSelect(e.target.value, code));
}

async function handleSuburbSelect(salCode, postcode) {
  const el = document.getElementById("lookup-result");
  if (!salCode) return;
  const lookup = await getLookup("suburbs");
  const entry = lookup[salCode];
  if (!entry) return;

  let html = entry.is_split
    ? `<span class="status-badge status-split">${entry.name} is itself split across ${entry.district_count} districts</span>`
    : `<span class="status-badge status-full">${entry.name} is fully within one district</span>`;
  html += entry.districts.map(districtRowHTML).join("");

  if (entry.is_split) {
    html += `<div class="hint">Still not certain — enter your street address for an exact, point-level match:</div>
      <input id="address-input" type="text" placeholder="e.g. 12 Smith St, ${entry.name}, VIC">
      <button id="address-btn">Find my district</button>
      <div class="attribution">Address search via OpenStreetMap Nominatim.</div>
      <div id="address-result"></div>`;
  }
  el.insertAdjacentHTML("beforeend", `<div id="suburb-result-extra"></div>`);
  document.getElementById("suburb-result-extra").innerHTML = html;

  const btn = document.getElementById("address-btn");
  if (btn) btn.addEventListener("click", () => geocodeAndMatch());
}

let geocodeInFlight = false;
async function geocodeAndMatch() {
  const btn = document.getElementById("address-btn");
  const input = document.getElementById("address-input");
  const resultEl = document.getElementById("address-result");
  if (geocodeInFlight || !input.value.trim()) return;
  geocodeInFlight = true;
  btn.disabled = true;
  btn.textContent = "Searching...";
  resultEl.innerHTML = "";
  try {
    const q = encodeURIComponent(`${input.value}, Victoria, Australia`);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${q}&countrycodes=au&limit=1`;
    const results = await fetchJSON(url);
    if (!results.length) {
      resultEl.innerHTML = `<div class="hint">Address not found — try adding a suburb or postcode.</div>`;
      return;
    }
    const { lat, lon } = results[0];
    const pt = turf.point([parseFloat(lon), parseFloat(lat)]);
    const match = state.districtsFC.features.find((f) => {
      try {
        return turf.booleanPointInPolygon(pt, f);
      } catch {
        return false;
      }
    });
    if (match) {
      resultEl.innerHTML = `<div class="exact-match">Exact match: <b>${match.properties.district_label}</b><br>${match.properties.member} (${match.properties.party})</div>`;
    } else {
      resultEl.innerHTML = `<div class="hint">That point didn't fall inside any VIC district — check the address.</div>`;
    }
  } catch (err) {
    resultEl.innerHTML = `<div class="hint">Lookup failed: ${err.message}</div>`;
  } finally {
    geocodeInFlight = false;
    btn.disabled = false;
    btn.textContent = "Find my district";
  }
}

document.getElementById("postcode-input").addEventListener("input", (e) => handlePostcodeInput(e.target.value));

// ---------- Init ----------
(async function init() {
  await loadBoundary();
  await loadDistricts();
  await renderSplitTable(currentSplitKind, "");
})();
