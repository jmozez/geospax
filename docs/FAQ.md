# Frequently asked questions

## Getting started

### How do I install GeoSpaX?

Download the installer for your system from the [releases page](https://github.com/jmozez/geospax/releases):

- **Windows 10 or 11:** `GeoSpaX_<version>_x64-setup.exe`. It installs for you only, so no administrator
  password is needed. A portable ZIP is there too.
- **Debian 13 / Ubuntu:** `geospax_<version>_amd64.deb`, then `sudo apt install ./geospax_<version>_amd64.deb`.
- **Any system with Docker:** the web edition, `docker compose up -d`.

Start **GeoSpaX** from the Start menu or the applications menu. The [user guide](USER_GUIDE.md) has the details.

### Why is the map empty when GeoSpaX starts?

GeoSpaX opens on a clean map, showing the globe, like a new map in ArcGIS Pro. Add data with
**Data › Add files**, by dropping files on the window, from the **Explorer** pane, or try **Data › Sample
data**. Files you keep in the `Data` folder (`~/GeoSpaX/Data`, or `%USERPROFILE%\GeoSpaX\Data` on Windows)
are put on the map automatically.

### Does sample data stay on my map?

No. Sample data opens for the current session only and is not copied into your `Data` folder, so the next
start is a clean map again.

### How do I take a layer off the map?

Use the **✕** on the layer (Pro: in its row; Lazy: on its card), press **Delete** with the layer selected in
Contents, right-click it and choose **Remove from map**, or use **Remove** on the **Layer** ribbon tab. The
file itself is never deleted. The layer stays off the map at the next start until you add it again from the
**Explorer** pane.

### How do I browse other folders?

In the **Explorer** pane (left, next to Contents) press **Connect a folder…** (or **Data › Connect folder**, or
right-click in the Explorer), choose a folder anywhere on your computer and press **Connect this folder**. It
appears under *Folders*, stays there the next time you start GeoSpaX, and its files go on the map with a
double-click or **+**. The **✕** next to it removes the connection; the folder and its files are not touched.
When the web edition is opened to other devices (`--host 0.0.0.0`), folders cannot be connected from the
app, so a phone on the Wi-Fi can never list your computer's folders; start it with `--data <folder>` instead.

### How do I add a WMS, WMTS, WFS or ArcGIS service?

In the **Explorer**, under *Web services*, press **＋ Add**, choose the type and paste the address (a WMS or
WFS address, a WMTS capabilities URL, an XYZ template with `{z}/{x}/{y}`, an OGC API landing page, or an
ArcGIS `…/MapServer` or `…/FeatureServer`). Open it to see its layers. A map-image layer goes on the map as a
**web layer** (Contents › Web layers, with opacity); a feature layer is downloaded for the map view and becomes
a normal layer you can style, analyse and export. The ✕ next to a service removes the connection.

### How do I find satellite imagery (Sentinel-2, Landsat) for my area?

In the **Explorer**, under *Web services*, press **＋ Add** and pick one of the public STAC catalogs (Earth
Search, Planetary Computer, Copernicus Data Space), or paste another STAC API address. Open it and click a
collection: a search panel opens beside the map. Choose the map view or draw a box, set the dates and the most
cloud you accept, and press **Search**. Click a result to see its bands: **Stream** puts a band on the map
without copying it (good for a look); **Download** saves it cut to your area (`~/GeoSpaX/Data/.geospax/stac/`
on a desktop), with a progress gauge. Large scenes stream far faster than they download.

### Can I open data from an S3, Google Cloud or Azure bucket?

Yes. In the **Explorer**, under *Web services*, press **＋ Add**, choose **Cloud storage** and type the address:
`s3://bucket/folder`, `gs://bucket`, `az://container` or a web folder `https://…/`. Leave **Public** ticked for
open data (for example Sentinel or NAIP buckets); untick it to use this computer's own sign-in (your AWS profile
or `AWS_*` variables, `gcloud auth application-default login`, `az login`). GeoSpaX never stores your keys. For
MinIO or other S3-compatible storage, fill in the endpoint. Open the folders and click a file: GeoTIFFs are read
in place (only the part on screen is fetched), vector files become layers.

### Lazy or Pro?

**Lazy** shows layer cards, a task bar ("What do you want to do?") and plain-language next steps. **Pro** shows
the full ribbon, a layer tree like ArcGIS Pro's Contents pane and every pane. Switch at any time with the
switch at the top right; nothing is lost.

