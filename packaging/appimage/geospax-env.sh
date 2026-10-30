# GeoSpaX AppRun hook: sourced by AppRun before the app starts.
# WebKitGTK's DMA-BUF renderer leaves the window blank on some GPU drivers (NVIDIA, older Mesa, VMs);
# turn it off unless the user has chosen a value.
if [ -z "${WEBKIT_DISABLE_DMABUF_RENDERER+x}" ]; then
  export WEBKIT_DISABLE_DMABUF_RENDERER=1
fi
