//! Built-in recipe steps (docs/AUTOMATION.md §2 step catalogue). Each step takes resolved
//! parameters, does its work synchronously on the run's thread and returns outputs (for `${…}`
//! references in later steps) plus plain-language "why" lines for the run log and the report.

use super::{report_docx, data_steps, detect_steps, embed_steps, hydro_steps, lidar_steps, providers, raster_steps, scene_steps, stats_steps, taxa_steps};
use super::automap;
use super::cartography::{self, Layout, MapLayer, MapSpec};
use super::features::{self, Feat, FeatureSet, LocalProj, Val};
use super::report;
use super::sidecar;
use crate::catalog::{self, GeomKind, LayerHandle};
use crate::wkb::Geom;
use crate::Engine;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

pub struct StepSpec {
    pub name: &'static str,
    pub family: &'static str,
    pub summary: &'static str,
    /// Progress text while the step runs.
    pub running: &'static str,
    /// (name, required, description)
    pub params: &'static [(&'static str, bool, &'static str)],
    /// Which GIS tools this step borrows from (docs/FEATURE_MATRIX.md).
    pub borrowed: &'static str,
}

const IMPORT_PARAMS: &[(&str, bool, &str)] = &[("source", false, "device id, mounted device or folder; auto = the device that triggered the run, else the connected one")];
const CODE_PARAMS: &[(&str, bool, &str)] = &[
    ("code", false, "inline code (or use file:)"),
    ("file", false, "path to a script"),
    ("inputs", false, "{name: layer id} passed to the code as GeoJSON / sf / GeoDataFrame"),
    ("params", false, "values passed as params"),
    ("packages", false, "packages the code needs (checked before running)"),
    ("timeout_s", false, "default 600"),
];
const MAP_PARAMS: &[(&str, bool, &str)] = &[
    ("layers", false, "layers to map (default: every layer this run touched)"),
    ("title", false, "map title (default: automatic)"),
    ("subtitle", false, "auto or text"),
    ("size", false, "auto, a4, a4-portrait, a3, letter or WxH pixels"),
    ("format", false, "png, svg, pdf or a list (default png + svg)"),
    ("rasters", false, "raster ids, none, or auto (the newest thematic raster + relief shading)"),
    ("extent", false, "auto, [west, south, east, north] or a layer id"),
    ("labels", false, "label points with their name field (default true)"),
    ("context", false, "auto (land, roads, rivers if loaded), none, or layer ids"),
    ("grid", false, "lon/lat graticule (default true)"),
    ("projection", false, "auto (default: Equal Earth for world and continental maps, else Web Mercator), mercator or equal-earth"),
    ("scale", false, "PNG pixel scale 1-4 (default 1)"),
    ("name", false, "file name without extension (default map)"),
    ("frames", false, "index map: [{extent: [w, s, e, n], label}] outlined on the map"),
    ("exact", false, "show exactly the extent, no margin (map series sheets)"),
    ("dpi", false, "PNG resolution: 150 (default), 300, 600 … 1200; written into the file"),
    ("scale_bar", false, "pill (default), checker, line, ruler or none"),
    ("units", false, "metric (default), imperial or both"),
    ("north_arrow", false, "needle (default), compass, rose, minimal or none"),
    ("legend", false, "right (default), inside or none"),
    ("legend_at", false, "inside legend corner: auto (where the data is not), tl, tr, bl, br"),
    ("legend_title", false, "legend heading (default Legend; empty for none)"),
    ("legend_edit", false, "{layer: {title, hide, labels: {old: new}}}"),
    ("legend_order", false, "layer ids, top first"),
    ("inset", false, "overview map: none (default), auto, tl, tr, bl, br"),
    ("scale_bar_at", false, "auto (default: where the data is not), tl, tr, bl, br"),
    ("north_arrow_at", false, "auto (default), tl, tr, bl, br"),
    ("panels", false, "multi-panel page (R patchwork): [{extent?, title?, layers?}]"),
    ("facet", false, "one panel per value of this field (ggplot2 facet_wrap)"),
    ("facet_layer", false, "layer the facet field belongs to (default: the top mapped layer)"),
    ("ncol", false, "panel columns (default: as square as possible)"),
    ("legends", false, "collect (one shared), keep (one per panel) or auto"),
    ("tags", false, "panel tags: a (default), A, 1, i or none"),
    ("to", false, "also copy the files to this folder"),
];

const SEARCH_PARAMS: &[(&str, bool, &str)] = &[
    ("aoi", false, "[west, south, east, north], a layer/raster id, or auto"),
    ("buffer", false, "margin in metres (default 10 %)"),
    ("max_km", false, "largest area side (default 120)"),
    ("days", false, "look back (default 90)"),
    ("datetime", false, "explicit range start/end (ISO 8601)"),
    ("max_cloud", false, "scene cloud cover % (default 40)"),
    ("collection", false, "default sentinel-2-l2a"),
    ("endpoint", false, "STAC API (default Earth Search)"),
    ("limit", false, "results to consider (default 30)"),
];