## Maps

### Why is the map a globe? Can I have a flat map?

The map starts as a globe (as in GeoLibre and Google Earth): zoom in and it flattens naturally. For a flat map
choose **View › Projection › Mercator**; GeoSpaX remembers the choice.

### Which projection do exported maps use?

World and continental maps are exported in **Equal Earth**, an equal-area projection, so countries keep their
true relative sizes. Smaller maps use Web Mercator, like the web map. Choose either in **Finish my map ›
Projection**.

### How do I change colours, symbols and labels?

Select the layer, then **Symbology** (Pro: right pane; Lazy: the card's **⋯**). Points can be circles, squares,
stars and more, sized by a field; lines can be dashed with a casing; polygons can be hollow; labels have font,
size, halo and placement. Rasters have their own **Symbology** (⚙ on the raster): stretch, classes, RGB, ramp
and opacity. **AutoMap** chooses a good style for you and says why.

### Can I work without internet?

Yes. The offline world basemap, all analysis, maps, reports and exports work without a connection. Online
data (climate, species, elevation …), online basemaps, R package downloads and the update check need one.

## Analysis, plugins and R

### Where are the conservation and biodiversity (GSX) tools?

On the **Plugins** tab, under **Domain plugins (GSX)**: Agriculture, Biodiversity, Climate, Conservation and
the rest. Each opens its tools and its ready-made analyses (kits). **Plugins › Manage** lists every plugin,
including the GSX tool library they share.

### How do I install R packages?

**R & Python › R setup** lists what is installed (✓) and what is missing (○). Tick what you need and press **Install
selected**. A log shows each step as it happens: which package is downloaded, which were already installed,
and the exact reason when one fails (most often no internet connection or a proxy). Packages go into GeoSpaX's
own library, so your R setup is not changed.

### R says a package is installed, but I never installed it

GeoSpaX uses every package R can find, including those installed by you or your system (for example
`r-cran-sf` on Debian). The setup log says "was already installed" for those, with the version found.

### Can I add my own tools?

Yes: plugins from GeoSpaX, RustGIS, GeoLibre, QGIS and ArcGIS Pro manifests. See [Plugins](PLUGINS.md).

### How do I delete a finished map or a run from the history?

Point at the map on the start screen and press its **✕**, or use the **✕** next to a run in **Activity**
(Lazy) or **History** (Pro). **Clear history** in Pro removes every finished run at once. Each deletes the
map, report and log of that run; layers it put on the map stay until you remove them.

### Where are downloaded online data saved?

In GeoSpaX's results folder, under `.geospax/outputs/online-data/` in your Data folder (for example
`~/GeoSpaX/Data/.geospax/outputs/online-data/` on Linux, `%USERPROFILE%\GeoSpaX\Data\.geospax\outputs\online-data\`
on Windows): GeoTIFFs for rasters, GeoPackages for vectors. Select a layer and its details show the exact
folder (**Saved in**). The folder starts with a dot, so file managers hide it: show hidden files (Ctrl+H in
most Linux file managers). Downloading the same data again replaces the file of the same name.

### Can I download data for just part of the map?

Yes. In **Online data**, under **Area**, choose the map view, **draw a box on the map**, or use **a layer's
points, lines or polygons** (with a margin in km; for polygons, **Only inside the polygons** cuts rasters
to their outline). While it downloads, a gauge shows the size, the speed and the time left.

## Settings, updates and privacy

### Where are the settings?

**Home › Settings** (or the ⚙ at the top right) opens one place for theme, mode, map, units, automation,
the assistant and R.

### How do I update GeoSpaX?

**Help › About GeoSpaX › Check for updates** compares your version with the newest release and links to the
download.

### Does GeoSpaX send my data anywhere?

No. Everything runs on your computer. The web edition answers only this computer unless you start it with
`--host 0.0.0.0`, and then only with an access token. See [Security](../SECURITY.md).

### How do I open GeoSpaX on my phone?

Start the web edition with `--host 0.0.0.0`, then open the link it prints (with its access token) on the
phone, on the same Wi-Fi. To send photos and tracks from the phone, use **Data › Phone over Wi-Fi**.

### Something does not work. How do I report it?

Open an issue at <https://github.com/jmozez/geospax/issues> with what you did, what you expected and what
happened. **Help › Engine diagnostics** shows details worth including.
