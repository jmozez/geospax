# Example output: a 3D scene made by a recipe

`lidar-scene-3d.html` and `lidar-scene-3d.glb` are what GeoSpaX 1.5.0 wrote, unchanged, for

```bash
python3 scripts/data-sample-lidar.py scene.las --classified      # the synthetic survey near Lae (known truth)
geospax-server run lidar-to-terrain --input source=scene.las
```

- **`lidar-scene-3d.html`**: the self-contained viewer with the model inside. Open it in any browser, offline.
  Drag to turn, right-drag or Shift-drag to move, scroll to zoom, double-click to reset; the switches show the
  terrain, the 3 buildings, the 40 trees and the 241,311-point cloud (coloured by class).
- **`lidar-scene-3d.glb`**: the same scene as glTF 2.0 for Blender, Windows 3D Viewer, ArcGIS Pro or CesiumJS
  (UTM 55S, EPSG:32755; the origin and vertical exaggeration are in `asset.extras.geospax`).

How it is built: [docs/AUTOMATION.md §6d](../../docs/AUTOMATION.md#6d-3d-scenes-built). Measurements:
[RESULTS §19](../RESULTS.md#19-3d-scenes).
