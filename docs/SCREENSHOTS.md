# Screenshot inventory

Retaken 28 October 2026 (PGT) from main after PR #74, 1600x960 at 2x, dark theme. Capture: `scripts/shots-hero.mjs`.

| Shot | Mode | Old | New | Used in |
|---|---|---|---|---|
| screenshot-lazy.webp | Lazy | Central Lae, Overture data (release of the time), Esri imagery, ribbon-era Lazy bar | Central Lae, Overture 2026-09-17.0 places (333), roads (924), buildings (985), Esri World Imagery, Roads card selected, 1:50,000 | README, site, in4metrix GeoSpax page |
| screenshot-pro.webp | Pro | Same data, old Home ribbon (Settings, Refresh, Start) | Same data, current Home ribbon (New project, Open project, Save), Roads unique values by class, 1:50,000 | README, site, in4metrix GeoSpax page (geospax-pro.png card) and Home page |
| screenshot-globe.webp | Pro | Empty project, globe, Esri imagery, old ribbon | Empty project, globe, Esri imagery, current ribbon | README, site, in4metrix GeoSpax page |



## General shots

Retaken 30 October 2026 (PGT) from main, 1600x960 at 2x, dark theme, all in Pro mode. Files were overwritten in place under the same names, so no old copies remain. Capture: `scripts/shots-general/` (`shoot.mjs` with `specs.mjs`).

| Shot | Old | New | Used in |
|---|---|---|---|
| ribbon-swipe.webp | Swipe on a reserves layer with the map grid | Swipe on forest core areas (300 m edge), Markham valley, Esri imagery | README, USER_GUIDE, site |
| ribbon-time.webp | Time slider on survey points | Time slider adding up 2,000 GBIF bird records (1993 to 2026), shown at 2019 | README, USER_GUIDE, site |
| ribbon-view.webp | View tab (old tab layout) | View tab of the current Pro ribbon | README, USER_GUIDE, site |
| tour-hydrology.png | 834 links, 11 basins, Huon coast at 60 m | 1,674 Strahler links, 7 basins, Markham valley at 30 m, hillshade | README, USER_GUIDE, site |
| tour-landcover.png | WorldCover 2021, Lae | WorldCover 2021, Lae, class legend (tree 57.6 %, water 28.7 %) | README, USER_GUIDE, site |
| tour-classification.png | 6 classes, 81 % | 9 classes, 80.3 %, 360 white sample points | README, USER_GUIDE, site |
| tour-clustering.png | k-means 8 groups | k-means 8 groups, 1.1 million pixels at 20 m | README, USER_GUIDE, site |
| tour-network.png | Distance to 12 clinics, 2,646 segments | 500 m / 1 km / 2 km service area to 16 facilities over 2,456 roads | README, USER_GUIDE, site |
| tour-dem-wilhelm.webp | 839 to 4,471 m | 338 to 4,473 m, hillshade and tint | README, USER_GUIDE, site |
| tour-dem-3d.webp | 3D view over imagery | 3D terrain, pitch 70° | README, USER_GUIDE, site |
| plugin-agriculture.png | 220 m cells, 3,187 scored | 2,529 cells of 1 km, 5 quantile classes | README, USER_GUIDE, site |
| plugin-biodiversity.png | OBIS 0.1° cells, 987 taxa | GBIF birds on 5 km hexes, 244 species, H′ 4.68 | README, USER_GUIDE, site |
| plugin-climate.png | 462 coastal cells | 2,529 land cells, flood exposure | README, USER_GUIDE, site |
| plugin-conservation.png | 10 km hexes, 35 of 176 | 8 km grid, 68 of 740 cells, GEBCO | README, USER_GUIDE, site |
| plugin-disaster.png | Slope 4, relief 2, tree 1 | Slope 3, relief 2, tree 1 | README, USER_GUIDE, site |
| plugin-environment.png | 38.9 km, 882 samples | 39.1 km, 634 samples, 0 to 1,730 m | README, USER_GUIDE, site |
| plugin-forestry.png | 136 patches, 33 links | 69 patches ≥ 20 ha, core 300 m (83.7 %) | README, USER_GUIDE, site |
| plugin-geoscience.png | Slope zones | Slope zones 41 / 23 / 36 % | README, USER_GUIDE, site |
| plugin-hydrology.png | Streams and basins | Wet ground suitability on land cells | README, USER_GUIDE, site |
| plugin-lulc.png | Two-date change, 3,800 ha lost | Hansen loss year, 18,021 ha 2001 to 2025 | README, USER_GUIDE, site |
| plugin-marine.png | 409 records, 9 clusters | 1,197 records, 242 on land dropped by the land check, 955 in 20 clusters, 47 noise | README, USER_GUIDE, site |
| plugin-soil.png | RUSLE-style index | Slope and open-ground erosion score | README, USER_GUIDE, site |

Not retaken: tour-lidar (no LiDAR source on hand; the San Francisco shot is already dark and on real data) and tour-design (no design session on hand). The industry maps were redone in PRs #74 to #76.