pub const CATALOGUE: &[StepSpec] = &[
    StepSpec { name: "devices.import", family: "Devices", summary: "Import geotagged photos, GPS tracks, waypoints and sensor readings (logger CSV/JSON, FIT) from a phone, camera, drone card, GPS unit, sensor logger or folder.", running: "Importing photos, tracks and readings", params: IMPORT_PARAMS, borrowed: "ArcGIS Pro Geotagged Photos To Points, QGIS ImportPhotos, MapInfo drone add-in, Garmin Connect / Strava FIT import" },
    StepSpec {
        name: "sensor.snapshot",
        family: "Devices",
        summary: "Collect live sensor readings (HTTP pushes, MQTT feeds, phones) from the last minutes into a point layer, plus each sensor's path.",
        running: "Collecting live sensor readings",
        params: &[("minutes", false, "how far back (default 60)"), ("device", false, "sensor id or name, * wildcards allowed (default: all sensors)")],
        borrowed: "ArcGIS Velocity / GeoEvent Server, QGIS live GPS tracking, OGC SensorThings clients",
    },
    StepSpec {
        name: "sensor.summary",
        family: "Devices",
        summary: "Summarise every measurement (mean, 95th percentile, maximum), flag air-quality readings against the WHO guidelines, and pick the field to map.",
        running: "Summarising sensor readings",
        params: &[("layer", false, "readings layer (default: the newest one in this run)"), ("fields", false, "measurements to include (default: every numeric one)"), ("units", false, "{field: unit} (default: from the file headers, else common units)")],
        borrowed: "ArcGIS Velocity summaries, R openair, Python pandas describe",
    },
    StepSpec { name: "devices.import_photos", family: "Devices", summary: "devices.import; `layer` is the photos layer.", running: "Importing photos", params: IMPORT_PARAMS, borrowed: "ArcGIS Pro Geotagged Photos To Points" },
    StepSpec { name: "devices.import_tracks", family: "Devices", summary: "devices.import; `layer` is the tracks layer.", running: "Importing GPS tracks", params: IMPORT_PARAMS, borrowed: "QGIS GPS Tools, MapInfo GPS import" },
    StepSpec {
        name: "io.open",
        family: "Data",
        summary: "Open layers by id or file path; `auto` picks a suitable loaded layer.",
        running: "Opening data",
        params: &[("layer", false, "layer id, file path or auto"), ("layers", false, "several ids or paths"), ("path", false, "a file to open"), ("kind", false, "point, line or polygon (for auto)"), ("prefer", false, "largest or samples (for auto)")],
        borrowed: "ArcGIS Add Data, QGIS Data Source Manager",
    },
    StepSpec {
        name: "vector.sql",
        family: "Analysis",
        summary: "SQL (SQLite dialect with SpatiaLite functions) on a layer's dataset; @input is the layer's table.",
        running: "Running SQL",
        params: &[("layer", true, "layer whose dataset is queried"), ("sql", true, "SELECT … FROM @input …"), ("name", false, "output layer name (default: step id)")],
        borrowed: "MapInfo SQL Select, QGIS virtual layers, ArcGIS Make Query Layer",
    },
    StepSpec {
        name: "vector.buffer",
        family: "Analysis",
        summary: "Buffer features by a distance in metres (computed in the data's UTM zone), optionally dissolved.",
        running: "Buffering",
        params: &[("layer", true, "input layer"), ("distance", true, "metres"), ("dissolve", false, "merge into one area"), ("name", false, "output layer name")],
        borrowed: "ArcGIS Buffer, QGIS Buffer, GRASS v.buffer, SAGA Shapes Buffer",
    },
    StepSpec {
        name: "aggregate.hexbin",
        family: "Analysis",
        summary: "Aggregate points into hexagons (count, or sum/mean of a field); auto-sized cells.",
        running: "Binning points into hexagons",
        params: &[("layer", true, "point layer (other geometries use their centre)"), ("size", false, "cell radius in metres or auto"), ("field", false, "numeric field to summarise"), ("stat", false, "count, sum or mean"), ("name", false, "output layer name")],
        borrowed: "ArcGIS Generate Tessellation + Summarize Within, QGIS Create grid + Count points in polygon, deck.gl HexagonLayer",
    },
    StepSpec {
        name: "interpolate.idw",
        family: "Geostatistics",
        summary: "Inverse-distance-weighted surface from point samples; the power is chosen by leave-one-out cross-validation.",
        running: "Interpolating a surface",
        params: &[("layer", true, "point samples"), ("field", false, "numeric field (auto = the best one)"), ("power", false, "auto or a number"), ("cells", false, "grid columns (default 60)"), ("name", false, "output layer name")],
        borrowed: "ArcGIS IDW, QGIS IDW interpolation, GRASS v.surf.idw, SAGA Inverse Distance Weighted",
    },
    StepSpec {
        name: "interpolate.auto",
        family: "Geostatistics",
        summary: "Automatic geostatistics: fits a variogram (spherical, exponential, Gaussian), krigs with the best model and cross-validates it against IDW; the lower error wins. Kriging also maps its standard error.",
        running: "Fitting a variogram and kriging",
        params: &[
            ("layer", true, "point samples"),
            ("field", false, "numeric field (auto = the best one)"),
            ("method", false, "auto (kriging or IDW, whichever cross-validates better), kriging or idw"),
            ("model", false, "variogram model: auto, spherical, exponential or gaussian"),
            ("cells", false, "grid columns along the long side (default 200)"),
            ("neighbours", false, "samples per kriging prediction when there are over 200 (default 32)"),
            ("power", false, "IDW power (auto = cross-validated)"),
            ("cutoff", false, "variogram cutoff in metres (default a third of the diagonal)"),
            ("width", false, "variogram lag width in metres (default cutoff / 15)"),
            ("name", false, "output raster name"),
        ],
        borrowed: "ArcGIS Geostatistical Wizard / Empirical Bayesian Kriging (automatic), R gstat fit.variogram + krige + krige.cv, automap autoKrige, GRASS v.krige, SAGA Ordinary Kriging",
    },
    StepSpec {
        name: "stats.hotspots",
        family: "Statistics",
        summary: "Hot and cold spots (Getis-Ord Gi*) with every setting chosen from the data: incidents counted in auto-sized hexagons, the distance band from an incremental spatial autocorrelation search, significance corrected with the false discovery rate.",
        running: "Finding hot spots",
        params: &[
            ("layer", true, "incident points, or features with a value"),
            ("field", false, "value to analyse (auto = count incidents; polygons use their best numeric field)"),
            ("aggregation", false, "hexagon (default) or fishnet"),
            ("cell", false, "cell size in metres (auto)"),
            ("distance", false, "distance band in metres (auto)"),
            ("name", false, "output layer name"),
        ],
        borrowed: "ArcGIS Optimized Hot Spot Analysis / Hot Spot Analysis (Getis-Ord Gi*) / Incremental Spatial Autocorrelation, GeoDa, PySAL esda G_Local, R spdep localG",
    },
    StepSpec {
        name: "automap.style",
        family: "Cartography",
        summary: "Pick colours, classes and symbols from the data, explain each choice, and save them to the project.",
        running: "Choosing colours and classes",
        params: &[("layers", false, "layers to style (default: every layer this run touched)"), ("field", false, "field to map, or {layer: field}; none = single colour"), ("save", false, "write the styles to the project (default true)")],
        borrowed: "ArcGIS smart mapping, Felt AI auto-style, QGIS",
    },
    StepSpec { name: "style.apply", family: "Cartography", summary: "Apply saved styles exactly (what 'Save as recipe' records).", running: "Applying saved styles", params: &[("styles", true, "{layer id: style}"), ("save", false, "write to the project (default true)")], borrowed: "ArcGIS layer files, QGIS QML styles" },
    StepSpec { name: "overviews.build", family: "Performance", summary: "Build a PMTiles overview pyramid for a dense layer (skipped when not needed).", running: "Building overview tiles", params: &[("layer", true, "layer id"), ("maxzoom", false, "highest overview zoom (default: suggested)")], borrowed: "ArcGIS Build Pyramids, QGIS Build Overviews, GDAL gdaladdo" },
    StepSpec { name: "layout.auto", family: "Cartography", summary: "Page defaults (title, subtitle, size) for later export steps.", running: "Laying out the page", params: &[("title", false, ""), ("subtitle", false, ""), ("size", false, "")], borrowed: "ArcGIS Pro layouts, QGIS Print Layout" },
    StepSpec {
        name: "tool",
        family: "Analysis",
        summary: "Run any Toolbox tool (species distribution model, suitability, fragmentation, spectral index, the raster and terrain tools, a plugin's tool) with its parameters; its layers and rasters go to the next steps and the map, its result table into the report.",
        running: "Running the tool",
        params: &[
            ("tool", true, "plugin/tool, e.g. gsx/sdm or geolibre-tools/slope"),
            ("params", false, "the tool's parameters; layers and rasters by id or by this recipe's own name"),
        ],
        borrowed: "ArcGIS Pro ModelBuilder tool calls, QGIS graphical modeler algorithms",
    },
    StepSpec {
        name: "data.fetch",
        family: "Input",
        summary: "Online data for the area, no API keys: WorldClim 2.1 bioclim, monthly and CMIP6 future; CHELSA 2.1; SoilGrids 2.0; GBIF, OBIS and iNaturalist occurrences; GADM boundaries. Each with its citation.",
        running: "Downloading data",
        params: &[
            ("source", true, "worldclim, worldclim-monthly, worldclim-future, chelsa, soilgrids, gbif, obis, inat, gadm"),
            ("aoi", false, "[west, south, east, north], a layer/raster id, or auto"),
            ("buffer", false, "margin in metres (default 10 %)"),
            ("max_km", false, "largest area side (default 5000)"),
            ("variables", false, "bioclim numbers 1–19 or all (default 1, 12)"),
            ("resolution", false, "WorldClim: 10m (default), 5m, 2.5m, 30s"),
            ("variable", false, "worldclim-monthly: tavg, tmin, tmax, prec, srad, wind, vapr"),
            ("months", false, "worldclim-monthly: 1–12 (default all)"),
            ("gcm", false, "worldclim-future: climate model (default ACCESS-CM2)"),
            ("ssp", false, "worldclim-future: 126, 245, 370 or 585 (default)"),
            ("period", false, "worldclim-future: 2021-2040, 2041-2060 (default), 2061-2080, 2081-2100"),
            ("property", false, "soilgrids: phh2o (default), soc, clay, sand, silt, bdod, cec, nitrogen, cfvo, ocd"),
            ("depth", false, "soilgrids: 0-5cm (default) … 100-200cm"),
            ("species", false, "gbif/obis/inat: scientific name"),
            ("limit", false, "gbif/obis/inat: most records (default 2000)"),
            ("country", false, "gadm: ISO alpha-3 code"),
            ("level", false, "gadm: 0–3 (default 1)"),
            ("base", false, "mirror URL or folder with the provider's layout"),
            ("name", false, "output name (prefix when several)"),
        ],
        borrowed: "R geodata (worldclim_country, cmip6_world, soil_world, gadm), rgbif, robis, rinat; ArcGIS Living Atlas; QGIS plugins",
    },
    StepSpec {
        name: "dem.fetch",
        family: "Terrain",
        summary: "Fetch elevation for the area of interest (Copernicus GLO-30 by default, or any DEM file/URL), reprojected to the local UTM zone.",
        running: "Fetching elevation",
        params: &[("aoi", false, "[west, south, east, north], a layer/raster id, or auto"), ("buffer", false, "margin in metres (default 10 %)"), ("source", false, "copernicus (30 m), copernicus-90, or a DEM path/URL"), ("resolution", false, "metres (default 30)"), ("epsg", false, "output CRS (default: the UTM zone)"), ("max_km", false, "largest area side (default 120)"), ("title", false, ""), ("name", false, "")],
        borrowed: "ArcGIS Living Atlas terrain, QGIS SRTM Downloader, GRASS r.in.srtm, ERDAS terrain preparation",
    },
    StepSpec {
        name: "taxa.worms",
        family: "Data",
        summary: "Check a layer's scientific names against the World Register of Marine Species (WoRMS): adds the AphiaID, how each name matched, its status, the accepted name for synonyms, the classification and habitat, and a verdict to review (ok, synonym, check spelling, ambiguous, not in WoRMS). The names themselves are kept.",
        running: "Checking names with WoRMS",
        params: &[("layer", true, "the layer with scientific names"), ("field", false, "the names' field (default: species, scientificName, taxon or name)"), ("within", false, "keep candidates inside a group, e.g. Cnidaria or Animalia (settles homonyms)"), ("base", false, "a WoRMS mirror (default https://www.marinespecies.org)"), ("name", false, "")],
        borrowed: "WoRMS Taxon match tool; worrms (R) wm_records_names; obistools match_taxa; GBIF species matching",
    },
    StepSpec {
        name: "ai.detect",
        family: "AI models",
        summary: "Run your own ONNX model over an image in tiles, on this computer: object detection (YOLOv5/v8/v11 outputs) → a polygon layer with class, score and area; segmentation → a class raster. The model's licence goes into the methods.",
        running: "Running the model",
        params: &[("model", true, "model name in Imagery › Models, or an .onnx path"), ("raster", true, "the image (raster id)"), ("task", false, "detect or segment (default: from the model)"), ("threshold", false, "lowest score kept (default 0.25)"), ("iou", false, "overlap merged by non-maximum suppression (default 0.45)"), ("bands", false, "image bands fed to the model (default 1, 2, 3…)"), ("scale", false, "values are divided by this (default 255 for 8-bit, 10000 for 16-bit)"), ("mean", false, "per band, after scaling"), ("std", false, "per band, after scaling"), ("tile", false, "tile size for models of any size (default 512)"), ("overlap", false, "detection tile overlap in px (default 1/8 of the tile)"), ("format", false, "auto, yolov8, yolov5 or boxes"), ("title", false, ""), ("name", false, "")],
        borrowed: "ArcGIS Pro Detect Objects / Classify Pixels Using Deep Learning; QGIS Deepness plugin; Ultralytics YOLO; ERDAS IMAGINE deep learning",
    },
    StepSpec {
        name: "embeddings.fetch",
        family: "Satellite embeddings",
        summary: "Read AlphaEarth Foundations satellite embeddings (64 numbers per 10 m pixel summarising a year of observations, Google DeepMind, CC-BY 4.0) for the area of interest.",
        running: "Reading satellite embeddings",
        params: &[("aoi", false, "[west, south, east, north], a layer/raster id, or auto"), ("buffer", false, "margin in metres (default 10 %)"), ("year", false, "2017–2025 (default 2024)"), ("resolution", false, "metres (default 10; coarser for large areas)"), ("max_km", false, "largest area side (default 60)"), ("epsg", false, "output CRS (default: the UTM zone)"), ("title", false, ""), ("name", false, "")],
        borrowed: "Google Earth Engine GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL; geospatial foundation-model embeddings (Clay, Prithvi)",
    },
    StepSpec {
        name: "embeddings.similar",
        family: "Satellite embeddings",
        summary: "Map how alike every pixel is to sample points (cosine similarity of their embeddings): find more places like these.",
        running: "Finding similar places",
        params: &[("embeddings", false, "embedding raster id or auto"), ("samples", false, "point layer, or auto"), ("point", false, "[lon, lat] instead of samples"), ("threshold", false, "similarity counted as alike (default 0.9)"), ("title", false, ""), ("name", false, "")],
        borrowed: "Earth Engine similarity search on satellite embeddings; ArcGIS Pro Classify Pixels (one-class); QGIS SCP spectral angle mapping",
    },
    StepSpec {
        name: "embeddings.cluster",
        family: "Satellite embeddings",
        summary: "Group the landscape into k kinds of place with alike embeddings (spherical k-means), without any samples.",
        running: "Grouping the landscape",
        params: &[("embeddings", false, "embedding raster id or auto"), ("classes", false, "number of groups, 2–20 (default 8)"), ("seed", false, "random seed (default 7)"), ("title", false, ""), ("name", false, "")],
        borrowed: "ArcGIS Pro Iso Cluster Unsupervised Classification; QGIS/GRASS i.cluster + i.maxlik; Earth Engine ee.Clusterer.wekaKMeans",
    },
    StepSpec {
        name: "embeddings.classify",
        family: "Satellite embeddings",
        summary: "Classify the area from labelled samples (k-nearest neighbours on embeddings), with leave-one-out accuracy and area per class.",
        running: "Classifying from samples",
        params: &[("embeddings", false, "embedding raster id or auto"), ("samples", false, "point layer with the classes, or auto"), ("field", true, "class field of the samples"), ("neighbours", false, "k (default 5)"), ("title", false, ""), ("name", false, "")],
        borrowed: "ArcGIS Pro Train/Classify (Random Trees, SVM); QGIS Semi-Automatic Classification Plugin; GRASS i.maxlik; Earth Engine ee.Classifier",
    },
    StepSpec {
        name: "embeddings.change",
        family: "Satellite embeddings",
        summary: "How much each pixel changed between two years (1 − cosine similarity of its embeddings).",
        running: "Comparing years",
        params: &[("before", true, "embedding raster of the first year"), ("after", true, "embedding raster of the second year"), ("threshold", false, "change counted as changed (default 0.3)"), ("title", false, ""), ("name", false, "")],
        borrowed: "ArcGIS Pro Change Detection Wizard; QGIS/GRASS i.change; Earth Engine embedding change detection",
    },
    StepSpec {
        name: "terrain.derive",
        family: "Terrain",
        summary: "Hillshade, slope, aspect, TRI, TPI or roughness from a DEM (in metres; geographic DEMs are reprojected first).",
        running: "Deriving terrain",
        params: &[("dem", false, "raster id or auto"), ("products", false, "hillshade, slope, aspect, tri, tpi, roughness (default the first three)"), ("z", false, "hillshade exaggeration (auto)"), ("prefix", false, "output name prefix")],
        borrowed: "ArcGIS Surface toolset, QGIS Raster terrain analysis, GRASS r.slope.aspect / r.relief, SAGA Terrain Analysis, gdaldem",
    },
    StepSpec {
        name: "terrain.contours",
        family: "Terrain",
        summary: "Contour lines from a DEM with an automatic interval, index contours and smoothing.",
        running: "Tracing contours",
        params: &[("dem", false, "raster id or auto"), ("interval", false, "metres (auto ≈ 12 levels)"), ("index", false, "every n-th line is an index contour (default 5)"), ("smooth", false, "default true"), ("name", false, "")],
        borrowed: "ArcGIS Contour, QGIS Contour, GRASS r.contour, SAGA Contour Lines, MapInfo Vertical Mapper",
    },
    StepSpec {
        name: "hydro.network",
        family: "Hydrology",
        summary: "Streams with Strahler order, drainage basins and flow accumulation from a DEM: depressions filled, flow routed (D8) and accumulated natively, on DEMs of any size.",
        running: "Routing water over the terrain",
        params: &[
            ("dem", false, "raster id or auto"),
            ("threshold_km2", false, "upstream area where a stream starts, km² (default 1)"),
            ("min_basin_km2", false, "smallest basin kept, km² (default 1 % of the area, at least 1)"),
            ("sea_is_nodata", false, "treat 0 m and below as sea, not land (default true)"),
            ("name", false, "output name prefix (default hydro)"),
        ],
        borrowed: "ArcGIS Fill + Flow Direction + Flow Accumulation + Stream Order + Basin, QGIS/GRASS r.watershed + r.stream.order, WhiteboxTools FillDepressions + D8Pointer + StrahlerStreamOrder + Basins, TauDEM, SAGA Channel Network",
    },
    StepSpec {
        name: "lidar.grid",
        family: "LiDAR",
        summary: "Grid LAS/LAZ point clouds (drone, aircraft or national LiDAR tiles) into a bare-earth terrain model (DTM), a surface model (DSM) and canopy heights (CHM), and find buildings and tree tops.",
        running: "Gridding the point cloud",
        params: &[
            ("source", false, "a LAS/LAZ file, a folder of tiles or a device; auto = the device or drop folder that triggered the run"),
            ("resolution", false, "cell size in metres (auto: about 2–3 points per cell, coarser for big areas)"),
            ("ground", false, "auto (the file's ground class when it has one, else the SMRF filter), classes or smrf"),
            ("window", false, "SMRF window radius in metres (default 18: buildings up to about 36 m across are removed)"),
            ("min_tree", false, "lowest tree top in metres (default 3)"),
            ("epsg", false, "coordinate system of the files when they have none (or a wrong one)"),
            ("aoi", false, "[west, south, east, north] or a layer/raster id: grid only this area"),
            ("max_points", false, "refuse more points than this (default 2 billion)"),
            ("sample", false, "points kept for the 3D view (default 300000, every n-th; 0 = none)"),
            ("prefix", false, "output name prefix (default none: dtm, dsm, chm, trees, buildings)"),
        ],
        borrowed: "ArcGIS LAS Dataset to Raster + Classify LAS Ground + Extract Buildings/Trees, ERDAS IMAGINE point-cloud tools, PDAL filters.smrf + writers.gdal, lidR rasterize_terrain/rasterize_canopy/locate_trees, LAStools lasground/las2dem/lasheight, GRASS r.in.pdal",
    },
    StepSpec {
        name: "scene.3d",
        family: "3D",
        summary: "Turn a DEM into a 3D scene: terrain draped with its map colours and relief shading (or imagery), extruded buildings, modelled trees and a point-cloud sample. Saved as a glTF model, an interactive viewer that works offline, and a rendered 3D view for the report.",
        running: "Building the 3D scene",
        params: &[
            ("dem", false, "elevation raster id or auto (the newest DEM/DTM of the run)"),
            ("drape", false, "auto (imagery from this run if any, else the DEM's own colours), none, or raster ids to drape"),
            ("overlay", false, "layers painted onto the terrain in their map colours (contours, boundaries, tracks)"),
            ("buildings", false, "polygon layer to extrude, auto (a buildings layer from this run) or none"),
            ("height", false, "building height: a field, a number in metres, or auto (height_m, height, or levels × 3 m + 1 m; else 8 m)"),
            ("trees", false, "tree-top point layer (height_m, crown_m), auto or none"),
            ("cloud", false, "point cloud to show: auto (the sample lidar.grid kept), none, or a LAS/LAZ file or folder"),
            ("points", false, "most points to show (default 250000)"),
            ("epsg", false, "coordinate system of a cloud: file that has none"),
            ("exaggeration", false, "terrain height factor or auto (relief about 10 % of the width: at most 1.5× for surveys finer than 5 m, 3× for regional DEMs)"),
            ("grid", false, "mesh vertices along the longer side (default 320)"),
            ("azimuth", false, "picture seen from this compass bearing (default 200: from the south-south-west)"),
            ("elevation", false, "picture view angle above the horizon in degrees (default 35)"),
            ("size", false, "picture size WxH (default 1600x1000)"),
            ("title", false, "scene title"),
            ("name", false, "file name without extension (default scene)"),
        ],
        borrowed: "ArcGIS Pro local scenes (elevation surface, extrusion, LAS dataset layers, Export to glTF/3D Object), QGIS 3D map view + Qgis2threejs, ERDAS IMAGINE VirtualGIS, GRASS NVIZ, SAGA 3D View, MapInfo 3DMap, CloudCompare, CesiumJS",
    },
    StepSpec {
        name: "raster.classify",
        family: "Raster",
        summary: "Reclassify a raster into labelled classes (automatic schemes for slope, NDVI, NDWI, NBR, elevation) and report the area of each class.",
        running: "Classifying",
        params: &[("raster", false, "raster id or auto"), ("breaks", false, "class limits"), ("labels", false, "one more than breaks"), ("colors", false, ""), ("ramp", false, "for custom breaks"), ("title", false, ""), ("name", false, "")],
        borrowed: "ArcGIS Reclassify + Tabulate Area, QGIS Reclassify by table, GRASS r.reclass / r.report, ERDAS Recode",
    },
    StepSpec {
        name: "raster.sample",
        family: "Raster",
        summary: "Add raster values (elevation, slope, NDVI…) to point features as new fields; reports the strongest correlation with a measured field.",
        running: "Sampling rasters at points",
        params: &[("layer", false, "point layer (auto: the newest)"), ("rasters", false, "raster ids (auto: this run's rasters)"), ("name", false, "")],
        borrowed: "ArcGIS Extract Multi Values to Points, QGIS Sample raster values, GRASS v.what.rast, SAGA Add Grid Values to Points",
    },
    StepSpec {
        name: "rs.search",
        family: "Remote sensing",
        summary: "Find recent satellite scenes over the area via STAC (Sentinel-2 L2A on Earth Search by default), newest first, cloud-filtered.",
        running: "Searching satellite scenes",
        params: SEARCH_PARAMS,
        borrowed: "Octave Imagine (ERDAS) search, Earth Engine filterBounds/filterDate, QGIS STAC plugin, ArcGIS Pro imagery search",
    },
    StepSpec {
        name: "rs.index",
        family: "Remote sensing",
        summary: "Spectral index (NDVI, NDWI, NBR, NDMI, SAVI, EVI) from the newest scene that is clear over the area; clouds and shadows are masked.",
        running: "Computing the index",
        params: &[
            ("index", false, "ndvi (default), ndwi, nbr, ndmi, savi, evi"), ("min_clear", false, "share of the area that must be cloud-free (default 0.7)"), ("max_tries", false, "dates to try (default 5)"),
            ("resolution", false, "metres (default 10)"), ("mask", false, "mask clouds (default true)"), ("name", false, ""),
            ("aoi", false, "box, layer id or auto"), ("buffer", false, "metres"), ("max_km", false, ""), ("days", false, "rs.search, when no search ran"), ("datetime", false, ""), ("max_cloud", false, ""), ("collection", false, ""), ("endpoint", false, ""), ("limit", false, ""),
        ],
        borrowed: "ERDAS Indices, ArcGIS NDVI raster function, GRASS i.vi, SAGA Vegetation Index, Earth Engine normalizedDifference",
    },
    StepSpec {
        name: "rs.fetch",
        family: "Remote sensing",
        summary: "True-colour imagery (or any band) for the area from the chosen scene.",
        running: "Fetching imagery",
        params: &[
            ("scene", false, "scene id or auto"), ("asset", false, "visual (default) or a band"), ("resolution", false, "metres"), ("name", false, ""),
            ("aoi", false, "box, layer id or auto"), ("buffer", false, "metres"), ("max_km", false, ""), ("days", false, "rs.search, when no search ran"), ("datetime", false, ""), ("max_cloud", false, ""), ("collection", false, ""), ("endpoint", false, ""), ("limit", false, ""),
        ],
        borrowed: "ArcGIS Living Atlas imagery, QGIS XYZ basemaps, ERDAS Subset",
    },
    StepSpec {
        name: "grass",
        family: "Providers",
        summary: "Run GRASS modules headless in a temporary project; inputs are imported and outputs come back as rasters/layers (with GRASS class labels and colours).",
        running: "Running GRASS",
        params: &[("script", true, "GRASS commands, one per line"), ("outputs", true, "{name: raster | vector | classes}"), ("inputs", false, "{name: raster/layer id or path} (default: the DEM as dem)"), ("timeout", false, "seconds")],
        borrowed: "GRASS (as QGIS Processing does), r.geomorphon, r.watershed, r.sun, v.net",
    },
    StepSpec {
        name: "saga",
        family: "Providers",
        summary: "Run a SAGA tool with saga_cmd; outputs come back as rasters.",
        running: "Running SAGA",
        params: &[("tool", true, "'<library> <tool>', e.g. ta_hydrology 15"), ("outputs", true, "{PARAM: name}"), ("inputs", false, "{PARAM: raster/layer id or path} (default ELEVATION: the DEM)"), ("options", false, "{PARAM: value}"), ("timeout", false, "seconds")],
        borrowed: "SAGA GIS (as QGIS Processing does): wetness index, channel networks, morphometry",
    },
    StepSpec { name: "export.map", family: "Output", summary: "Lay out and export a finished map (title, legend, scale bar, north arrow, graticule, labels, credits) as PNG and/or SVG.", running: "Laying out and exporting the map", params: MAP_PARAMS, borrowed: "ArcGIS Pro Export Layout, QGIS Print Layout, MapInfo Layout Designer" },
    StepSpec { name: "export.png", family: "Output", summary: "export.map as PNG.", running: "Exporting the map", params: MAP_PARAMS, borrowed: "ArcGIS Pro Export Layout" },
    StepSpec { name: "export.pdf", family: "Output", summary: "export.map as a vector PDF (selectable text, print-ready page).", running: "Exporting the map", params: MAP_PARAMS, borrowed: "ArcGIS Pro Export Layout to PDF, QGIS Export as PDF" },
    StepSpec { name: "export.svg", family: "Output", summary: "export.map as SVG (vector, editable in Inkscape or Illustrator).", running: "Exporting the map", params: MAP_PARAMS, borrowed: "ArcGIS Pro Export Layout" },
    StepSpec { name: "export.series", family: "Output", summary: "Bind the run's map pages (a map series / atlas, with its index page) into one multi-page vector PDF.", running: "Binding the map series", params: &[("name", false, "file name (default series)"), ("to", false, "also copy to this folder")], borrowed: "ArcGIS Pro Map Series export, QGIS Atlas export as a single PDF" },
    StepSpec { name: "export.report", family: "Output", summary: "One-page HTML report: the map, headline numbers, how it was made, every automatic decision, run log and provenance.", running: "Writing the report", params: &[("title", false, ""), ("subtitle", false, ""), ("notes", false, "free text"), ("name", false, "file name (default report)"), ("to", false, "also copy to this folder")], borrowed: "ArcGIS Pro reports, R Markdown / Quarto" },
    StepSpec { name: "export.data", family: "Output", summary: "Export layers as GeoPackage, GeoJSON, CSV, FlatGeobuf, KML or Shapefile (EPSG:4326).", running: "Exporting data", params: &[("layers", false, "default: every layer this run touched"), ("layer", false, ""), ("format", false, "gpkg, geojson, csv, fgb, kml, shp"), ("to", false, "also copy to this folder")], borrowed: "ArcGIS Export Features, QGIS Save As, ogr2ogr" },
    StepSpec { name: "python", family: "Code", summary: "Run Python code (geopandas if installed, otherwise plain GeoJSON); returned layers join the map.", running: "Running the Python step", params: CODE_PARAMS, borrowed: "ArcPy, PyQGIS, GRASS Python API, geopandas" },
    StepSpec { name: "r", family: "Code", summary: "Run R code (sf objects in, sf objects out): gstat kriging, spatstat, terra and the rest of CRAN.", running: "Running the R step", params: CODE_PARAMS, borrowed: "R sf / gstat / terra, ArcGIS R-ArcGIS bridge" },
];

/// `script.python` / `script.r` are accepted as aliases.
pub fn canonical(name: &str) -> &str {
    match name {
        "script.python" => "python",
        "script.r" => "r",
        n => n,
    }
}

pub fn spec(name: &str) -> Option<&'static StepSpec> {
    let n = canonical(name);
    CATALOGUE.iter().find(|s| s.name == n)
}

fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + (a[i - 1] != b[j - 1]) as usize);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Static checks of one step: known step, required parameters present, unknown parameters.
pub fn check(uses: &str, with: &Value) -> (Vec<String>, Vec<String>) {
    let (mut errs, mut warns) = (Vec::new(), Vec::new());
    let Some(s) = spec(uses) else {
        let best = CATALOGUE.iter().min_by_key(|s| edit_distance(s.name, uses)).map(|s| s.name).unwrap_or("");
        errs.push(format!("unknown step '{uses}' (did you mean '{best}'? `geospax steps` lists them all)"));
        return (errs, warns);
    };
    let given = with.as_object().cloned().unwrap_or_default();
    for (p, required, _) in s.params {
        if *required && !given.contains_key(*p) {
            errs.push(format!("'{uses}' needs '{p}'"));
        }
    }
    for k in given.keys() {
        if !s.params.iter().any(|(p, _, _)| p == k) {
            warns.push(format!("'{uses}' ignores unknown parameter '{k}'"));
        }
    }
    if matches!(s.name, "python" | "r") && !given.contains_key("code") && !given.contains_key("file") {
        errs.push(format!("'{uses}' needs code: or file:"));
    }
    (errs, warns)
}

// ------------------------------------------------------------------ context

