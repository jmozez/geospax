# syntax=docker/dockerfile:1
# hadolint global ignore=DL3008
# GeoSpaX web edition (server + browser UI) in one image.
#
#   docker build -t geospax .
#   docker run -p 8080:8080 -v "$PWD/data:/data:ro" -v geospax-state:/state geospax
#   docker compose up            # + an MQTT broker for live sensors, see docker-compose.yml
#
# Extra arguments go to geospax-server, e.g. `--auto all` or `--mqtt mqtt://broker:1883/sensors/#`.
# Plugged-in USB devices are a desktop feature; in a container, sensors arrive over MQTT/HTTP and
# files arrive through a drop folder (--inbox /inbox).

# ---- 1. web UI (Vite 8 needs Node >= 20.19)
FROM node:24-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npx vite build

# ---- 2. server (Debian 13: GDAL 3.10, same as the tested dev setup)
FROM debian:trixie-slim AS server
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      build-essential pkg-config clang libclang-dev curl ca-certificates libgdal-dev binutils \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y -q --profile minimal
ENV PATH=/root/.cargo/bin:$PATH
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates crates
COPY apps/desktop/src-tauri apps/desktop/src-tauri
# compiled in (include_str!/include_bytes!): the recipe gallery, the phone page, the offline basemap
COPY recipes recipes
COPY web/public web/public
RUN --mount=type=cache,target=/root/.cargo/registry --mount=type=cache,target=/src/target \
    cargo build --release -p geospax-server \
    && strip --strip-unneeded -o /geospax-server target/release/geospax-server
# runtime packages = owners of the binary's NEEDED libraries (libgdal36, ...)
RUN objdump -p /geospax-server | awk '/NEEDED/{print $2}' | while read -r lib; do \
      path=$(ldconfig -p | awk -v l="$lib" '$1 == l {print $NF; exit}'); \
      { dpkg -S "$path" 2>/dev/null || dpkg -S "$(readlink -f "$path")"; } | awk -F: 'NR == 1 {print $1}'; \
    done | sort -u > /runtime-packages.txt && cat /runtime-packages.txt

# ---- 3. runtime
FROM debian:trixie-slim
COPY --from=server /runtime-packages.txt /tmp/runtime-packages.txt
RUN apt-get update && DEBIAN_FRONTEND=noninteractive xargs -a /tmp/runtime-packages.txt \
      apt-get install -y --no-install-recommends fonts-dejavu-core ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/* /tmp/runtime-packages.txt
COPY --from=server /geospax-server /usr/bin/geospax-server
# /usr/share/geospax/web is where an installed geospax-server looks for the UI
COPY --from=web /src/web/dist /usr/share/geospax/web
COPY recipes /usr/share/geospax/recipes
COPY plugins /usr/share/geospax/plugins
RUN useradd --create-home --uid 1000 geospax && mkdir -p /data /state /inbox && chown geospax /data /state /inbox
USER 1000:1000
VOLUME ["/state"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/api/health', timeout=4)"]
ENTRYPOINT ["geospax-server", "--host", "0.0.0.0", "--port", "8080", "--data", "/data", "--state-dir", "/state", "--no-device-mounts"]
CMD []
