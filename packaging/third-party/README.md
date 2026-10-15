# Third-party notices that travel with the GeoSpaX binaries

Rust crates are linked under their own licenses (MIT/Apache-2.0/ISC/BSD, listed in `Cargo.lock`). This folder keeps
the license texts that must travel with the binaries: crates that ship *data*, and crates whose license asks for an
acknowledgement in the documentation.

| Folder | What | License |
|---|---|---|
| `webpki-roots/` | Mozilla's root certificate list (via the `webpki-roots` crate), used to check MQTT brokers' TLS certificates (`mqtts://`) | CDLA-Permissive-2.0 |
| `jpeg-encoder/` | The `jpeg-encoder` crate encodes the terrain textures of 3D scenes and the 3D picture in reports. *This software is based in part on the work of the Independent JPEG Group.* | (MIT OR Apache-2.0) AND IJG |

`scripts/package-linux.sh` installs these under `/usr/share/doc/geospax/third-party/`; `scripts/package-windows.sh`
copies them to `third-party-licenses\` in the install folder and lists them in `PACKAGES.txt`.