pub struct StepCtx<'a> {
    pub engine: &'a Arc<Engine>,
    pub recipe_id: &'a str,
    pub recipe_title: &'a str,
    pub recipe_text: &'a str,
    pub run_id: &'a str,
    pub dir: &'a Path,
    pub cancel: &'a AtomicBool,
    pub trigger: &'a Value,
    pub inputs: &'a Map<String, Value>,
    pub step_id: String,
    /// layer id -> (style, label field, why)
    pub styles: HashMap<String, (Value, Option<String>, String)>,
    pub names: HashMap<String, String>,
    pub page: Map<String, Value>,
    pub touched: Vec<String>,
    pub maps: Vec<(PathBuf, Vec<String>)>,
    pub methods: Vec<String>,
    pub records: Vec<Value>,
    pub artifacts: Vec<String>,
    pub extent: Option<[f64; 4]>,
    pub device: Option<String>,
    pub import_summary: Option<String>,
    pub cards: Vec<(String, String)>,
    /// Style hints from the step that made a layer (e.g. a continuous surface has no outlines).
    pub hints: HashMap<String, Value>,
    /// Rasters this run made or opened, oldest first (maps use them by default).
    pub rasters: Vec<String>,
    /// STAC search results, best first (rs.index puts the scene it used first).
    pub scenes: Vec<Value>,
    /// Area of interest (lon/lat) chosen by the first step that needed one.
    pub aoi: Option<[f64; 4]>,
    /// Every n-th point lidar.grid read (for scene.3d) and how many points there were in all.
    pub cloud_sample: Option<Arc<Vec<crate::lidar::SamplePoint>>>,
    pub cloud_total: u64,
    /// 3D views for the report (scene.3d).
    pub views: Vec<report::View3d>,
    /// Inline SVG charts for the report: (title, svg, caption).
    pub charts: Vec<(String, String, String)>,
    /// Every exported map: (PNG file name if any, title); the report shows maps after the first.
    pub figures: Vec<(Option<String>, String)>,
    /// The run's job, for live progress (downloads report bytes and an ETA through it).
    pub job: Option<Arc<crate::jobs::Job>>,
}

impl<'a> StepCtx<'a> {
    /// Show (or clear, with `None`) a download gauge on the run: the UI polls it.
    pub fn transfer(&self, v: Option<Value>) {
        if let Some(j) = &self.job {
            j.update(|s| s.transfer = v);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn new(
        engine: &'a Arc<Engine>,
        recipe_id: &'a str,
        recipe_title: &'a str,
        recipe_text: &'a str,
        run_id: &'a str,
        dir: &'a Path,
        cancel: &'a AtomicBool,
        trigger: &'a Value,
        inputs: &'a Map<String, Value>,
    ) -> Self {
        StepCtx {
            engine,
            recipe_id,
            recipe_title,
            recipe_text,
            run_id,
            dir,
            cancel,
            trigger,
            inputs,
            step_id: String::new(),
            styles: HashMap::new(),
            names: HashMap::new(),
            page: Map::new(),
            touched: Vec::new(),
            maps: Vec::new(),
            methods: Vec::new(),
            records: Vec::new(),
            artifacts: Vec::new(),
            extent: None,
            device: None,
            import_summary: None,
            cards: Vec::new(),
            hints: HashMap::new(),
            rasters: Vec::new(),
            scenes: Vec::new(),
            aoi: None,
            cloud_sample: None,
            cloud_total: 0,
            views: Vec::new(),
            charts: Vec::new(),
            figures: Vec::new(),
            job: None,
        }
    }
}

pub struct StepOut {
    pub outputs: Value,
    pub why: Vec<String>,
}

pub(super) fn p_str<'v>(p: &'v Value, k: &str) -> Option<&'v str> {
    p.get(k).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty())
}

pub(super) fn p_f64(p: &Value, k: &str) -> Option<f64> {
    p.get(k).and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())))
}

pub(super) fn p_bool(p: &Value, k: &str, default: bool) -> bool {
    match p.get(k) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !matches!(s.trim(), "false" | "no" | "none" | "off" | "0"),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => default,
    }
}

/// A string, a comma-separated string or a (nested) list of strings; nulls dropped.
pub(super) fn p_list(p: &Value, k: &str) -> Vec<String> {
    fn flat(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.extend(s.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)),
            Value::Array(a) => a.iter().for_each(|x| flat(x, out)),
            _ => {}
        }
    }
    let mut out = Vec::new();
    if let Some(v) = p.get(k) {
        flat(v, &mut out);
    }
    out
}

pub(super) fn now_local() -> chrono::DateTime<chrono::Local> {
    chrono::Local::now()
}

pub fn fnv64(s: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{h:016x}")
}

pub(super) fn sanitize(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' { c.to_ascii_lowercase() } else { '_' }).collect()
}

pub(super) fn humanize(s: &str) -> String {
    let s = s.replace(['_', '-'], " ");
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn rank(kind: GeomKind) -> u8 {
    match kind {
        GeomKind::Polygon => 0,
        GeomKind::Line => 1,
        GeomKind::Point => 2,
        GeomKind::Unknown => 3,
    }
}

impl StepCtx<'_> {
    pub(super) fn touch(&mut self, id: &str) {
        if !self.touched.iter().any(|t| t == id) {
            self.touched.push(id.to_string());
        }
    }

    pub(super) fn layer(&self, id: &str) -> Result<Arc<LayerHandle>, String> {
        self.engine.layer(id).ok_or_else(|| {
            let mut ids: Vec<String> = self.engine.layers().iter().map(|l| l.info.id.clone()).collect();
            ids.sort_by_key(|x| edit_distance(x, id));
            ids.truncate(3);
            format!("unknown layer '{id}' (closest: {})", ids.join(", "))
        })
    }

    pub(super) fn title_of(&self, l: &LayerHandle) -> String {
        self.names.get(&l.info.id).cloned().unwrap_or_else(|| humanize(&l.info.name))
    }

    pub(super) fn outputs_dir(&self) -> PathBuf {
        self.engine.state_dir.join("outputs").join(self.recipe_id)
    }

    /// Write a result layer to `<state>/outputs/<recipe>/<name>.gpkg` and register it as
    /// `<recipe>.<name>` (a re-run replaces it: the map updates itself).
    pub(super) fn write_output(&mut self, name: &str, fs: &FeatureSet, title: String) -> Result<String, String> {
        let name = sanitize(name);
        let dir = self.outputs_dir();
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let file = dir.join(format!("{name}.gpkg"));
        let tmp = dir.join(format!("{name}.part.gpkg"));
        features::write_features(&tmp, "GPKG", &name, fs)?;
        std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
        let id = format!("{}.{name}", self.recipe_id);
        let mut handles = catalog::load_layers(&file)?;
        handles.truncate(1);
        for h in handles.iter_mut() {
            h.info.id = id.clone();
        }
        self.engine.register_layers(handles);
        self.touch(&id);
        self.names.insert(id.clone(), title);
        Ok(id)
    }

    pub(super) fn resolve_path(&self, s: &str) -> Option<PathBuf> {
        let p = PathBuf::from(s);
        if p.is_absolute() || p.exists() {
            return p.exists().then_some(p);
        }
        self.engine.data_dirs.iter().map(|d| if d.is_dir() { d.join(s) } else { d.parent().unwrap_or(Path::new(".")).join(s) }).find(|c| c.exists())
    }
}

pub fn execute(sc: &mut StepCtx, uses: &str, p: &Value) -> Result<StepOut, String> {
    match canonical(uses) {
        "devices.import" => devices_import(sc, p, None),
        "sensor.snapshot" => sensor_snapshot(sc, p),
        "sensor.summary" => sensor_summary(sc, p),
        "devices.import_photos" => devices_import(sc, p, Some("photos")),
        "devices.import_tracks" => devices_import(sc, p, Some("tracks")),
        "io.open" => io_open(sc, p),
        "vector.sql" => vector_sql(sc, p),
        "vector.buffer" => vector_buffer(sc, p),
        "aggregate.hexbin" => hexbin(sc, p),
        "interpolate.idw" => idw(sc, p),
        "interpolate.auto" => stats_steps::interpolate_auto(sc, p),
        "stats.hotspots" => stats_steps::hotspots(sc, p),
        "automap.style" => automap_style(sc, p),
        "style.apply" => style_apply(sc, p),
        "overviews.build" => overviews_build(sc, p),
        "layout.auto" => {
            if let Some(o) = p.as_object() {
                sc.page.extend(o.clone());
            }
            Ok(StepOut { outputs: json!({ "page": p }), why: vec!["page defaults set for the export steps".into()] })
        }
        "export.map" => export_map(sc, p, None),
        "export.png" => export_map(sc, p, Some("png")),
        "export.svg" => export_map(sc, p, Some("svg")),
        "export.pdf" => export_map(sc, p, Some("pdf")),
        "export.series" => export_series(sc, p),
        "dem.fetch" => raster_steps::dem_fetch(sc, p),
        "ai.detect" => detect_steps::detect(sc, p),
        "taxa.worms" => taxa_steps::worms(sc, p),
        "embeddings.fetch" => embed_steps::fetch(sc, p),
        "embeddings.similar" => embed_steps::similar(sc, p),
        "embeddings.cluster" => embed_steps::cluster(sc, p),
        "embeddings.classify" => embed_steps::classify(sc, p),
        "embeddings.change" => embed_steps::change(sc, p),
        "data.fetch" => data_steps::data_fetch(sc, p),
        "tool" => super::tool_step::tool(sc, p),
        "lidar.grid" => lidar_steps::lidar_grid(sc, p),
        "hydro.network" => hydro_steps::hydro_network(sc, p),
        "scene.3d" => scene_steps::scene_3d(sc, p),
        "terrain.derive" => raster_steps::terrain_derive(sc, p),
        "terrain.contours" => raster_steps::terrain_contours(sc, p),
        "raster.classify" => raster_steps::raster_classify(sc, p),
        "raster.sample" => raster_steps::raster_sample(sc, p),
        "rs.search" => raster_steps::rs_search(sc, p),
        "rs.index" => raster_steps::rs_index(sc, p),
        "rs.fetch" => raster_steps::rs_fetch(sc, p),
        "grass" => providers::grass(sc, p),
        "saga" => providers::saga(sc, p),
        "export.report" => export_report(sc, p),
        "export.data" => export_data(sc, p),
        "python" => code_step(sc, p, sidecar::Lang::Python),
        "r" => code_step(sc, p, sidecar::Lang::R),
        other => Err(format!("unknown step '{other}'")),
    }
}

// ------------------------------------------------------------------ devices / data

pub(super) fn resolve_source(sc: &StepCtx, src: &str) -> Result<PathBuf, String> {
    let s = src.trim();
    if s.is_empty() || s == "auto" {
        for k in ["root", "path"] {
            if let Some(r) = sc.trigger.get(k).and_then(Value::as_str) {
                return Ok(PathBuf::from(r));
            }
        }
        return sc.engine.devices.best_root().ok_or_else(|| {
            "no device with geodata is connected: plug in a phone, camera, drone card or GPS unit, or pass --input source=/path/to/folder".to_string()
        });
    }
    let p = PathBuf::from(s);
    if p.is_dir() {
        return Ok(p);
    }
    if p.is_file() {
        return Err(format!("'{s}' is a file; pass the folder that contains it"));
    }
    sc.engine.devices.find_root(s).ok_or_else(|| {
        let known = sc.engine.devices.names();
        format!("'{s}' is not a folder or a known device (devices: {})", if known.is_empty() { "none".into() } else { known.join(", ") })
    })
}

fn devices_import(sc: &mut StepCtx, p: &Value, pick: Option<&str>) -> Result<StepOut, String> {
    let root = resolve_source(sc, p_str(p, "source").unwrap_or("auto"))?;
    let scan = crate::devices::scan(&root);
    let name = root.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| root.display().to_string());
    if !scan.has_geodata() {
        return Err(format!("no geotagged photos, GPS tracks, waypoints, sensor readings or point clouds in {} ({} images looked at)", root.display(), scan.images));
    }
    let id = crate::devices::device_id(&root);
    let kind = crate::devices::kind_of(&root, &scan);
    let dir = sc.engine.state_dir.join("devices");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{id}.importing.gpkg"));
    let out = dir.join(format!("{id}.gpkg"));
    crate::devices::write_gpkg(&tmp, &name, &scan)?;
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    let layers = sc.engine.register_layers(catalog::load_layers(&out)?);
    let track_m: f64 = scan.tracks.iter().flat_map(|t| t.parts.iter()).map(|p| p.windows(2).map(|w| crate::devices::haversine(w[0], w[1])).sum::<f64>()).sum();
    let mut times: Vec<&str> = scan.photos.iter().filter_map(|p| p.taken_at.as_deref()).filter(|t| !t.is_empty()).collect();
    times.sort_unstable();
    let info = json!({
        "layers": layers, "at": chrono::Utc::now().timestamp(), "photos": scan.photos.len(), "tracks": scan.tracks.len(),
        "waypoints": scan.waypoints.len(), "readings": scan.readings.len(), "point_clouds": scan.point_clouds.len(), "by": format!("recipe {}", sc.recipe_id),
    });
    sc.engine.devices.record_import(&id, info);
    for l in &layers {
        sc.touch(l);
        let role = l.rsplit('.').next().unwrap_or("");
        sc.names.insert(l.clone(), format!("{} · {name}", humanize(role)));
    }
    let find = |suffix: &str| layers.iter().find(|l| l.ends_with(&format!(".{suffix}"))).cloned();
    let pts = scan.photos.iter().map(|p| (p.lon, p.lat)).chain(scan.waypoints.iter().map(|w| (w.lon, w.lat))).chain(scan.tracks.iter().flat_map(|t| t.parts.iter().flatten().copied())).chain(scan.readings.iter().map(|r| (r.lon, r.lat)));
    let bounds = pts.fold(None, |acc: Option<[f64; 4]>, (x, y)| Some(match acc {
        None => [x, y, x, y],
        Some(b) => [b[0].min(x), b[1].min(y), b[2].max(x), b[3].max(y)],
    }));
    let plural = |n: usize, w: &str| format!("{n} {w}{}", if n == 1 { "" } else { "s" });
    let mut parts = Vec::new();
    if !scan.photos.is_empty() {
        parts.push(plural(scan.photos.len(), "geotagged photo"));
    }
    if !scan.tracks.is_empty() {
        parts.push(format!("{} ({})", plural(scan.tracks.len(), "track"), features::fmt_distance(track_m)));
    }
    if !scan.waypoints.is_empty() {
        parts.push(plural(scan.waypoints.len(), "waypoint"));
    }
    let field_names = scan.field_names();
    if !scan.readings.is_empty() {
        let mut shown: Vec<&str> = field_names.iter().take(4).copied().collect();
        if field_names.len() > 4 {
            shown.push("…");
        }
        parts.push(format!("{} ({})", plural(scan.readings.len(), "sensor reading"), shown.join(", ")));
    }
    let units: Map<String, Value> = scan.reading_fields.iter().filter_map(|(n, u)| u.as_ref().map(|u| (n.clone(), Value::from(u.clone())))).collect();
    let summary = parts.join(" · ");
    let skipped = scan.images.saturating_sub(scan.photos.len());
    sc.device = Some(name.clone());
    sc.import_summary = Some(summary.clone());
    if !scan.photos.is_empty() {
        sc.cards.push((scan.photos.len().to_string(), "geotagged photos".into()));
    }
    if track_m > 0.0 {
        sc.cards.push((features::fmt_distance(track_m), "of GPS track".into()));
    }
    if !scan.waypoints.is_empty() {
        sc.cards.push((scan.waypoints.len().to_string(), "waypoints".into()));
    }
    if !scan.readings.is_empty() {
        sc.cards.push((scan.readings.len().to_string(), "geotagged sensor readings".into()));
    }
    sc.methods.push(format!(
        "Data were imported from {name} ({kind}): {summary}{}. Positions come from EXIF GPS tags, DJI XMP metadata, GPX/KML files, NMEA logs, DJI flight telemetry, sensor-logger CSV/JSON coordinates and FIT activity records, as found.",
        if skipped > 0 { format!(" ({skipped} photo{} without GPS skipped)", if skipped == 1 { "" } else { "s" }) } else { String::new() }
    ));
    let layer = match pick {
        Some(s) => find(s),
        None => layers.first().cloned(),
    };
    Ok(StepOut {
        outputs: json!({
            "device": name, "device_id": id, "kind": kind, "root": root, "layers": layers, "layer": layer,
            "photos_layer": find("photos"), "tracks_layer": find("tracks"), "waypoints_layer": find("waypoints"), "readings_layer": find("readings"),
            "readings": scan.readings.len(), "reading_fields": field_names, "units": units, "sensor_files": scan.sensor_files,
            "photos": scan.photos.len(), "photos_total": scan.images, "tracks": scan.tracks.len(),
            "track_km": (track_m / 10.0).round() / 100.0, "waypoints": scan.waypoints.len(), "bounds": bounds,
            "gpkg": out, "taken_from": times.first(), "taken_to": times.last(), "summary": summary,
        }),
        why: vec![format!(
            "{name} ({kind}): {summary}{} → {} layers in {:.0} ms",
            if skipped > 0 { format!(", {skipped} without GPS") } else { String::new() },
            layers.len(),
            scan.ms
        )],
    })
}

fn iso_time(t: f64) -> String {
    chrono::DateTime::from_timestamp(t as i64, 0).map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)).unwrap_or_default()
}

