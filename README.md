# VIC electorate vs postcode/suburb/LGA boundary checker

Internal demo for the Australian Alliance for Animals. Shows where Victorian
postcodes, suburbs and LGAs sit fully inside one state electoral district
versus split across several, with the current member/party/margin for each
district, a postcode → suburb → address lookup, and a searchable list of
every split.

**Live site:** https://aafa-ops.github.io/boundary-checker/

## Repo layout

```
scripts/01_process_vic.py   the whole data pipeline (raw files -> everything docs/data needs)
data/raw/                   downloaded source files (gitignored - see "Rebuilding the data" below)
data/processed/             pipeline output, source of truth for docs/data (checked in, ~4MB)
docs/                       the static site itself, served by GitHub Pages from this folder
  index.html, app.js, style.css
  data/                     copy of data/processed/ - what the deployed site actually fetches
  branding/                 AAFA logo + brand colours
branding/                   source-of-truth copy of the same branding assets
```

`docs/` is a plain static site (Leaflet + TopoJSON, no build step, no backend).
Deploying is just: run the pipeline, copy `data/processed/*` into `docs/data/`,
commit, push.

## Data sources

| Data | Source | Licence |
|---|---|---|
| Postcodes (POA), suburbs (SAL), LGAs, state boundary | [ABS ASGS Edition 3](https://www.abs.gov.au/statistics/standards/australian-statistical-geography-standard-asgs/edition-3-july-2021-june-2026/access-and-downloads/digital-boundary-files) digital boundary files | CC BY 4.0, © Commonwealth of Australia (ABS) |
| State electoral district boundaries (2022 redistribution) | [Vicmap Admin – State Assembly Polygon 2022](https://discover.data.vic.gov.au/dataset/vicmap-admin-state-assembly-polygon-2022) via DataVic (data custodian: VEC) | CC BY 4.0, © State of Victoria (DEECA) |
| 2022 state election results by district | Scraped from VEC's per-district results pages (vec.vic.gov.au) | Victorian Government public sector information |
| Basemap tiles | OpenStreetMap standard tiles | © OpenStreetMap contributors |
| Address search | OpenStreetMap Nominatim | Usage-policy-compliant, low-volume, attributed in the UI |
| VIC farm/slaughterhouse facilities | [Farm Transparency Project](https://www.farmtransparency.org/map)'s "Reports / Export Data" CSV export (their own first-party export feature, not scraped) | See caveats below - crowdsourced, not a government dataset |

All of this is public data — nothing in the repo or the deployed site is
confidential.

## Rebuilding the data

`data/raw/` isn't checked in (it's ~300MB of zips/shapefiles). To regenerate
it from scratch you need, under `data/raw/`:

- `abs/POA_2021_AUST_GDA2020_SHP.zip`, `SAL_2021_AUST_GDA2020_SHP.zip`,
  `LGA_2025_AUST_GDA2020.zip`, `STE_2021_AUST_SHP_GDA2020.zip` — from the ABS
  link above.
- `vec/VEC_STATE_ASSEMBLY_2022_districts.geojson` — from the Vicmap Admin
  FeatureServer (layer 15, `STATE_ASSEMBLY_2022`) linked from the DataVic
  page above.
- `vec/VEC_2022_state_election_results_by_district.csv` — columns:
  `district, member, party, runner_up, runner_up_party, winner_pct,
  runner_up_pct, margin_pct_points, margin_basis, source_url`. Built by hand
  from VEC's per-district results pages; there's no official machine-readable
  export of this.

Then, from the repo root:

```bash
python3 -m venv .venv
./.venv/bin/pip install geopandas shapely pyogrio topojson mapclassify
./.venv/bin/python3 scripts/01_process_vic.py
cp data/processed/*.topojson data/processed/lookup_*.json data/processed/crosswalk_postcode_suburbs.json docs/data/
```

Bump the `?v=N` query strings in `docs/index.html` and `ASSET_VERSION` in
`docs/app.js` when you deploy changed data or code — some preview/proxy
environments have been observed caching these by URL regardless of
`Cache-Control` headers.

## Known caveats

- **~69 km² (0.03% of Victoria) isn't covered by any district** in the
  processed data — boundary misalignment between the independently-sourced
  ABS state outline and the VEC district layer, not a missing district.
  Negligible, but real.
- **Simplification**: geometry is simplified (postcodes/suburbs 40m,
  districts 120m, LGAs 80m, state boundary 100m tolerance) for file size and
  render performance. Fine for this map's purpose; not survey-grade.
- **The 0.1 threshold**: any unit/district overlap under 0.1% of the unit's
  area is dropped as topology noise between the two independently-sourced
  boundary datasets, and "fully within" is anything ≥99.5% in one district
  (not literally 100%) for the same reason.
- **District election results are only at district level.** There's no
  official suburb- or postcode-level voting result — VEC publishes results by
  district and by individual polling place, not by suburb/postcode. What's
  shown for a given postcode/suburb is the result for whichever district(s)
  cover it, not a result specific to that postcode/suburb's residents.
  Approximating something finer-grained from polling-place data was
  considered but deliberately deferred — postal/pre-poll/absent votes aren't
  tied to a physical location and would be excluded from any such
  approximation, which is a real accuracy gap worth solving properly before
  relying on it (see "Possible future additions" below).
- **Postcode filtering**: VIC postcodes are taken as the standard Australia
  Post 3xxx/8xxx prefixes, not by spatial intersection with the state
  boundary — the latter was pulling in NSW border postcodes with sub-1%
  slivers from imprecise river-boundary alignment.
- **Farm/slaughterhouse facility data is crowdsourced, not a government
  register.** Farm Transparency Project builds it from public
  directories/reports plus community submissions - some entries are tagged
  `(unconfirmed)` in their own data, or named "Unknown". The predecessor
  "Aussie Farms Map" was the subject of public/political controversy in 2019
  (the federal Agriculture Minister at the time called for it to be taken
  down over farmer-safety/biosecurity concerns); it's still operating. Treat
  any single listing as a lead to verify via its linked FTP profile page, not
  as a verified record - don't present it as AAFA's own confirmed finding.

## Possible future additions

- 2021 Census population by postcode/suburb (agreed with AAFA, not yet built).
- Polling-place-level result aggregation by suburb/postcode, clearly labelled
  as an approximation, to help identify target suburbs — flagged as useful
  by AAFA but intentionally not built yet given the postal/pre-poll coverage
  gap above.
- Federal electorate + state-level maps for other states, per the original
  brief (this repo currently covers VIC state electorates only).
- ABARES land-use data (e.g. Catchment Scale Land Use of Australia) as a
  complementary authoritative layer - classifies land use type but doesn't
  name specific businesses, so it wouldn't replace the FTP facility layer.
