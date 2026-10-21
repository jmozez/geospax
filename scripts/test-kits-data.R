# Test data for scripts/test-kits.py, with known answers (R with terra and sf):
#   Rscript scripts/test-kits-data.R <folder>   then start GeoSpaX with --data <folder>
library(terra); library(sf)
out <- commandArgs(TRUE)[1]; if (is.na(out)) out <- "kit-test-data"; dir.create(out, showWarnings = FALSE, recursive = TRUE); setwd(out)
library(terra); set.seed(1)
e <- ext(145.5, 146.5, -6.5, -5.5)
mk <- function(f) { r <- rast(nrows=200, ncols=200, ext=e, crs="EPSG:4326"); xy <- crds(r); values(r) <- f(xy[,1], xy[,2]); r }
dem <- mk(function(x,y) 200 + 2500*exp(-((x-146)^2+(y+6)^2)/0.04) + 300*sin(x*30)*cos(y*25))
writeRaster(dem, "test_dem.tif", overwrite=TRUE)
red <- mk(function(x,y) 0.08 + 0.10*(x>146) + rnorm(length(x),0,0.01)); nir <- mk(function(x,y) 0.45 - 0.25*(x>146) + rnorm(length(x),0,0.02))
img <- c(mk(function(x,y) 0.05+0*x), mk(function(x,y) 0.07+0*x), red, nir); names(img) <- c("blue","green","red","nir")
writeRaster(img, "test_image.tif", overwrite=TRUE)
nd1 <- (nir-red)/(nir+red); nd2 <- nd1; nd2[cellFromXY(nd2, cbind(146.2,-6.2))] <- NA
nd2 <- nd1 - 0.5*((crds(nd1)[,1]>145.7 & crds(nd1)[,1]<145.9))
writeRaster(nd1, "ndvi_2020.tif", overwrite=TRUE); writeRaster(nd2, "ndvi_2024.tif", overwrite=TRUE)
temp <- 28 - dem/1000*6; prec <- mk(function(x,y) 2000 + 1500*(y+6)); clim <- c(temp, prec); names(clim) <- c("temperature","precipitation")
writeRaster(clim, "climate.tif", overwrite=TRUE)
# species likes 18-22 C and wet: sample presences
v <- values(clim); ok <- which(v[,1] > 18 & v[,1] < 22 & v[,2] > 2200); s <- sample(ok, 120)
p <- vect(xyFromCell(clim, s), crs="EPSG:4326"); p$species <- "Test bird"
writeVector(p, "test_occurrences.geojson", filetype="GeoJSON", overwrite=TRUE)
cat("ok\n")
nd1 <- rast("ndvi_2020.tif"); x <- init(nd1, "x")
nd2 <- nd1 - 0.5 * ((x > 145.7) & (x < 145.9))
writeRaster(nd2, "ndvi_2024.tif", overwrite=TRUE); cat(nlyr(nd2), "\n")
library(sf); set.seed(3)
crs <- 4326; d <- ""
sq <- function(x0,y0,w,h) st_polygon(list(rbind(c(x0,y0),c(x0+w,y0),c(x0+w,y0+h),c(x0,y0+h),c(x0,y0))))
# habitat: 4 blocks of 0.1 deg; protected covers exactly half of the first two
hab <- st_sf(name=paste("habitat",1:4), geometry=st_sfc(sq(146,-6,0.1,0.1), sq(146.2,-6,0.1,0.1), sq(146,-6.2,0.1,0.1), sq(146.2,-6.2,0.1,0.1), crs=crs))
pa <- st_sf(name=c("PA north","PA south"), geometry=st_sfc(sq(146,-6,0.05,0.1), sq(146.2,-6,0.05,0.1), crs=crs))
st_write(hab, paste0(d,"habitat.geojson"), delete_dsn=TRUE, quiet=TRUE); st_write(pa, paste0(d,"protected_areas.geojson"), delete_dsn=TRUE, quiet=TRUE)
# forest patches: 12 squares, two clusters
pts <- rbind(cbind(146+runif(6,0,0.08), -6+runif(6,0,0.08)), cbind(146.4+runif(6,0,0.08), -6+runif(6,0,0.08)))
forest <- st_sf(id=1:12, geometry=st_sfc(lapply(1:12, function(i) sq(pts[i,1],pts[i,2],0.01,0.01)), crs=crs))
st_write(forest, paste0(d,"forest_patches.geojson"), delete_dsn=TRUE, quiet=TRUE)
# mangrove 2015 and 2025: 2025 loses the east third, gains a strip in the south
m15 <- st_sf(year=2015, geometry=st_sfc(sq(147,-7,0.3,0.1), crs=crs)); m25 <- st_sf(year=2025, geometry=st_sfc(st_union(sq(147,-7,0.2,0.1), sq(147,-7.05,0.2,0.05)), crs=crs))
st_write(m15, paste0(d,"mangrove_2015.geojson"), delete_dsn=TRUE, quiet=TRUE); st_write(m25, paste0(d,"mangrove_2025.geojson"), delete_dsn=TRUE, quiet=TRUE)
# survey: 300 records, 3 clusters, west cluster has 12 species, east 3
mk <- function(n,x,y,spp) data.frame(x=x+rnorm(n,0,0.02), y=y+rnorm(n,0,0.02), species=sample(spp,n,TRUE))
s <- rbind(mk(150,145.7,-6.2,paste("sp",1:12)), mk(100,146.3,-6.2,paste("sp",1:3)), mk(50,146,-5.8,paste("sp",4:7)))
st_write(st_as_sf(s, coords=c("x","y"), crs=crs), paste0(d,"bird_survey.geojson"), delete_dsn=TRUE, quiet=TRUE)
cat("ok\n")
clim <- rast("climate.tif"); fut <- clim; fut[[1]] <- clim[[1]] + 2.5  # warming only, so the range moves upslope
names(fut) <- names(clim); writeRaster(fut, "climate_future.tif", overwrite=TRUE)
dem <- rast("test_dem.tif"); x <- init(dem,"x"); y <- init(dem,"y")
ph <- 5 + (x-145.5) * 2; names(ph) <- "ph"; writeRaster(ph, "soil_ph.tif", overwrite=TRUE)
soc <- 40 + dem/50; writeRaster(soc, "soil_soc.tif", overwrite=TRUE)
clay <- 20 + (y+6.5)*20; writeRaster(clay, "soil_clay.tif", overwrite=TRUE)
cat("ok\n")