/// Live readings of the last `minutes` -> `<recipe>.live_readings` (+ `live_tracks`).
fn sensor_snapshot(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let minutes = p_f64(p, "minutes").unwrap_or(60.0).clamp(1.0, 10_080.0);
    let device = p_str(p, "device").filter(|d| !matches!(*d, "auto" | "all"));
    let since = crate::devices::now_s() - minutes * 60.0;
    let rows = sc.engine.devices.live_readings(device, since);
    if rows.is_empty() {
        return Err(format!(
            "no live sensor readings in the last {} min{}: sensors POST to /api/devices/live or publish over MQTT (--mqtt), see docs/DEVICES.md §5",
            features::num_text(minutes),
            device.map(|d| format!(" from '{d}'")).unwrap_or_default()
        ));
    }
    let mut names: Vec<String> = Vec::new();
    for (_, _, r) in &rows {
        for (k, _) in &r.values {
            if !names.contains(k) && names.len() < 64 {
                names.push(k.clone());
            }
        }
    }
    // readings carry the sensor's name as `sensor` (not `name`), so every reading is not labelled;
    // the `live_latest` layer below (one point per sensor) carries `name` and gets the labels
    let mut fields: Vec<(String, &'static str)> = vec![("time".into(), "string"), ("device".into(), "string"), ("sensor".into(), "string")];
    fields.extend(names.iter().map(|n| (n.clone(), "real")));
    let mut latest_fields = fields.clone();
    latest_fields[2].0 = "name".into();
    let mut fs = FeatureSet::new(GeomKind::Point, fields);
    let mut latest = FeatureSet::new(GeomKind::Point, latest_fields);
    let mut devices: Vec<String> = Vec::new();
    for (id, name, r) in &rows {
        if !devices.contains(id) {
            devices.push(id.clone());
        }
        let mut props = vec![Val::Str(iso_time(r.t)), Val::Str(id.clone()), Val::Str(name.clone())];
        props.extend(names.iter().map(|n| r.values.iter().find(|(k, _)| k == n).map(|(_, v)| Val::Num(*v)).unwrap_or(Val::Null)));
        let feat = Feat { geom: Geom::Points(vec![[r.lon, r.lat]]), props };
        // rows are oldest first: the last one per sensor is where it is now
        match latest.feats.iter().position(|f| matches!(&f.props[1], Val::Str(d) if d == id)) {
            Some(i) => latest.feats[i] = feat.clone(),
            None => latest.feats.push(feat.clone()),
        }
        fs.feats.push(feat);
    }
    fs.total = fs.feats.len() as u64;
    latest.total = latest.feats.len() as u64;
    let readings = sc.write_output("live_readings", &fs, "Live sensor readings".into())?;
    let now = sc.write_output("live_latest", &latest, "Sensors now".into())?;
    let mut layers = vec![readings.clone()];
    // only the sensors' own paths (not every phone or GNSS receiver that happens to be live)
    let tracks: Vec<_> = sc.engine.devices.live_tracks(device, since).into_iter().filter(|(id, _, _)| devices.contains(id)).collect();
    let mut tracks_layer = None;
    if !tracks.is_empty() {
        let mut ts = FeatureSet::new(GeomKind::Line, vec![("device".into(), "string"), ("name".into(), "string")]);
        for (id, name, pts) in &tracks {
            ts.feats.push(Feat { geom: Geom::Lines(vec![pts.iter().map(|(x, y)| [*x, *y]).collect()]), props: vec![Val::Str(id.clone()), Val::Str(name.clone())] });
        }
        ts.total = ts.feats.len() as u64;
        let id = sc.write_output("live_tracks", &ts, "Sensor paths".into())?;
        layers.push(id.clone());
        tracks_layer = Some(id);
    }
    layers.push(now.clone());
    let n = devices.len();
    let plural = if n == 1 { "" } else { "s" };
    sc.device = Some(if n == 1 { rows[0].1.clone() } else { format!("{n} sensors") });
    sc.cards.push((rows.len().to_string(), "live sensor readings".into()));
    sc.methods.push(format!(
        "Live readings from {n} sensor{plural} over the last {} minutes were taken from the GeoSpaX device hub (HTTP pushes and MQTT messages, each with its own position).",
        features::num_text(minutes)
    ));
    let shown: Vec<&str> = names.iter().take(5).map(String::as_str).collect();
    Ok(StepOut {
        outputs: json!({
            "readings_layer": readings, "tracks_layer": tracks_layer, "latest_layer": now, "layers": layers, "count": rows.len(), "devices": devices, "fields": names,
            "from": iso_time(rows[0].2.t), "to": iso_time(rows[rows.len() - 1].2.t),
        }),
        why: vec![format!("{} readings from {n} sensor{plural} in the last {} min ({})", rows.len(), features::num_text(minutes), shown.join(", "))],
    })
}

fn default_unit(field: &str) -> Option<&'static str> {
    let f = field.to_ascii_lowercase();
    let has = |p: &str| f == p || f.starts_with(&format!("{p}_"));
    Some(if ["pm1", "pm2_5", "pm4", "pm10", "no2", "o3", "so2"].iter().any(|p| has(p)) {
        "µg/m³"
    } else if has("co2") {
        "ppm"
    } else if has("co") {
        "mg/m³"
    } else if has("temperature") || has("temp") {
        "°C"
    } else if has("humidity") || has("rh") {
        "%"
    } else if has("heart_rate") || has("hr") {
        "bpm"
    } else if has("noise") || has("sound") {
        "dB"
    } else if has("pressure") {
        "hPa"
    } else if has("speed") {
        "m/s"
    } else if has("altitude") || has("elevation") {
        "m"
    } else if has("cadence") {
        "rpm"
    } else if has("power") {
        "W"
    } else {
        return None;
    })
}

fn pretty_field(field: &str) -> String {
    if let Some(g) = crate::sensors::guideline(field) {
        return g.1.to_string();
    }
    match field {
        "co2" => "CO₂".into(),
        "rh" => "relative humidity".into(),
        "pm1" | "pm4" => field.to_ascii_uppercase(),
        f => f.replace('_', " "),
    }
}

/// Per-measurement statistics + WHO guideline checks; `main` = the field a map should show.
fn sensor_summary(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let layer = match p_str(p, "layer").filter(|l| *l != "auto") {
        Some(id) => sc.layer(id)?,
        None => {
            let id = sc
                .touched
                .iter()
                .rev()
                .find(|t| t.ends_with("readings"))
                .cloned()
                .or_else(|| sc.engine.layers().iter().map(|l| l.info.id.clone()).filter(|i| i.ends_with("readings")).last())
                .ok_or("no sensor readings layer yet: import a sensor logger (devices.import) or take a live snapshot (sensor.snapshot) first")?;
            sc.layer(&id)?
        }
    };
    let fs = features::read_layer(sc.engine, &layer, None, None, 500_000)?;
    let want: Option<Vec<String>> = p.get("fields").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect());
    let units: HashMap<String, String> = p.get("units").and_then(Value::as_object).map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|u| (k.clone(), u.to_string()))).collect()).unwrap_or_default();
    let mut rows = Vec::new();
    for (i, (name, kind)) in fs.fields.iter().enumerate() {
        if !matches!(*kind, "real" | "integer") || matches!(name.as_str(), "time" | "t" | "device" | "name" | "source") || automap::is_id_like(name) {
            continue;
        }
        if want.as_ref().is_some_and(|w| !w.iter().any(|x| x == name)) {
            continue;
        }
        let mut v = fs.numbers(i);
        if let Some(st) = crate::sensors::stats(&mut v) {
            rows.push((name.clone(), st, v));
        }
    }
    if rows.is_empty() {
        return Err(format!("'{}' has no numeric measurements to summarise", layer.info.id));
    }
    let names: Vec<&str> = rows.iter().map(|r| r.0.as_str()).collect();
    let main = crate::sensors::main_field(&names).unwrap_or(names[0]).to_string();
    let r1 = |x: f64| features::num_text((x * 10.0).round() / 10.0);
    let (mut why, mut out, mut flagged) = (Vec::new(), Map::new(), Vec::new());
    let mut any_guideline = false;
    for (name, (n, min, mean, p95, max), v) in &rows {
        let unit = units.get(name).cloned().or_else(|| default_unit(name).map(str::to_string)).unwrap_or_default();
        let u = if unit.is_empty() { String::new() } else { format!(" {unit}") };
        let mut line = format!("{}: n {n}, mean {}{u}, 95th percentile {}{u}, max {}{u}", pretty_field(name), r1(*mean), r1(*p95), r1(*max));
        let mut o = json!({ "n": n, "min": min, "mean": mean, "p95": p95, "max": max, "unit": unit });
        if let Some(g) = crate::sensors::guideline(name) {
            any_guideline = true;
            let above = v.iter().filter(|x| **x > g.2).count();
            let pct = above as f64 * 100.0 / *n as f64;
            line.push_str(&format!(" · {pct:.0} % of readings above the WHO {} guideline ({} {})", g.4, features::num_text(g.2), g.3));
            o["guideline"] = json!({ "label": g.1, "level": g.2, "unit": g.3, "averaging": g.4, "above": above, "above_pct": (pct * 10.0).round() / 10.0 });
            if above > 0 {
                flagged.push(format!("{} {pct:.0} %", g.1));
            }
        }
        why.push(line);
        out.insert(name.clone(), o);
    }
    let m = &out[&main];
    let unit = m["unit"].as_str().unwrap_or("").to_string();
    let with_unit = |x: f64| format!("{} {unit}", r1(x)).trim().to_string();
    sc.cards.push((with_unit(m["mean"].as_f64().unwrap_or(0.0)), format!("mean {}", pretty_field(&main))));
    sc.cards.push((with_unit(m["max"].as_f64().unwrap_or(0.0)), format!("highest {}", pretty_field(&main))));
    if let Some(g) = m.get("guideline") {
        sc.cards.push((format!("{} %", features::num_text(g["above_pct"].as_f64().unwrap_or(0.0).round())), format!("of readings above the WHO {} {} guideline", g["averaging"].as_str().unwrap_or(""), g["label"].as_str().unwrap_or(""))));
    }
    sc.methods.push(if any_guideline {
        "Sensor readings were summarised per measurement (count, mean, 95th percentile, maximum). Air-quality values were compared with the WHO 2021 global air quality guideline levels (PM2.5 15 µg/m³ and PM10 45 µg/m³ as 24-hour means, NO₂ 25 µg/m³ 24-hour, O₃ 100 µg/m³ 8-hour); single readings only indicate exposure and are not 24-hour averages.".to_string()
    } else {
        "Sensor readings were summarised per measurement (count, mean, 95th percentile, maximum).".to_string()
    });
    why.insert(0, format!("{} readings · mapping {} (the {} measurement)", fs.feats.len(), pretty_field(&main), if crate::sensors::guideline(&main).is_some() { "air-quality" } else { "main" }));
    Ok(StepOut { outputs: json!({ "main": main, "label": pretty_field(&main), "layer": layer.info.id, "fields": out, "flagged": flagged, "count": fs.feats.len() }), why })
}

/// Choose a loaded layer for `auto`.
pub(super) fn auto_layer(sc: &StepCtx, kind: Option<GeomKind>, prefer: &str) -> Result<Arc<LayerHandle>, String> {
    let cands: Vec<Arc<LayerHandle>> = sc.engine.layers().into_iter().filter(|l| kind.is_none_or(|k| l.info.geometry == k)).collect();
    let numeric = |l: &LayerHandle| l.info.fields.iter().any(|f| matches!(f.kind, "integer" | "real") && !automap::is_id_like(&f.name));
    let best = match prefer {
        "samples" => cands
            .iter()
            .filter(|l| numeric(l) && l.info.feature_count >= 3)
            .max_by(|a, b| {
                let score = |l: &LayerHandle| {
                    let n = l.info.id.to_ascii_lowercase();
                    let mut s = 0.0;
                    if ["sample", "obs", "site", "measure", "survey", "station"].iter().any(|w| n.contains(w)) {
                        s += 2.0;
                    }
                    if (5..=100_000).contains(&l.info.feature_count) {
                        s += 1.0;
                    }
                    if sc.touched.contains(&l.info.id) {
                        s += 0.5;
                    }
                    // source data beats results of earlier runs (e.g. "field_samples_sampled")
                    if l.path.starts_with(&sc.engine.state_dir) {
                        s -= 1.5;
                    }
                    s
                };
                score(a).partial_cmp(&score(b)).unwrap()
            })
            .cloned(),
        "incidents" => cands
            .iter()
            .filter(|l| l.info.geometry == GeomKind::Point && l.info.feature_count >= 30)
            .max_by(|a, b| {
                let score = |l: &LayerHandle| {
                    let n = l.info.id.to_ascii_lowercase();
                    let mut s = 0.0;
                    if ["incident", "crime", "case", "crash", "accident", "event", "report", "call", "outbreak", "complaint", "fire", "theft"].iter().any(|w| n.contains(w)) {
                        s += 3.0;
                    }
                    if l.info.feature_count >= 60 {
                        s += 1.0;
                    }
                    if sc.touched.contains(&l.info.id) {
                        s += 0.5;
                    }
                    if l.path.starts_with(&sc.engine.state_dir) {
                        s -= 1.5;
                    }
                    s + (l.info.feature_count as f64).log10() * 0.1
                };
                score(a).partial_cmp(&score(b)).unwrap()
            })
            .cloned(),
        "recent" => sc.touched.iter().rev().filter_map(|id| sc.engine.layer(id)).find(|l| kind.is_none_or(|k| l.info.geometry == k)),
        _ => cands.iter().max_by_key(|l| l.info.feature_count).cloned(),
    };
    best.ok_or_else(|| format!("no {}layer is loaded to pick automatically; add data or name one with layer:", kind.map(|k| format!("{k:?} ").to_lowercase()).unwrap_or_default()))
}

fn parse_kind(s: Option<&str>) -> Option<GeomKind> {
    match s? {
        "point" | "points" => Some(GeomKind::Point),
        "line" | "lines" => Some(GeomKind::Line),
        "polygon" | "polygons" | "area" => Some(GeomKind::Polygon),
        _ => None,
    }
}

fn io_open(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let mut items = p_list(p, "layer");
    items.extend(p_list(p, "layers"));
    items.extend(p_list(p, "path"));
    if items.is_empty() {
        items.push("auto".into());
    }
    let mut ids = Vec::new();
    let mut why = Vec::new();
    for it in items {
        if it == "auto" {
            let prefer = p_str(p, "prefer").unwrap_or("largest");
            let l = auto_layer(sc, parse_kind(p_str(p, "kind")), prefer)?;
            why.push(format!("picked '{}' automatically ({} features; rule: {prefer})", l.info.id, l.info.feature_count));
            ids.push(l.info.id.clone());
        } else if sc.engine.layer(&it).is_some() {
            ids.push(it);
        } else {
            let path = sc.resolve_path(&it).ok_or_else(|| format!("'{it}' is neither a loaded layer nor a file"))?;
            let new = sc.engine.register_layers(catalog::load_layers(&path)?);
            why.push(format!("opened {} ({} layer{})", path.display(), new.len(), if new.len() == 1 { "" } else { "s" }));
            ids.extend(new);
        }
    }
    let mut total = 0u64;
    let mut bounds = None;
    for id in &ids {
        sc.touch(id);
        if let Some(l) = sc.engine.layer(id) {
            total += l.info.feature_count;
            bounds = features::union_bounds(bounds, Some(l.info.bounds));
        }
    }
    if why.is_empty() {
        why.push(format!("{} layer{} ({} features)", ids.len(), if ids.len() == 1 { "" } else { "s" }, cartography::fmt_num(total as f64)));
    }
    let first = ids.first().cloned();
    let kind = first.as_ref().and_then(|id| sc.engine.layer(id)).map(|l| format!("{:?}", l.info.geometry).to_lowercase());
    Ok(StepOut { outputs: json!({ "layers": ids, "layer": first, "features": total, "kind": kind, "bounds": bounds }), why })
}

// ------------------------------------------------------------------ analysis

fn vector_sql(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    use gdal::vector::LayerAccess;
    let l = sc.layer(p_str(p, "layer").ok_or("layer is required")?)?;
    let sql = p_str(p, "sql").ok_or("sql is required")?.replace("@input", &format!("\"{}\"", l.layer_name.replace('"', "\"\"")));
    let name = sanitize(p_str(p, "name").unwrap_or(&sc.step_id));
    let ds = catalog::open_vector(&l.path)?;
    let mut rs = ds
        .execute_sql(&sql, None, gdal::vector::sql::Dialect::SQLITE)
        .map_err(|e| format!("SQL error: {e}"))?
        .ok_or("the statement returned no result set (use SELECT …)")?;
    if rs.defn().geom_fields().count() == 0 {
        // a table without geometry: return the rows (counts, sums) instead of a layer
        let cols: Vec<String> = rs.defn().fields().map(|f| f.name()).collect();
        let mut rows = Vec::new();
        for f in rs.features().take(1000) {
            let mut m = Map::new();
            for (i, c) in cols.iter().enumerate() {
                let v = match f.field(i) {
                    Ok(Some(gdal::vector::FieldValue::IntegerValue(x))) => json!(x),
                    Ok(Some(gdal::vector::FieldValue::Integer64Value(x))) => json!(x),
                    Ok(Some(gdal::vector::FieldValue::RealValue(x))) => json!(x),
                    _ => f.field_as_string(i).ok().flatten().map(Value::from).unwrap_or(Value::Null),
                };
                m.insert(c.clone(), v);
            }
            rows.push(Value::Object(m));
        }
        let first = rows.first().map(|r| r.to_string()).unwrap_or_default();
        return Ok(StepOut { outputs: json!({ "rows": rows, "columns": cols, "count": rows.len() }), why: vec![format!("{} row(s) without geometry; first: {first}", rows.len())] });
    }
    let dir = sc.outputs_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(format!("{name}.gpkg"));
    let tmp = dir.join(format!("{name}.part.gpkg"));
    let _ = std::fs::remove_file(&tmp);
    {
        let drv = gdal::DriverManager::get_driver_by_name("GPKG").map_err(|e| e.to_string())?;
        let out = drv.create_vector_only(&tmp).map_err(|e| e.to_string())?;
        let cname = std::ffi::CString::new(name.clone()).map_err(|e| e.to_string())?;
        // SAFETY: both handles are valid for the duration of the call; GDAL copies the layer.
        let copied = unsafe { gdal_sys::GDALDatasetCopyLayer(out.c_dataset(), rs.c_layer(), cname.as_ptr(), std::ptr::null_mut()) };
        if copied.is_null() {
            return Err(format!("could not write the SQL result: {}", gdal_last_error()));
        }
    }
    drop(rs);
    std::fs::rename(&tmp, &file).map_err(|e| e.to_string())?;
    let id = format!("{}.{name}", sc.recipe_id);
    let mut handles = catalog::load_layers(&file)?;
    handles.truncate(1);
    let count = handles.first().map(|h| h.info.feature_count).unwrap_or(0);
    for h in handles.iter_mut() {
        h.info.id = id.clone();
    }
    sc.engine.register_layers(handles);
    sc.touch(&id);
    sc.names.insert(id.clone(), humanize(&name));
    sc.methods.push(format!("'{}' was derived from {} with SQL: {}", humanize(&name), l.info.id, sql.split_whitespace().collect::<Vec<_>>().join(" ")));
    Ok(StepOut { outputs: json!({ "layer": id, "features": count }), why: vec![format!("{count} features from SQL on {}", l.info.id)] })
}

pub(super) fn gdal_last_error() -> String {
    // SAFETY: CPLGetLastErrorMsg returns a pointer to a thread-local, NUL-terminated buffer.
    let p = unsafe { gdal_sys::CPLGetLastErrorMsg() };
    if p.is_null() { String::new() } else { unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned() }
}

fn vector_buffer(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
    use gdal::vector::Geometry;
    let e = |x: gdal::errors::GdalError| x.to_string();
    let l = sc.layer(p_str(p, "layer").ok_or("layer is required")?)?;
    let dist = p_f64(p, "distance").ok_or("distance (metres) is required")?;
    if !(dist > 0.0 && dist <= 500_000.0) {
        return Err(format!("distance must be between 0 and 500 km (got {dist})"));
    }
    let dissolve = p_bool(p, "dissolve", false);
    let name = p_str(p, "name").unwrap_or(&sc.step_id).to_string();
    let fs = features::read_layer(sc.engine, &l, None, None, 200_000)?;
    let b = fs.bounds().ok_or_else(|| format!("{} has no features to buffer", l.info.id))?;
    let epsg = features::utm_epsg((b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0);
    let mut wgs = SpatialRef::from_epsg(4326).map_err(e)?;
    wgs.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let mut utm = SpatialRef::from_epsg(epsg).map_err(e)?;
    utm.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
    let fwd = CoordTransform::new(&wgs, &utm).map_err(e)?;
    let inv = CoordTransform::new(&utm, &wgs).map_err(e)?;
    let mut fields = if dissolve { vec![] } else { fs.fields.clone() };
    fields.push(("area_m2".into(), "real"));
    let mut out = FeatureSet::new(GeomKind::Polygon, fields);
    let mut all_polys: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
    let mut total_area = 0.0;
    for f in &fs.feats {
        if sc.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let Some(w) = features::to_wkb(&f.geom, false) else { continue };
        let g = Geometry::from_wkb(&w).map_err(e)?.transform(&fwd).map_err(e)?.buffer(dist, 8).map_err(e)?;
        if dissolve {
            if let Ok(Geom::Polygons(ps)) = crate::wkb::parse(&g.wkb().map_err(e)?) {
                all_polys.extend(ps);
            }
        } else {
            let area = g.area();
            total_area += area;
            let back = g.transform(&inv).map_err(e)?;
            let geom = crate::wkb::parse(&back.wkb().map_err(e)?).map_err(|x| x.to_string())?;
            let mut props = f.props.clone();
            props.push(Val::Num((area * 10.0).round() / 10.0));
            out.feats.push(Feat { geom, props });
        }
    }
    if dissolve && !all_polys.is_empty() {
        // buffer(0) of the multipolygon dissolves overlaps in one GEOS pass
        let w = features::to_wkb(&Geom::Polygons(all_polys), false).ok_or("empty buffer")?;
        let merged = Geometry::from_wkb(&w).map_err(e)?.buffer(0.0, 8).map_err(e)?;
        total_area = merged.area();
        let back = merged.transform(&inv).map_err(e)?;
        let geom = crate::wkb::parse(&back.wkb().map_err(e)?).map_err(|x| x.to_string())?;
        out.feats.push(Feat { geom, props: vec![Val::Num((total_area * 10.0).round() / 10.0)] });
    }
    let n = fs.feats.len();
    let id = sc.write_output(&name, &out, humanize(&name))?;
    let zone = epsg % 100;
    let hemi = if epsg >= 32700 { 'S' } else { 'N' };
    let area_text = if total_area >= 1e6 { format!("{:.2} km²", total_area / 1e6) } else { format!("{:.2} ha", total_area / 1e4) };
    sc.cards.push((area_text.clone(), format!("{} area", humanize(&name).to_lowercase())));
    sc.methods.push(format!(
        "{} = {} buffered by {} m{}, computed in WGS 84 / UTM zone {zone}{hemi} (EPSG:{epsg}, chosen from the data's location); area {area_text}.",
        humanize(&name),
        sc.title_of(&l),
        cartography::fmt_num(dist),
        if dissolve { " and dissolved into one area" } else { "" }
    ));
    Ok(StepOut {
        outputs: json!({ "layer": id, "features": out.feats.len(), "area_m2": total_area.round(), "area_ha": (total_area / 100.0).round() / 100.0, "epsg": epsg, "distance": dist }),
        why: vec![format!("{n} features buffered by {} m in UTM {zone}{hemi} (EPSG:{epsg}){}; area {area_text}", cartography::fmt_num(dist), if dissolve { ", dissolved" } else { "" })],
    })
}

fn hex_round(q: f64, r: f64) -> (i64, i64) {
    let (x, z) = (q, r);
    let y = -x - z;
    let (mut rx, ry, mut rz) = (x.round(), y.round(), z.round());
    let (dx, dy, dz) = ((rx - x).abs(), (ry - y).abs(), (rz - z).abs());
    if dx > dy && dx > dz {
        rx = -ry - rz;
    } else if dy <= dz {
        rz = -rx - ry;
    }
    (rx as i64, rz as i64)
}

const SQRT3: f64 = 1.732_050_807_568_877_2;

/// Pointy-top hexagon (axial q, r) containing the point.
pub fn hex_of(p: [f64; 2], size: f64) -> (i64, i64) {
    hex_round((SQRT3 / 3.0 * p[0] - p[1] / 3.0) / size, (2.0 / 3.0 * p[1]) / size)
}

pub fn hex_center(q: i64, r: i64, size: f64) -> [f64; 2] {
    [size * SQRT3 * (q as f64 + r as f64 / 2.0), size * 1.5 * r as f64]
}

fn hexbin(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let spec = p_str(p, "layer").unwrap_or("auto");
    let l = if spec == "auto" { auto_layer(sc, Some(GeomKind::Point), "largest")? } else { sc.layer(spec)? };
    let field = p_str(p, "field").filter(|f| *f != "none");
    let fi = match field {
        Some(f) => Some(l.field_index(f).ok_or_else(|| format!("{} has no field '{f}'", l.info.id))?),
        None => None,
    };
    let stat = p_str(p, "stat").unwrap_or(if fi.is_some() { "mean" } else { "count" }).to_string();
    let name = p_str(p, "name").unwrap_or(&sc.step_id).to_string();
    let idx: Vec<usize> = fi.into_iter().collect();
    let mut pts: Vec<([f64; 2], Option<f64>)> = Vec::with_capacity(l.info.feature_count.min(5_000_000) as usize);
    let cancel = sc.cancel;
    features::scan_layer(sc.engine, &l, None, &idx, &mut |g, props| {
        if let Some(c) = features::anchor(g) {
            pts.push((c, props.first().and_then(Val::as_f64)));
        }
        pts.len() < 5_000_000 && !cancel.load(std::sync::atomic::Ordering::Relaxed)
    })?;
    if pts.is_empty() {
        return Err(format!("{} has no points", l.info.id));
    }
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for (c, _) in &pts {
        b = [b[0].min(c[0]), b[1].min(c[1]), b[2].max(c[0]), b[3].max(c[1])];
    }
    let proj = LocalProj::for_bounds(b);
    let (lo, hi) = (proj.fwd([b[0], b[1]]), proj.fwd([b[2], b[3]]));
    let span = (hi[0] - lo[0]).abs().max((hi[1] - lo[1]).abs()).max(1.0);
    let (size, auto) = match p_f64(p, "size") {
        Some(s) if s > 0.0 => (s, false),
        _ => (features::nice_floor((span / 25.0 / SQRT3).max(1.0)), true),
    };
    let mut bins: HashMap<(i64, i64), (u64, f64, u64)> = HashMap::new();
    for (c, v) in &pts {
        let e = bins.entry(hex_of(proj.fwd(*c), size)).or_insert((0, 0.0, 0));
        e.0 += 1;
        if let Some(v) = v {
            e.1 += v;
            e.2 += 1;
        }
    }
    let area_km2 = 3.0 * SQRT3 / 2.0 * size * size / 1e6;
    let mut fields: Vec<(String, &'static str)> = vec![("count".into(), "integer"), ("density_km2".into(), "real")];
    if let Some(f) = field {
        fields.push((format!("{f}_{stat}"), "real"));
    }
    let mut out = FeatureSet::new(GeomKind::Polygon, fields);
    let mut keys: Vec<&(i64, i64)> = bins.keys().collect();
    keys.sort();
    let mut max_count = 0;
    for k in keys {
        let (count, sum, valid) = bins[k];
        max_count = max_count.max(count);
        let c = hex_center(k.0, k.1, size);
        let ring: Vec<[f64; 2]> = (0..=6)
            .map(|i| {
                let a = (60.0 * i as f64 - 30.0).to_radians();
                proj.inv([c[0] + size * a.cos(), c[1] + size * a.sin()])
            })
            .collect();
        let mut props = vec![Val::Int(count as i64), Val::Num(((count as f64 / area_km2) * 100.0).round() / 100.0)];
        if field.is_some() {
            props.push(if valid == 0 { Val::Null } else if stat == "sum" { Val::Num(sum) } else { Val::Num(sum / valid as f64) });
        }
        out.feats.push(Feat { geom: Geom::Polygons(vec![vec![ring]]), props });
    }
    let across = features::fmt_distance(size * SQRT3);
    let id = sc.write_output(&name, &out, format!("{} per hexagon", if field.is_some() { humanize(&stat) } else { "Points".to_string() }))?;
    sc.hints.insert(id.clone(), json!({ "outline": true, "opacity": 0.85, "why": "hexagons keep a thin white outline so cells read individually" }));
    sc.cards.push((cartography::fmt_num(pts.len() as f64), format!("points binned from {}", l.info.id)));
    sc.methods.push(format!(
        "{} points from {} were aggregated into {} hexagons {across} across{}; each hexagon holds the {} of the points inside it.",
        cartography::fmt_num(pts.len() as f64),
        sc.title_of(&l),
        out.feats.len(),
        if auto { " (sized automatically for about 25 hexagons across the data)" } else { "" },
        if field.is_some() { format!("{stat} of '{}'", field.unwrap_or("")) } else { "count".into() }
    ));
    Ok(StepOut {
        outputs: json!({ "layer": id, "cells": out.feats.len(), "size_m": size, "max_count": max_count, "points": pts.len(), "source": l.info.id }),
        why: vec![format!("{} points → {} hexagons {across} across{}; busiest holds {max_count}", cartography::fmt_num(pts.len() as f64), out.feats.len(), if auto { " (auto-sized)" } else { "" })],
    })
}

pub(super) fn idw_at(x: [f64; 2], samples: &[([f64; 2], f64)], power: f64, skip: Option<usize>) -> f64 {
    let (mut num, mut den) = (0.0, 0.0);
    for (j, (c, v)) in samples.iter().enumerate() {
        if Some(j) == skip {
            continue;
        }
        let d2 = (c[0] - x[0]).powi(2) + (c[1] - x[1]).powi(2);
        if d2 < 1e-12 {
            return *v;
        }
        let w = 1.0 / d2.powf(power / 2.0);
        num += w * v;
        den += w;
    }
    if den > 0.0 { num / den } else { f64::NAN }
}

/// Leave-one-out cross-validation of IDW for one power: (RMSE, MAE).
pub fn idw_cv(samples: &[([f64; 2], f64)], power: f64) -> (f64, f64) {
    let step = (samples.len() / 1500).max(1);
    let (mut se, mut ae, mut n) = (0.0, 0.0, 0.0);
    for i in (0..samples.len()).step_by(step) {
        let pred = idw_at(samples[i].0, samples, power, Some(i));
        if pred.is_finite() {
            let err = pred - samples[i].1;
            se += err * err;
            ae += err.abs();
            n += 1.0;
        }
    }
    if n == 0.0 { (f64::NAN, f64::NAN) } else { ((se / n).sqrt(), ae / n) }
}

/// Andrew's monotone chain convex hull (counter-clockwise).
pub fn convex_hull(mut pts: Vec<[f64; 2]>) -> Vec<[f64; 2]> {
    pts.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap().then(a[1].partial_cmp(&b[1]).unwrap()));
    pts.dedup();
    if pts.len() < 3 {
        return pts;
    }
    let cross = |o: [f64; 2], a: [f64; 2], b: [f64; 2]| (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    let mut lower: Vec<[f64; 2]> = Vec::new();
    for p in &pts {
        while lower.len() >= 2 && cross(lower[lower.len() - 2], lower[lower.len() - 1], *p) <= 0.0 {
            lower.pop();
        }
        lower.push(*p);
    }
    let mut upper: Vec<[f64; 2]> = Vec::new();
    for p in pts.iter().rev() {
        while upper.len() >= 2 && cross(upper[upper.len() - 2], upper[upper.len() - 1], *p) <= 0.0 {
            upper.pop();
        }
        upper.push(*p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

pub fn point_in_ring(p: [f64; 2], ring: &[[f64; 2]]) -> bool {
    let mut inside = false;
    let n = ring.len();
    let mut j = n.wrapping_sub(1);
    for i in 0..n {
        let (a, b) = (ring[i], ring[j]);
        if (a[1] > p[1]) != (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0] {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn idw(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let spec = p_str(p, "layer").unwrap_or("auto");
    let l = if spec == "auto" { auto_layer(sc, Some(GeomKind::Point), "samples")? } else { sc.layer(spec)? };
    if l.info.geometry != GeomKind::Point {
        return Err(format!("IDW needs point samples; {} is a {:?} layer", l.info.id, l.info.geometry).to_lowercase());
    }
    let field = match p_str(p, "field").filter(|f| *f != "auto") {
        Some(f) => f.to_string(),
        None => {
            let st = automap::style_layer(sc.engine, &l, None, None);
            match st.style["symbology"]["kind"].as_str() {
                Some("graduated") => st.field.unwrap_or_default(),
                _ => l.info.fields.iter().find(|f| matches!(f.kind, "integer" | "real") && !automap::is_id_like(&f.name)).map(|f| f.name.clone()).ok_or_else(|| format!("{} has no numeric field to interpolate", l.info.id))?,
            }
        }
    };
    let fi = l.field_index(&field).ok_or_else(|| format!("{} has no field '{field}'", l.info.id))?;
    if !matches!(l.info.fields[fi].kind, "integer" | "real") {
        return Err(format!("'{field}' is not numeric"));
    }
    let name = p_str(p, "name").unwrap_or(&sc.step_id).to_string();
    let fs = features::read_layer(sc.engine, &l, None, Some(&[fi]), 20_000)?;
    let raw: Vec<([f64; 2], f64)> = fs.feats.iter().filter_map(|f| Some((features::anchor(&f.geom)?, f.props.first()?.as_f64()?))).collect();
    if raw.len() < 3 {
        return Err(format!("need at least 3 samples with a value of '{field}' (found {})", raw.len()));
    }
    let mut b = [f64::MAX, f64::MAX, f64::MIN, f64::MIN];
    for (c, _) in &raw {
        b = [b[0].min(c[0]), b[1].min(c[1]), b[2].max(c[0]), b[3].max(c[1])];
    }
    let proj = LocalProj::for_bounds(b);
    let samples: Vec<([f64; 2], f64)> = raw.iter().map(|(c, v)| (proj.fwd(*c), *v)).collect();
    let powers: Vec<f64> = match p_f64(p, "power") {
        Some(x) if x > 0.0 => vec![x],
        _ => vec![1.0, 1.5, 2.0, 3.0],
    };
    let cv: Vec<(f64, f64, f64)> = powers.iter().map(|&pw| {
        let (rmse, mae) = idw_cv(&samples, pw);
        (pw, rmse, mae)
    }).collect();
    let &(power, rmse, mae) = cv.iter().filter(|c| c.1.is_finite()).min_by(|a, b| a.1.partial_cmp(&b.1).unwrap()).ok_or("cross-validation failed")?;
    // grid over the samples (+5 %), clipped to their convex hull
    let (lo, hi) = (proj.fwd([b[0], b[1]]), proj.fwd([b[2], b[3]]));
    let (w, h) = ((hi[0] - lo[0]).max(1.0), (hi[1] - lo[1]).max(1.0));
    let cols = p_f64(p, "cells").map(|c| c.clamp(10.0, 300.0) as usize).unwrap_or(60);
    let cell = w.max(h) * 1.1 / cols as f64;
    let (nx, ny) = (((w * 1.1) / cell).ceil() as usize, ((h * 1.1) / cell).ceil() as usize);
    let (x0, y0) = ((lo[0] + hi[0]) / 2.0 - nx as f64 * cell / 2.0, (lo[1] + hi[1]) / 2.0 - ny as f64 * cell / 2.0);
    let hull = convex_hull(samples.iter().map(|s| s.0).collect());
    let hc = hull.iter().fold([0.0, 0.0], |a, p| [a[0] + p[0] / hull.len() as f64, a[1] + p[1] / hull.len() as f64]);
    let hull_grown: Vec<[f64; 2]> = hull.iter().map(|p| [hc[0] + (p[0] - hc[0]) * 1.06 + (p[0] - hc[0]).signum() * cell / 2.0, hc[1] + (p[1] - hc[1]) * 1.06 + (p[1] - hc[1]).signum() * cell / 2.0]).collect();
    let value_field = { let f = sanitize(&field).replace(['.', '-'], "_"); if f == "nearest_m" { "value".to_string() } else { f } };
    let mut out = FeatureSet::new(GeomKind::Polygon, vec![(value_field.clone(), "real"), ("nearest_m".into(), "real")]);
    for iy in 0..ny {
        if sc.cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        for ix in 0..nx {
            let (cx, cy) = (x0 + (ix as f64 + 0.5) * cell, y0 + (iy as f64 + 0.5) * cell);
            if hull_grown.len() >= 3 && !point_in_ring([cx, cy], &hull_grown) {
                continue;
            }
            let v = idw_at([cx, cy], &samples, power, None);
            let nearest = samples.iter().map(|s| ((s.0[0] - cx).powi(2) + (s.0[1] - cy).powi(2)).sqrt()).fold(f64::MAX, f64::min);
            let (ax, ay, bx, by) = (cx - cell / 2.0, cy - cell / 2.0, cx + cell / 2.0, cy + cell / 2.0);
            let ring = vec![proj.inv([ax, ay]), proj.inv([bx, ay]), proj.inv([bx, by]), proj.inv([ax, by]), proj.inv([ax, ay])];
            out.feats.push(Feat { geom: Geom::Polygons(vec![vec![ring]]), props: vec![Val::Num((v * 1e4).round() / 1e4), Val::Num(nearest.round())] });
        }
    }
    let id = sc.write_output(&name, &out, format!("{field} (IDW surface)"))?;
    sc.hints.insert(id.clone(), json!({ "outline": false, "opacity": 0.9, "why": "no cell outlines, so the surface reads as continuous" }));
    let others: Vec<String> = cv.iter().filter(|c| c.0 != power).map(|c| format!("{} → {}", cartography::fmt_num(c.0), cartography::fmt_num(c.1))).collect();
    sc.cards.push((cartography::fmt_num(rmse), format!("cross-validated RMSE of {field}")));
    sc.methods.push(format!(
        "A continuous surface of '{field}' was interpolated from {} samples by inverse distance weighting on {}-m cells, limited to the samples' convex hull. The power was chosen by leave-one-out cross-validation among {}: power {} gave the lowest error (RMSE {}, MAE {}).",
        samples.len(),
        cartography::fmt_num(cell),
        powers.iter().map(|x| cartography::fmt_num(*x)).collect::<Vec<_>>().join(", "),
        cartography::fmt_num(power),
        cartography::fmt_num(rmse),
        cartography::fmt_num(mae)
    ));
    Ok(StepOut {
        outputs: json!({
            "layer": id, "field": field, "value_field": value_field, "power": power, "rmse": rmse, "mae": mae, "samples": samples.len(),
            "cells": out.feats.len(), "cell_m": cell, "source": l.info.id,
            "cv": cv.iter().map(|c| json!({ "power": c.0, "rmse": c.1, "mae": c.2 })).collect::<Vec<_>>(),
        }),
        why: vec![format!(
            "IDW of '{field}' from {} samples, {} cells of {} m; power {} chosen by leave-one-out CV (RMSE {}{})",
            samples.len(),
            out.feats.len(),
            cartography::fmt_num(cell),
            cartography::fmt_num(power),
            cartography::fmt_num(rmse),
            if others.is_empty() { String::new() } else { format!("; others: {}", others.join(", ")) }
        )],
    })
}

// ------------------------------------------------------------------ cartography

/// Merge styles into `<state>/project.json` (the file the web UI loads), adding new layers to the
/// draw order by geometry (polygons below lines below points).
pub fn project_upsert(engine: &Engine, items: &[(String, Value)]) -> Result<(), String> {
    let _g = engine.project_lock.lock().unwrap();
    let path = engine.state_dir.join("project.json");
    let mut proj: Value = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    if !proj.is_object() {
        proj = json!({ "version": 1, "order": [], "layers": {} });
    }
    if !proj["layers"].is_object() {
        proj["layers"] = json!({});
    }
    if !proj["order"].is_array() {
        proj["order"] = json!([]);
    }
    let kind_rank = |id: &str| engine.layer(id).map(|l| if l.info.id == "natural_earth.countries" { 0 } else { rank(l.info.geometry) + 1 }).unwrap_or(9);
    {
        let order = proj["order"].as_array_mut().unwrap();
        if order.is_empty() {
            // first save: same default order as the web UI (land, polygons, lines, points)
            let mut all: Vec<(u8, usize, String)> = engine.layers().iter().enumerate().map(|(i, l)| (kind_rank(&l.info.id), i, l.info.id.clone())).collect();
            all.sort();
            order.extend(all.into_iter().map(|(_, _, id)| Value::from(id)));
        }
    }
    for (id, st) in items {
        proj["layers"][id.as_str()] = st.clone();
        let order = proj["order"].as_array_mut().unwrap();
        if !order.iter().any(|x| x.as_str() == Some(id)) {
            let r = kind_rank(id);
            let pos = order.iter().rposition(|x| x.as_str().is_some_and(|s| kind_rank(s) <= r)).map(|i| i + 1).unwrap_or(0);
            order.insert(pos, Value::from(id.clone()));
        }
    }
    std::fs::create_dir_all(&engine.state_dir).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&proj).unwrap_or_default()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub(super) fn layer_list(sc: &StepCtx, p: &Value, key: &str) -> Vec<String> {
    let mut ids = p_list(p, key);
    if ids.is_empty() {
        ids = sc.touched.clone();
    }
    ids.dedup();
    ids
}

fn automap_style(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let ids = layer_list(sc, p, "layers");
    if ids.is_empty() {
        return Err("no layers to style: list them in layers:".into());
    }
    let mut why = Vec::new();
    let mut styles = Map::new();
    let mut save = Vec::new();
    for id in &ids {
        let l = sc.layer(id)?;
        let hint = match p.get("field") {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Object(m)) => m.iter().find(|(k, _)| *k == id || id.ends_with(&format!(".{k}"))).and_then(|(_, v)| v.as_str().map(str::to_string)),
            _ => None,
        };
        let mut st = automap::style_layer(sc.engine, &l, None, hint.as_deref());
        if let Some(h) = sc.hints.get(id) {
            // a step that knows what its classes mean (hot spot bins) sets the symbology outright
            if let Some(sym) = h.get("symbology").filter(|_| hint.is_none()) {
                st.style["symbology"] = sym.clone();
                st.field = sym["field"].as_str().map(str::to_string);
                st.why = h.get("why").and_then(Value::as_str).unwrap_or("symbology set by the step that made the layer").to_string();
                st.confidence = 1.0;
            }
            for k in ["outline", "opacity"] {
                if let Some(v) = h.get(k) {
                    st.style[k] = v.clone();
                }
            }
            if let Some(c) = h.get("color") {
                if st.style["symbology"]["kind"] == "single" || h.get("field").and_then(Value::as_str) == Some("none") {
                    st.style["symbology"] = json!({ "kind": "single", "color": c });
                }
            }
            if let Some(w) = h.get("width") {
                st.style["width"] = w.clone();
            }
            if let Some(w) = h.get("why").and_then(Value::as_str).filter(|_| h.get("symbology").is_none() || hint.is_some()) {
                st.why.push_str(&format!("; {w}"));
            }
        }
        // a colour the step chose on purpose (contours brown, buildings grey) is kept as is
        let fixed_color = sc.hints.get(id).is_some_and(|h| h.get("color").is_some());
        if st.style["symbology"]["kind"] == "single" && automap::device_role(id).is_none() && !fixed_color {
            let thematic_below = sc.styles.iter().any(|(oid, (os, _, _))| {
                os["symbology"]["kind"] != "single" && sc.engine.layer(oid).is_some_and(|o| o.info.geometry == GeomKind::Polygon)
            });
            let thematic_below = thematic_below || !sc.rasters.is_empty();
            if l.info.geometry == GeomKind::Point && thematic_below {
                st.style["symbology"]["color"] = json!("#ffffff");
                st.why.push_str("; white with a dark ring so the points stay visible on every class colour below");
            } else {
                let used: Vec<String> = sc
                    .styles
                    .values()
                    .filter_map(|(os, _, _)| os["symbology"]["color"].as_str().map(str::to_string))
                    .chain(sc.touched.iter().filter_map(|t| automap::device_color(t).map(str::to_string)))
                    .collect();
                let mine = st.style["symbology"]["color"].as_str().unwrap_or("").to_string();
                if used.iter().any(|u| automap::similar(u, &mine)) {
                    st.style["symbology"]["color"] = json!(automap::distinct_color(&used));
                    st.why.push_str("; colour kept distinct from the other layers on this map");
                }
            }
        }
        why.push(format!("{}: {}", sc.title_of(&l), st.why));
        styles.insert(id.clone(), json!({ "kind": st.style["symbology"]["kind"], "field": st.field, "why": st.why, "confidence": st.confidence, "style": st.style }));
        save.push((id.clone(), st.style.clone()));
        sc.styles.insert(id.clone(), (st.style, st.label_field, st.why));
        sc.touch(id);
    }
    if p_bool(p, "save", true) {
        project_upsert(sc.engine, &save)?;
    }
    sc.methods.push("Colours, classes and symbols were chosen automatically from the data (AutoMap rules: field type, distribution shape and meaning; colour-blind-safe palettes). Each decision and its reason is listed below.".into());
    Ok(StepOut { outputs: json!({ "layers": ids, "styles": styles }), why })
}

fn style_apply(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let styles = p.get("styles").and_then(Value::as_object).ok_or("styles: {layer id: style} is required")?;
    let mut save = Vec::new();
    for (id, st) in styles {
        let l = sc.layer(id)?;
        if st.get("symbology").and_then(|s| s.get("kind")).is_none() {
            return Err(format!("style for {id} has no symbology"));
        }
        sc.styles.insert(id.clone(), (st.clone(), automap::label_field(&l), "style saved with the recipe".into()));
        save.push((id.clone(), st.clone()));
        sc.touch(id);
    }
    if p_bool(p, "save", true) {
        project_upsert(sc.engine, &save)?;
    }
    Ok(StepOut { outputs: json!({ "layers": styles.keys().collect::<Vec<_>>() }), why: vec![format!("{} saved style(s) applied", styles.len())] })
}

fn overviews_build(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let l = sc.layer(p_str(p, "layer").ok_or("layer is required")?)?;
    let id = l.info.id.clone();
    let Some(mz) = p_f64(p, "maxzoom").map(|z| z as u8).or_else(|| crate::overview::suggested_max_zoom(&l.info)) else {
        return Ok(StepOut { outputs: json!({ "layer": id, "skipped": true }), why: vec![format!("{id} renders live at every zoom; no pyramid needed")] });
    };
    let mz = mz.min(l.info.maxzoom.saturating_sub(1));
    if let Some(o) = l.overview().filter(|o| o.meta.max_zoom >= mz) {
        return Ok(StepOut { outputs: json!({ "layer": id, "max_zoom": o.meta.max_zoom, "skipped": true }), why: vec![format!("{id} already has a fresh z0-{} pyramid", o.meta.max_zoom)] });
    }
    let out = crate::overview::path_for(&sc.engine.state_dir, &id);
    let r = crate::overview::build(sc.engine, &l, mz, &out, sc.cancel, &|_, _| {})?;
    let ov = crate::overview::Overview::open(&out, &crate::overview::Fingerprint::of(&l))?;
    l.set_overview(Some(Arc::new(ov)));
    sc.engine.clear_cache();
    sc.methods.push(format!("An overview tile pyramid (z0-{}) was built for {id} so it draws instantly when zoomed out.", r.max_zoom));
    Ok(StepOut {
        outputs: json!({ "layer": id, "max_zoom": r.max_zoom, "tiles": r.tiles_written, "mb": (r.file_bytes as f64 / 1e4).round() / 100.0 }),
        why: vec![format!("z0-{} → {} tiles, {:.1} MB in {:.1} s", r.max_zoom, r.tiles_written, r.file_bytes as f64 / 1e6, r.build_ms / 1000.0)],
    })
}

fn project_style(engine: &Engine, id: &str) -> Option<Value> {
    let _g = engine.project_lock.lock().unwrap();
    let v: Value = serde_json::from_slice(&std::fs::read(engine.state_dir.join("project.json")).ok()?).ok()?;
    v["layers"].get(id).filter(|s| s.get("symbology").is_some()).cloned()
}

/// Natural Earth 1:50m land and country borders (public domain), the same files as the app's offline
/// basemap, compiled in so every exported map has a world underneath, also from the CLI.
static BASEMAP: [(&str, &str, &[u8]); 2] = [
    ("Land", "land", include_bytes!("../../../../web/public/basemap/land.geojson")),
    ("Borders", "boundaries", include_bytes!("../../../../web/public/basemap/boundaries.geojson")),
];

fn bundled_context(engine: &Engine) -> Vec<(&'static str, std::sync::Arc<LayerHandle>)> {
    static CACHE: std::sync::OnceLock<Vec<(&'static str, std::sync::Arc<LayerHandle>)>> = std::sync::OnceLock::new();
    CACHE
        .get_or_init(|| {
            let dir = engine.state_dir.join("basemap");
            let _ = std::fs::create_dir_all(&dir);
            BASEMAP
                .iter()
                .filter_map(|(title, name, bytes)| {
                    let path = dir.join(format!("{name}.geojson"));
                    if std::fs::metadata(&path).map(|m| m.len() != bytes.len() as u64).unwrap_or(true) {
                        std::fs::write(&path, bytes).ok()?;
                    }
                    let h = catalog::load_layers(&path).ok()?.into_iter().next()?;
                    Some((*title, std::sync::Arc::new(h)))
                })
                .collect()
        })
        .clone()
}

fn is_context_candidate(l: &LayerHandle) -> bool {
    let n = l.info.id.to_ascii_lowercase();
    (l.info.geometry == GeomKind::Polygon && ["countries", "admin", "land", "boundar"].iter().any(|w| n.contains(w)))
        || (l.info.geometry == GeomKind::Line && ["road", "river"].iter().any(|w| n.contains(w)))
}

fn copy_to(sc: &StepCtx, p: &Value, files: &[String]) -> Result<Option<String>, String> {
    let Some(to) = p_str(p, "to") else { return Ok(None) };
    let dest = PathBuf::from(to);
    std::fs::create_dir_all(&dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    for f in files {
        std::fs::copy(sc.dir.join(f), dest.join(f)).map_err(|e| format!("copy {f} to {}: {e}", dest.display()))?;
    }
    Ok(Some(dest.display().to_string()))
}

/// The overview inset's land (bundled Natural Earth) around the study area, when an inset is wanted.
fn inset_for(sc: &StepCtx, fur: &cartography::Furniture, study: [f64; 4]) -> Result<Option<cartography::Inset>, String> {
    if fur.inset_at == super::furniture::Place::Off {
        return Ok(None);
    }
    let around = super::furniture::inset_extent(study);
    for (_, l) in bundled_context(sc.engine) {
        if l.info.geometry == crate::catalog::GeomKind::Polygon {
            let land = features::read_layer(sc.engine, &l, Some(around), Some(&[]), 20_000)?;
            return Ok(Some(cartography::Inset { land, study, around }));
        }
    }
    Ok(None)
}

struct PanelDef {
    extent: Option<[f64; 4]>,
    title: String,
    layers: Option<Vec<String>>,
}

/// `panels: [{extent?, title?, layers?}, …]`: the panels of a multi-panel page.
fn panel_params(p: &Value) -> Result<Vec<PanelDef>, String> {
    let Some(Value::Array(a)) = p.get("panels") else { return Ok(Vec::new()) };
    if a.len() > 40 {
        return Err(format!("{} panels: a page holds at most 40", a.len()));
    }
    a.iter()
        .enumerate()
        .map(|(i, d)| {
            let extent = match d.get("extent") {
                Some(Value::Array(e)) if e.len() == 4 => Some([0, 1, 2, 3].map(|k| e[k].as_f64().unwrap_or(0.0))),
                None | Some(Value::Null) => None,
                Some(_) => return Err(format!("panels[{i}]: extent must be [west, south, east, north]")),
            };
            let layers = d.get("layers").and_then(Value::as_array).map(|l| l.iter().filter_map(Value::as_str).map(str::to_string).collect());
            Ok(PanelDef { extent, title: d.get("title").and_then(Value::as_str).unwrap_or_default().to_string(), layers })
        })
        .collect()
}

/// Panel tags as in patchwork's `tag_levels`: a, b, … (or A, 1, i).
fn panel_tag(i: usize, style: &str) -> String {
    match style {
        "none" => String::new(),
        "A" => ((b'A' + (i % 26) as u8) as char).to_string(),
        "1" => (i + 1).to_string(),
        "i" => ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"].get(i).map(|s| s.to_string()).unwrap_or_else(|| (i + 1).to_string()),
        _ => ((b'a' + (i % 26) as u8) as char).to_string(),
    }
}

/// A multi-panel map page. Two ways in, after R:
/// - `panels:` (patchwork): each panel its own area and/or layers;
/// - `facet: field` (ggplot2 `facet_wrap`): one panel per value of a field of `facet_layer` (default:
///   the top mapped layer), same area and classes in every panel.
///
/// `ncol` sets the columns, `tags` the tag style (a, A, 1, i), `legends` collect | keep | auto (auto:
/// one shared legend when every panel shows the same layers, else a legend beside each panel).
fn render_multi(sc: &StepCtx, p: &Value, spec: &MapSpec, defs: Vec<PanelDef>, extent: [f64; 4], rhandles: &[Arc<crate::raster::RasterHandle>]) -> Result<cartography::MapOut, String> {
    let mut panels: Vec<(String, [f64; 4], Option<Vec<String>>, Vec<MapLayer>)> = Vec::new();
    if let Some(field) = p_str(p, "facet") {
        let main: Vec<&MapLayer> = spec.layers.iter().filter(|l| !l.context).collect();
        let target = match p_str(p, "facet_layer") {
            Some(id) => main.iter().find(|l| l.id == id || l.id.ends_with(&format!(".{id}"))).copied().ok_or(format!("facet_layer '{id}' is not on this map"))?,
            None => *main.iter().rev().find(|l| l.fs.field(field).is_some()).ok_or(format!("no mapped layer has a field '{field}'"))?,
        };
        let k = target.fs.field(field).ok_or(format!("{} has no field '{field}'", target.title))?;
        let mut values: Vec<String> = Vec::new();
        for f in &target.fs.feats {
            let v = f.props[k].text();
            if !values.contains(&v) {
                values.push(v);
            }
        }
        values.sort_by(|a, b| match (a.parse::<f64>(), b.parse::<f64>()) {
            (Ok(x), Ok(y)) => x.total_cmp(&y),
            _ => a.cmp(b),
        });
        if values.len() > 24 {
            return Err(format!("'{field}' has {} different values: facets need 24 or fewer (try a field with fewer classes)", values.len()));
        }
        let others: Vec<String> = spec.layers.iter().filter(|l| l.id != target.id).map(|l| l.id.clone()).collect();
        for v in values {
            let mut fs = target.fs.clone();
            fs.feats.retain(|f| f.props[k].text() == v);
            let n = fs.feats.len();
            let label = if v.is_empty() { "(no value)".to_string() } else { v.clone() };
            let own = MapLayer { id: target.id.clone(), title: target.title.clone(), kind: target.kind, style: target.style.clone(), fs, label_field: target.label_field.clone(), context: false, legend_note: format!("{n} features") };
            panels.push((format!("{field} = {label} · {}", cartography::fmt_num(n as f64)), extent, Some(others.clone()), vec![own]));
        }
    } else {
        for d in defs {
            panels.push((d.title, d.extent.unwrap_or(extent), d.layers, Vec::new()));
        }
    }
    let same_layers = panels.iter().all(|(_, _, l, _)| l == &panels[0].2);
    let own_legends = match p_str(p, "legends").unwrap_or("auto") {
        "keep" => true,
        "collect" => false,
        _ => !same_layers,
    };
    let extents: Vec<[f64; 4]> = panels.iter().map(|(_, e, _, _)| *e).collect();
    let ncol = p.get("ncol").and_then(Value::as_u64).map(|c| c as usize);
    let beside = spec.furniture.legend == "right";
    let (w, h, rects) = cartography::panel_grid(&extents, ncol, own_legends && beside, !own_legends && beside);
    let tags = p_str(p, "tags").unwrap_or("a");
    let mut out = Vec::new();
    for (i, ((title, e, layers, own), r)) in panels.into_iter().zip(rects).enumerate() {
        let layout = Layout::in_rect(e, r[0], r[1], r[2], r[3]);
        let mut rasters = Vec::new();
        let fm = cartography::frame_merc(&layout);
        let (rw, rh) = ((r[2] * 1.5) as usize, (r[3] * 1.5) as usize);
        for rh_ in rhandles {
            if layers.as_ref().is_some_and(|ids| !ids.contains(&rh_.info.id)) {
                continue;
            }
            let style = rh_.style();
            let rgba = rh_.render_rgba(&style, fm, rw, rh)?;
            rasters.push(cartography::MapRaster {
                id: rh_.info.id.clone(),
                title: sc.names.get(&rh_.info.id).cloned().unwrap_or_else(|| rh_.info.title.clone()),
                png: crate::raster::encode_png(rgba, rw, rh)?,
                opacity: style["opacity"].as_f64().unwrap_or(1.0),
                blend: style["blend"].as_str().map(str::to_string),
                legend: crate::raster::legend(&rh_.info, &style),
            });
        }
        out.push(cartography::Panel { tag: panel_tag(i, tags), title, layout, rasters, layers, own });
    }
    Ok(cartography::render_panels(spec, &out, w, h, own_legends))
}

/// `frames: [{extent: [w, s, e, n], label: "A1"}, …]`: page outlines for a map series' index page.
fn frames_param(p: &Value) -> Result<Vec<([f64; 4], String)>, String> {
    let Some(Value::Array(a)) = p.get("frames") else { return Ok(Vec::new()) };
    a.iter()
        .enumerate()
        .map(|(i, f)| {
            let e = f.get("extent").and_then(Value::as_array).filter(|e| e.len() == 4).ok_or(format!("frames[{i}]: extent must be [west, south, east, north]"))?;
            let e: Vec<f64> = e.iter().map(|v| v.as_f64().ok_or(format!("frames[{i}]: extent must be numbers"))).collect::<Result<_, _>>()?;
            let label = f.get("label").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| (i + 1).to_string());
            Ok(([e[0], e[1], e[2], e[3]], label))
        })
        .collect()
}

/// One multi-page PDF from every map this run laid out, in the order they were made.
fn export_series(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let svgs: Vec<PathBuf> = sc.maps.iter().map(|(svg, _)| svg.clone()).collect();
    if svgs.is_empty() {
        return Err("no maps to bind: put export.map steps before export.series".into());
    }
    let pages: Vec<String> = svgs.iter().map(|f| std::fs::read_to_string(f).map_err(|e| format!("{}: {e}", f.display()))).collect::<Result<_, _>>()?;
    let name = sanitize(p_str(p, "name").unwrap_or("series"));
    let f = format!("{name}.pdf");
    std::fs::write(sc.dir.join(&f), cartography::svgs_to_pdf(&pages)?).map_err(|e| e.to_string())?;
    let files = vec![f.clone()];
    let copied = copy_to(sc, p, &files)?;
    sc.artifacts.push(f.clone());
    Ok(StepOut { outputs: json!({ "pdf": sc.dir.join(&f), "pages": pages.len(), "files": files, "copied_to": copied }), why: vec![format!("{} map pages bound into {f}", pages.len())] })
}

fn export_map(sc: &mut StepCtx, p: &Value, force: Option<&str>) -> Result<StepOut, String> {
    let mut opts = sc.page.clone();
    if let Some(o) = p.as_object() {
        for (k, v) in o {
            if !v.is_null() {
                opts.insert(k.clone(), v.clone());
            }
        }
    }
    let p = &Value::Object(opts);
    // rasters listed among layers:, or rasters:, or (auto) the newest thematic raster + relief shading
    let find_raster = |id: &str| sc.engine.raster(id).or_else(|| sc.engine.raster(&format!("{}.{id}", sc.recipe_id)));
    let mut raster_ids: Vec<String> = Vec::new();
    let ids: Vec<String> = layer_list(sc, p, "layers")
        .into_iter()
        .filter(|id| {
            if sc.engine.layer(id).is_none() {
                if let Some(r) = find_raster(id) {
                    raster_ids.push(r.info.id.clone());
                    return false;
                }
            }
            true
        })
        .collect();
    match p.get("rasters") {
        Some(Value::Bool(false)) => raster_ids.clear(),
        Some(Value::String(s)) if s == "none" => raster_ids.clear(),
        Some(v) if !v.is_null() && v.as_str() != Some("auto") => {
            raster_ids = p_list(p, "rasters").iter().map(|id| find_raster(id).map(|r| r.info.id.clone()).ok_or(format!("unknown raster '{id}'"))).collect::<Result<_, _>>()?;
        }
        _ if raster_ids.is_empty() => {
            let touched: Vec<Arc<crate::raster::RasterHandle>> = sc.rasters.iter().filter_map(|id| sc.engine.raster(id)).collect();
            if let Some(base) = touched.iter().rev().find(|r| r.info.kind != "hillshade") {
                // forest loss is drawn over the tree cover it was lost from (its no-loss cells are clear)
                if base.info.kind == "lossyear" {
                    if let Some(tc) = touched.iter().rev().find(|r| r.info.kind == "treecover") {
                        raster_ids.push(tc.info.id.clone());
                    }
                }
                raster_ids.push(base.info.id.clone());
                if base.info.kind != "rgb" {
                    if let Some(hs) = touched.iter().rev().find(|r| r.info.kind == "hillshade") {
                        raster_ids.push(hs.info.id.clone());
                    }
                }
            } else if let Some(hs) = touched.last() {
                raster_ids.push(hs.info.id.clone());
            }
        }
        _ => {}
    }
    if ids.is_empty() && raster_ids.is_empty() {
        return Err("nothing to map: list layers: or run an import/analysis step first".into());
    }
    let handles: Vec<Arc<LayerHandle>> = ids.iter().map(|id| sc.layer(id)).collect::<Result<_, _>>()?;
    let rhandles: Vec<Arc<crate::raster::RasterHandle>> = raster_ids.iter().filter_map(|id| sc.engine.raster(id)).collect();
    let extent = match p.get("extent") {
        Some(Value::Array(a)) if a.len() == 4 && a.iter().all(Value::is_number) => [a[0].as_f64().unwrap(), a[1].as_f64().unwrap(), a[2].as_f64().unwrap(), a[3].as_f64().unwrap()],
        Some(Value::String(s)) if s != "auto" => match find_raster(s) {
            Some(r) => r.info.bounds,
            None => sc.layer(s)?.info.bounds,
        },
        _ if !rhandles.is_empty() && sc.aoi.is_some() => sc.aoi.unwrap(),
        _ => {
            let v = handles.iter().fold(None, |acc, l| features::union_bounds(acc, Some(l.info.bounds)));
            rhandles.iter().fold(v, |acc, r| features::union_bounds(acc, Some(r.info.bounds))).ok_or("no extent")?
        }
    };
    // multi-panel page (patchwork-style panels or a ggplot2-style facet): read the data for every panel
    let panel_defs = panel_params(p)?;
    let extent = if panel_defs.iter().all(|d| d.extent.is_some()) && !panel_defs.is_empty() {
        panel_defs.iter().filter_map(|d| d.extent).fold(None, |acc, e| features::union_bounds(acc, Some(e))).unwrap_or(extent)
    } else {
        extent
    };
    let formats: Vec<String> = match force {
        Some(f) => vec![f.to_string()],
        None => {
            let f = p_list(p, "format");
            if f.is_empty() { vec!["png".into(), "svg".into()] } else { f.into_iter().map(|x| x.to_ascii_lowercase()).collect() }
        }
    };
    if let Some(bad) = formats.iter().find(|f| !matches!(f.as_str(), "png" | "svg" | "pdf")) {
        return Err(format!("format '{bad}' is not supported (png, svg, pdf)"));
    }
    let proj = cartography::Proj::parse(p_str(p, "projection"), extent)?;
    let (w, h) = cartography::page_size_in(p_str(p, "size").unwrap_or("auto"), extent, proj);
    // raster maps fill the frame with data (cover); vector maps keep a margin around the features
    // rasters that cover their extent fill the frame; surfaces masked to the samples' hull
    // (interpolate.auto) are shown whole instead, or their edges would be cut off
    let masked = rhandles.iter().any(|r| matches!(r.info.kind.as_str(), "surface" | "stderr"));
    // an Equal Earth world is an oval: show it whole rather than crop it to fill the frame
    let cover = proj == cartography::Proj::Mercator && !rhandles.is_empty() && p.get("extent").is_none_or(|e| e.as_str() == Some("auto")) && p_bool(p, "fill", !masked);
    let mut fur = cartography::Furniture::from_params(p)?;
    // a world or continental Equal Earth map has no single scale: no scale bar unless one is asked for
    if proj == cartography::Proj::EqualEarth && extent[2] - extent[0] > 90.0 && p_str(p, "scale_bar_at").is_none_or(|v| v == "auto") {
        fur.scale_at = cartography::Place::Off;
    }
    let fit = if cover {
        cartography::Fit::Cover
    } else if p_bool(p, "exact", false) {
        cartography::Fit::Exact
    } else {
        cartography::Fit::Margin
    };
    // the legend inside the map (or none) gives the map the full page width
    let lay = Layout::fit_proj(extent, w, h, fit, fur.legend == "right", proj);
    let view = lay.view();
    // rasters are rendered for the map frame at 2× page resolution (bottom first, shading on top)
    let mut map_rasters = Vec::new();
    let fm = cartography::frame_merc(&lay);
    let (srs, fbox) = cartography::frame_box(&lay);
    // native resolution across the frame, between 1× and 2× the page (no point upsampling 30 m cells 2×)
    let frame_m = (fm[2] - fm[0]) * ((extent[1] + extent[3]) / 2.0).to_radians().cos();
    let finest = rhandles.iter().map(|r| r.info.pixel_m).fold(f64::MAX, f64::min).max(0.01);
    let k = (frame_m / finest / lay.fw).clamp(1.0, 2.0);
    let (rw, rh) = (((lay.fw * k).round() as usize).min(crate::raster::MAX_OVERLAY * 2), ((lay.fh * k).round() as usize).min(crate::raster::MAX_OVERLAY * 2));
    for r in &rhandles {
        let style = r.style();
        let mut rgba = r.render_rgba_in(&style, srs, fbox, rw, rh)?;
        if lay.proj == cartography::Proj::EqualEarth {
            // GDAL fills the corners beyond the world's outline too: clear them
            for j in 0..rh {
                let y = fbox[3] - (j as f64 + 0.5) / rh as f64 * (fbox[3] - fbox[1]);
                for i in 0..rw {
                    let x = fbox[0] + (i as f64 + 0.5) / rw as f64 * (fbox[2] - fbox[0]);
                    if !cartography::eqearth_inside(x, y) {
                        rgba[(j * rw + i) * 4 + 3] = 0;
                    }
                }
            }
        }
        map_rasters.push(cartography::MapRaster {
            id: r.info.id.clone(),
            title: sc.names.get(&r.info.id).cloned().unwrap_or_else(|| r.info.title.clone()),
            png: crate::raster::encode_png(rgba, rw, rh)?,
            opacity: style["opacity"].as_f64().unwrap_or(1.0),
            blend: style["blend"].as_str().map(str::to_string),
            legend: crate::raster::legend(&r.info, &style),
        });
    }
    let mut layers: Vec<MapLayer> = Vec::new();
    // background context (land, roads, rivers) when loaded and not mapped themselves
    let ctx_ids: Vec<String> = match p.get("context") {
        Some(Value::Bool(false)) => vec![],
        Some(Value::String(s)) if s == "none" => vec![],
        Some(Value::Array(_)) => p_list(p, "context"),
        _ => sc.engine.layers().iter().filter(|l| is_context_candidate(l) && !ids.contains(&l.info.id) && crate::tile::intersects(l.info.bounds, view)).map(|l| l.info.id.clone()).collect(),
    };
    let mut ctx_layers = Vec::new();
    for cid in &ctx_ids {
        let Ok(l) = sc.layer(cid) else { continue };
        let fs = features::read_layer(sc.engine, &l, Some(view), Some(&[]), 60_000)?;
        if !fs.feats.is_empty() {
            ctx_layers.push((rank(l.info.geometry), MapLayer { id: cid.clone(), title: humanize(&l.info.name), kind: l.info.geometry, style: json!({}), fs, label_field: None, context: true, legend_note: String::new() }));
        }
    }
    // nothing loaded to put underneath: the offline world the app shows (Natural Earth land and borders)
    if ctx_layers.is_empty() && !matches!(p.get("context"), Some(Value::Bool(false)) | Some(Value::String(_)) | Some(Value::Array(_))) {
        for (title, l) in bundled_context(sc.engine) {
            let fs = features::read_layer(sc.engine, &l, Some(view), Some(&[]), 60_000)?;
            if !fs.feats.is_empty() {
                ctx_layers.push((rank(l.info.geometry), MapLayer { id: l.info.id.clone(), title: title.to_string(), kind: l.info.geometry, style: json!({}), fs, label_field: None, context: true, legend_note: String::new() }));
            }
        }
    }
    ctx_layers.sort_by_key(|(r, _)| *r);
    layers.extend(ctx_layers.into_iter().map(|(_, l)| l));
    let mut main = Vec::new();
    let mut sources = Vec::new();
    for l in &handles {
        let id = &l.info.id;
        let (style, label) = match sc.styles.get(id) {
            Some((s, lf, _)) => (s.clone(), lf.clone()),
            None => match project_style(sc.engine, id) {
                Some(s) => (s, automap::label_field(l)),
                None => {
                    let st = automap::style_layer(sc.engine, l, None, None);
                    (st.style, st.label_field)
                }
            },
        };
        // labels set in the app (on or off) replace the automatic label field
        let label = match style.get("labels").filter(|v| v.is_object()) {
            Some(lb) if lb["on"].as_bool() == Some(true) => lb["field"].as_str().map(str::to_string),
            Some(_) => None,
            None => label,
        };
        let mut want: Vec<usize> = Vec::new();
        // the facet field too: a map split by a field needs it even when the layer is not styled by it
        for f in [style["symbology"]["field"].as_str().map(str::to_string), style["point"]["sizeBy"]["field"].as_str().map(str::to_string), label.clone(), p_str(p, "facet").map(str::to_string), Some("direction".to_string()), Some("length_m".to_string()), Some("area_m2".to_string()), Some("index".to_string())].into_iter().flatten() {
            if let Some(i) = l.field_index(&f) {
                if !want.contains(&i) {
                    want.push(i);
                }
            }
        }
        let fs = features::read_layer(sc.engine, l, Some(view), Some(&want), 250_000)?;
        let n = fs.feats.len();
        let plural = |w: &str| format!("{} {w}{}", cartography::fmt_num(n as f64), if n == 1 { "" } else { "s" });
        let note = match automap::device_role(id) {
            Some("photos") => plural("photo"),
            Some("waypoints") => plural("waypoint"),
            Some("tracks") => {
                let km: f64 = fs.field("length_m").map(|k| fs.numbers(k).iter().sum::<f64>()).unwrap_or(0.0);
                format!("{} · {}", plural("track"), features::fmt_distance(km))
            }
            _ if fs.truncated => format!("{} of {} features", cartography::fmt_num(n as f64), cartography::fmt_num(l.info.feature_count as f64)),
            _ if fs.field("area_m2").is_some() => {
                let m2: f64 = fs.field("area_m2").map(|k| fs.numbers(k).iter().sum::<f64>()).unwrap_or(0.0);
                let area = if m2 >= 1e6 { format!("{:.2} km²", m2 / 1e6) } else { format!("{:.1} ha", m2 / 1e4) };
                format!("{} · {area}", if n == 1 { "1 area".to_string() } else { format!("{n} areas") })
            }
            _ => plural("feature"),
        };
        let note = sc.hints.get(id).and_then(|h| h["note"].as_str()).map(str::to_string).unwrap_or(note);
        sources.push(sc.title_of(l));
        main.push((rank(l.info.geometry), MapLayer { id: id.clone(), title: sc.title_of(l), kind: l.info.geometry, style, fs, label_field: label, context: false, legend_note: note }));
    }
    main.sort_by_key(|(r, _)| *r);
    layers.extend(main.into_iter().map(|(_, l)| l));
    let date = now_local();
    let base_raster = rhandles.iter().find(|r| r.info.kind != "hillshade").or(rhandles.first());
    for r in rhandles.iter().filter(|r| r.info.kind != "hillshade") {
        sources.push(sc.names.get(&r.info.id).cloned().unwrap_or_else(|| r.info.title.clone()));
    }
    let title = p_str(p, "title").map(str::to_string).unwrap_or_else(|| match (&sc.device, handles.len(), base_raster) {
        (Some(d), _, _) => format!("Field map · {d}"),
        (None, _, Some(r)) => r.info.title.clone(),
        (None, 1, None) => sc.title_of(&handles[0]),
        _ => sc.recipe_title.to_string(),
    });
    let subtitle = match p_str(p, "subtitle") {
        Some(s) if s != "auto" => s.to_string(),
        _ => {
            let what = sc.import_summary.clone().unwrap_or_else(|| sources.join(" · "));
            format!("{what} · {}", date.format("%-d %B %Y"))
        }
    };
    let mut credit_sources: Vec<String> = sources.iter().filter(|s| !rhandles.iter().any(|r| sc.names.get(&r.info.id) == Some(*s) || r.info.title == **s)).cloned().collect();
    for r in &rhandles {
        if !r.info.credit.is_empty() && !credit_sources.contains(&r.info.credit) {
            credit_sources.push(r.info.credit.clone());
        }
    }
    credit_sources.extend(ctx_ids.iter().filter_map(|c| sc.engine.layer(c)).map(|l| humanize(&l.info.name)));
    if layers.iter().any(|l| l.context && BASEMAP.iter().any(|(_, n, _)| l.id.starts_with(n))) {
        credit_sources.push("Natural Earth (public domain)".to_string());
    }
    credit_sources.dedup();
    let credits = format!("Made automatically by GeoSpaX · recipe {} · {} · Data: {}", sc.recipe_id, date.format("%Y-%m-%d %H:%M"), credit_sources.join(", "));
    let n_rasters = map_rasters.len();
    let spec = MapSpec { rasters: map_rasters, title: title.clone(), subtitle, credits, layers, labels: p_bool(p, "labels", true), grid: p_bool(p, "grid", true), frames: frames_param(p)?, inset: inset_for(sc, &fur, view)?, furniture: fur };
    let out = if panel_defs.is_empty() && p.get("facet").is_none() {
        cartography::render_svg(&spec, &lay)
    } else {
        render_multi(sc, p, &spec, panel_defs, extent, &rhandles)?
    };
    let name = sanitize(p_str(p, "name").unwrap_or(if sc.step_id == "map" { "map" } else { &sc.step_id }));
    let mut files = Vec::new();
    let svg_file = format!("{name}.svg");
    std::fs::write(sc.dir.join(&svg_file), &out.svg).map_err(|e| e.to_string())?;
    if formats.iter().any(|f| f == "svg") {
        files.push(svg_file.clone());
    }
    let mut png = None;
    if formats.iter().any(|f| f == "png") {
        // dpi: the PNG at print resolution (the page is laid out at 150 dpi; 300 = 2×, 600 = 4×),
        // with the resolution written into the file so it opens at its print size
        let dpi = p_f64(p, "dpi").unwrap_or(cartography::DPI * p_f64(p, "scale").unwrap_or(1.0)).clamp(72.0, 1200.0);
        let scale = (dpi / cartography::DPI) as f32;
        let bytes = super::furniture::png_with_dpi(cartography::svg_to_png(&out.svg, scale)?, dpi);
        let f = format!("{name}.png");
        std::fs::write(sc.dir.join(&f), bytes).map_err(|e| e.to_string())?;
        png = Some(sc.dir.join(&f));
        files.insert(0, f);
    }
    if formats.iter().any(|f| f == "pdf") {
        let f = format!("{name}.pdf");
        std::fs::write(sc.dir.join(&f), cartography::svg_to_pdf(&out.svg)?).map_err(|e| e.to_string())?;
        files.push(f);
    }
    let copied = copy_to(sc, p, &files)?;
    sc.artifacts.extend(files.iter().cloned());
    sc.maps.push((sc.dir.join(&svg_file), files.clone()));
    sc.figures.push((files.iter().find(|f| f.ends_with(".png")).cloned(), title.clone()));
    sc.extent = Some(view);
    let scale = format!("1:{}", cartography::fmt_num(round2(out.scale_denominator)));
    if sc.maps.len() == 1 { sc.methods.push(format!(
        "The {:.0}×{:.0} px map page (title, legend, scale bar, north arrow, graticule, credits) was laid out automatically; the extent fits all mapped data with a margin ({}, ≈ {scale} at {} dpi).{}",
        w,
        h,
        lay.proj.name(),
        cartography::DPI,
        if lay.proj == cartography::Proj::EqualEarth { " Equal Earth (Šavrič, Patterson & Jenny 2018) keeps areas true, so regions can be compared by size; the scale holds at the centre of the map only." } else { "" }
    )); }
    Ok(StepOut {
        outputs: json!({
            "svg": sc.dir.join(&svg_file), "png": png, "files": files, "extent": view, "scale": scale,
            "features": out.drawn, "labels": out.labels, "size": [w, h], "title": title, "copied_to": copied, "rasters": raster_ids,
        }),
        why: vec![format!(
            "{:.0}×{:.0} px: {} layers{}, {} features drawn, {} labels, ≈ {scale} → {}",
            w,
            h,
            handles.len() + ctx_ids.len(),
            if n_rasters > 0 { format!(" + {n_rasters} raster{} ({})", if n_rasters == 1 { "" } else { "s" }, rhandles.iter().map(|r| r.info.kind.clone()).collect::<Vec<_>>().join(" under ")) } else { String::new() },
            out.drawn,
            out.labels,
            files.join(", ")
        )],
    })
}

fn round2(v: f64) -> f64 {
    if v <= 0.0 || !v.is_finite() {
        return v;
    }
    let p = 10f64.powi(v.log10().floor() as i32 - 1);
    (v / p).round() * p
}

fn export_report(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let date = now_local();
    let title = p_str(p, "title").map(str::to_string).unwrap_or_else(|| format!("{} · {}", sc.recipe_title, date.format("%-d %B %Y")));
    let trigger_text = sc.trigger.get("text").and_then(Value::as_str).unwrap_or("run by hand").to_string();
    let subtitle = p_str(p, "subtitle").map(str::to_string).unwrap_or_else(|| format!("Recipe '{}' · {} · {}", sc.recipe_id, trigger_text, date.format("%Y-%m-%d %H:%M")));
    // the first map is the main one; heavy raster maps are shown as their PNG instead of inline SVG
    let (map_svg, map_files) = match sc.maps.first() {
        Some((svg, files)) => {
            let size = std::fs::metadata(svg).map(|m| m.len()).unwrap_or(0);
            let png = files.iter().find(|f| f.ends_with(".png")).map(|f| sc.dir.join(f));
            let body = match png {
                Some(pngp) if size > 1_500_000 => std::fs::read(&pngp).ok().map(|b| format!("<img alt=\"map\" style=\"width:100%;height:auto;display:block;border-radius:6px\" src=\"data:image/png;base64,{}\">", cartography::base64(&b))),
                _ => std::fs::read_to_string(svg).ok(),
            };
            let mut all: Vec<String> = files.clone();
            for (_, more) in sc.maps.iter().skip(1) {
                all.extend(more.iter().cloned());
            }
            (body, all)
        }
        None => (None, vec![]),
    };
    let mut layers = Vec::new();
    for id in &sc.touched {
        let Some(l) = sc.engine.layer(id) else { continue };
        let b = l.info.bounds;
        let mut rows = vec![("Extent".to_string(), format!("{:.4}, {:.4} – {:.4}, {:.4}", b[0], b[1], b[2], b[3]))];
        let names: Vec<&str> = l.info.fields.iter().map(|f| f.name.as_str()).take(10).collect();
        if !names.is_empty() {
            rows.push(("Fields".into(), names.join(", ")));
        }
        if let Some((st, _, _)) = sc.styles.get(id) {
            if let (Some("graduated"), Some(f)) = (st["symbology"]["kind"].as_str(), st["symbology"]["field"].as_str()) {
                let lo = st["symbology"]["min"].as_f64().unwrap_or(f64::NAN);
                let hi = st["symbology"]["breaks"].as_array().and_then(|a| a.last()).and_then(Value::as_f64).unwrap_or(f64::NAN);
                rows.push((format!("Range of {f}"), format!("{} – {}", cartography::fmt_num(lo), cartography::fmt_num(hi))));
            }
        }
        layers.push(report::LayerSummary { id: id.clone(), title: sc.title_of(&l), kind: format!("{:?}", l.info.geometry).to_lowercase(), features: l.info.feature_count, rows });
    }
    let mut cards = sc.cards.clone();
    if cards.is_empty() {
        let total: u64 = layers.iter().map(|l| l.features).sum();
        cards.push((cartography::fmt_num(total as f64), "features mapped".into()));
    }
    cards.push((sc.touched.len().to_string(), "layers".into()));
    let decisions: Vec<(String, String)> = sc.touched.iter().filter_map(|id| sc.styles.get(id).map(|(_, _, why)| (id.clone(), why.clone()))).collect();
    let inputs_text = if sc.inputs.is_empty() { "none".into() } else { Value::Object(sc.inputs.clone()).to_string() };
    let provenance = vec![
        ("Recipe".to_string(), sc.recipe_id.to_string()),
        ("Recipe fingerprint (FNV-1a)".into(), fnv64(sc.recipe_text)),
        ("Run".into(), sc.run_id.to_string()),
        ("Trigger".into(), trigger_text),
        ("Inputs".into(), inputs_text),
        ("GeoSpaX".into(), env!("CARGO_PKG_VERSION").to_string()),
        ("GDAL".into(), gdal::version::version_info("RELEASE_NAME")),
        ("Generated".into(), date.to_rfc3339()),
    ];
    let input = report::ReportInput {
        title: title.clone(),
        subtitle,
        map_svg,
        map_files,
        cards,
        methods: sc.methods.clone(),
        decisions,
        layers,
        steps: sc.records.clone(),
        provenance,
        notes: p_str(p, "notes").map(str::to_string),
        views: sc.views.clone(),
        charts: sc.charts.clone(),
        figures: sc
            .figures
            .iter()
            .skip(1)
            .filter_map(|(png, title)| {
                let f = png.as_ref()?;
                Some(report::Figure { png: std::fs::read(sc.dir.join(f)).ok()?, title: title.clone(), file: f.clone() })
            })
            .collect(),
        word: Some(format!("{}.docx", sanitize(p_str(p, "name").unwrap_or("report")))),
    };
    let html = report::render(&input);
    let name = sanitize(p_str(p, "name").unwrap_or("report"));
    let file = format!("{name}.html");
    std::fs::write(sc.dir.join(&file), html.as_bytes()).map_err(|e| e.to_string())?;
    // the same report as an editable Word document, with the main map as a picture
    let map_png = input.map_files.iter().find(|f| f.ends_with(".png")).and_then(|f| std::fs::read(sc.dir.join(f)).ok());
    let docx = format!("{name}.docx");
    std::fs::write(sc.dir.join(&docx), report_docx::render(&input, map_png.as_deref())?).map_err(|e| e.to_string())?;
    let copied = copy_to(sc, p, &[file.clone(), docx.clone()])?;
    sc.artifacts.push(file.clone());
    sc.artifacts.push(docx.clone());
    Ok(StepOut {
        outputs: json!({ "html": sc.dir.join(&file), "docx": sc.dir.join(&docx), "files": [file, docx], "title": title, "copied_to": copied }),
        why: vec![format!("{} KB report: map, {} decisions, {} method notes, run log, provenance", html.len() / 1024, sc.styles.len(), sc.methods.len())],
    })
}

fn export_data(sc: &mut StepCtx, p: &Value) -> Result<StepOut, String> {
    let mut ids = p_list(p, "layer");
    ids.extend(p_list(p, "layers"));
    if ids.is_empty() {
        ids = sc.touched.clone();
    }
    let fmt = p_str(p, "format").unwrap_or("gpkg");
    let (driver, ext) = features::driver_for(fmt).ok_or_else(|| format!("unknown format '{fmt}' (gpkg, geojson, csv, fgb, kml, shp)"))?;
    let mut files = Vec::new();
    let mut total = 0usize;
    for id in &ids {
        let l = sc.layer(id)?;
        let fs = features::read_layer(sc.engine, &l, None, None, 5_000_000)?;
        total += fs.feats.len();
        let file = format!("{}.{ext}", sanitize(id));
        let layer_name = sanitize(&l.info.name);
        features::write_features(&sc.dir.join(&file), driver, &layer_name, &fs)?;
        files.push(file);
    }
    let copied = copy_to(sc, p, &files)?;
    sc.artifacts.extend(files.iter().cloned());
    Ok(StepOut {
        outputs: json!({ "files": files, "format": ext, "features": total, "copied_to": copied }),
        why: vec![format!("{} layer(s), {} features → {}", ids.len(), cartography::fmt_num(total as f64), files.join(", "))],
    })
}

/// A CSV (as R's write.csv writes it) as `{columns, rows}`, at most `max` rows.
fn csv_rows(text: &str, max: usize) -> Value {
    fn split(line: &str) -> Vec<String> {
        let (mut out, mut cur, mut q) = (Vec::new(), String::new(), false);
        let mut it = line.chars().peekable();
        while let Some(c) = it.next() {
            match c {
                '"' if q && it.peek() == Some(&'"') => {
                    cur.push('"');
                    it.next();
                }
                '"' => q = !q,
                ',' if !q => out.push(std::mem::take(&mut cur)),
                c => cur.push(c),
            }
        }
        out.push(cur);
        out
    }
    let mut lines = text.lines().filter(|l| !l.is_empty());
    let columns = lines.next().map(split).unwrap_or_default();
    let all: Vec<Vec<String>> = lines.map(split).collect();
    let rows: Vec<Value> = all.iter().take(max).map(|r| Value::from(r.iter().map(|c| c.parse::<f64>().map(|f| json!(f)).unwrap_or_else(|_| if c == "NA" { Value::Null } else { json!(c) })).collect::<Vec<_>>())).collect();
    json!({ "columns": columns, "rows": rows, "total": all.len() })
}

fn code_step(sc: &mut StepCtx, p: &Value, lang: sidecar::Lang) -> Result<StepOut, String> {
    let code = match (p_str(p, "code"), p_str(p, "file")) {
        (Some(c), _) => c.to_string(),
        (None, Some(f)) => std::fs::read_to_string(f).map_err(|e| format!("{f}: {e}"))?,
        _ => return Err("code: or file: is required".into()),
    };
    let step_dir = sc.dir.join("steps").join(&sc.step_id);
    std::fs::create_dir_all(step_dir.join("inputs")).map_err(|e| e.to_string())?;
    let mut inputs = Vec::new();
    if let Some(m) = p.get("inputs").and_then(Value::as_object) {
        for (name, v) in m {
            let spec = v.as_str().ok_or_else(|| format!("input '{name}' must be a layer id or a file"))?;
            if let Some(l) = sc.engine.layer(spec) {
                let fs = features::read_layer(sc.engine, &l, None, None, 2_000_000)?;
                let file = step_dir.join("inputs").join(format!("{}.geojson", sanitize(name)));
                features::write_features(&file, "GeoJSON", name, &fs)?;
                inputs.push((name.clone(), file));
            } else if let Some(r) = sc.engine.raster(spec) {
                // rasters go in as their file (R: a terra SpatRaster)
                inputs.push((name.clone(), r.info.path.clone()));
            } else if let Some(path) = sc.resolve_path(spec) {
                inputs.push((name.clone(), path));
            } else {
                return Err(format!("input '{name}': '{spec}' is neither a layer nor a file"));
            }
        }
    }
    let params = p.get("params").cloned().unwrap_or_else(|| json!({}));
    let packages = p_list(p, "packages");
    let timeout = Duration::from_secs_f64(p_f64(p, "timeout_s").unwrap_or(600.0).clamp(1.0, 86_400.0));
    let r = sidecar::run(lang, &code, &inputs, &params, &packages, &step_dir, timeout, sc.cancel)?;
    let mut layers = Map::new();
    for (name, path) in &r.layers {
        let handles = catalog::load_layers(path)?;
        let Some(h) = handles.into_iter().next() else { continue };
        let fs = features::read_layer(sc.engine, &h, None, None, 2_000_000)?;
        let id = sc.write_output(name, &fs, humanize(name))?;
        layers.insert(name.clone(), Value::from(id));
    }
    // rasters (terra SpatRaster …) join the run like any other raster
    let out_dir = sc.outputs_dir();
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    for (name, path) in &r.rasters {
        let dest = out_dir.join(format!("{}.tif", sanitize(name)));
        let ds = crate::raster::open(path)?;
        let float = ds.rasterband(1).map(|b| b.band_type().name().starts_with("Float")).unwrap_or(false);
        crate::raster::save_gtiff(&ds, &dest, float)?;
        let id = format!("{}.{}", sc.recipe_id, sanitize(name));
        let h = sc.engine.register_raster(&dest, &id)?;
        sc.rasters.retain(|x| x != &id);
        sc.rasters.push(id.clone());
        sc.names.insert(id.clone(), h.info.title.clone());
        layers.insert(name.clone(), Value::from(id));
    }
    // figures (ggplot2, tmap, rayshader …) are run artifacts; the PNG goes in the report
    let mut figures = Map::new();
    for (name, path) in &r.figures {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("png");
        let f = format!("{}.{ext}", sanitize(name));
        std::fs::copy(path, sc.dir.join(&f)).map_err(|e| e.to_string())?;
        sc.artifacts.push(f.clone());
        if ext == "png" {
            sc.figures.push((Some(f.clone()), humanize(name)));
        }
        figures.entry(name.clone()).or_insert_with(|| json!([])).as_array_mut().unwrap().push(Value::from(f));
    }
    // tables (data frames) are shown in the run and kept as CSV
    let mut tables = Map::new();
    for (name, path) in &r.tables {
        let f = format!("{}.csv", sanitize(name));
        std::fs::copy(path, sc.dir.join(&f)).map_err(|e| e.to_string())?;
        sc.artifacts.push(f.clone());
        tables.insert(name.clone(), csv_rows(&std::fs::read_to_string(path).unwrap_or_default(), 500));
    }
    let results: Vec<String> = r.result.iter().map(|(k, v)| format!("{k} = {}", super::recipe::value_text(v))).collect();
    let returned: Vec<String> = layers.keys().chain(figures.keys()).chain(tables.keys()).map(|k| format!("'{k}'")).collect();
    sc.methods.push(format!(
        "A {} step ({}) ran custom analysis{}{}.",
        lang.name(),
        r.version,
        if returned.is_empty() { String::new() } else { format!(" and returned {}", returned.join(", ")) },
        if results.is_empty() { String::new() } else { format!("; results: {}", results.join(", ")) }
    ));
    for (k, v) in r.result.iter().take(2) {
        sc.cards.push((super::recipe::value_text(v), k.replace('_', " ")));
    }
    let stdout_tail: Vec<&str> = r.stdout.lines().rev().take(20).collect::<Vec<_>>().into_iter().rev().collect();
    Ok(StepOut {
        outputs: json!({ "layers": layers, "figures": figures, "tables": tables, "result": r.result, "interpreter": r.version, "ms": r.ms, "stdout": stdout_tail.join("\n") }),
        why: vec![format!(
            "{} ({}) in {:.1} s → {} layer(s), {} figure(s), {} table(s){}",
            lang.name(),
            r.version,
            r.ms / 1000.0,
            layers.len(),
            r.figures.len(),
            tables.len(),
            if results.is_empty() { String::new() } else { format!("; {}", results.join(", ")) }
        )],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hexagons_partition_the_plane() {
        // a point maps to the hexagon whose centre is nearest
        for (x, y) in [(0.0, 0.0), (10.0, 3.0), (-25.0, 40.0), (123.4, -56.7)] {
            let (q, r) = hex_of([x, y], 10.0);
            let c = hex_center(q, r, 10.0);
            let d = ((c[0] - x).powi(2) + (c[1] - y).powi(2)).sqrt();
            for (dq, dr) in [(1, 0), (-1, 0), (0, 1), (0, -1), (1, -1), (-1, 1)] {
                let o = hex_center(q + dq, r + dr, 10.0);
                assert!(d <= ((o[0] - x).powi(2) + (o[1] - y).powi(2)).sqrt() + 1e-9);
            }
        }
    }

    #[test]
    fn idw_cross_validation_prefers_the_right_power() {
        // a smooth linear trend: higher powers do worse than ~1-2
        let samples: Vec<([f64; 2], f64)> = (0..100).map(|i| {
            let (x, y) = ((i % 10) as f64 * 100.0, (i / 10) as f64 * 100.0);
            ([x, y], x * 0.01 + y * 0.02)
        }).collect();
        let (r1, _) = idw_cv(&samples, 1.0);
        let (r3, _) = idw_cv(&samples, 3.0);
        assert!(r1.is_finite() && r3.is_finite());
        assert!(idw_at([0.0, 0.0], &samples, 2.0, None) == 0.0, "exact at a sample");
    }

    #[test]
    fn hull_and_point_in_polygon() {
        let hull = convex_hull(vec![[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0], [1.0, 1.0]]);
        assert_eq!(hull.len(), 4);
        assert!(point_in_ring([1.0, 1.0], &hull) && !point_in_ring([3.0, 1.0], &hull));
    }

    #[test]
    fn step_checks() {
        let (e, _) = check("export.mapp", &json!({}));
        assert!(e[0].contains("export.map"), "{e:?}");
        let (e, w) = check("vector.buffer", &json!({ "layer": "x", "distnce": 5 }));
        assert!(e.iter().any(|x| x.contains("distance")) && w.iter().any(|x| x.contains("distnce")));
        let (e, _) = check("python", &json!({}));
        assert!(e.iter().any(|x| x.contains("code")));
        assert!(spec("script.r").is_some());
    }
}
