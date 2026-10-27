// The phone page's script (phone.html). A file of its own, not inline: the web edition's pages and the
// phone link both send a Content-Security-Policy that runs only scripts from the server itself.
// Served at /phone.js by the web server (web/dist) and by the phone link (crates/engine/src/phone.rs).
const $ = (id) => document.getElementById(id);
// pairing code from the QR code (#t=…), remembered so a bookmark keeps working
const hashT = new URLSearchParams(location.hash.slice(1)).get('t');
if (hashT) { localStorage.setItem('geospax-token', hashT); history.replaceState(null, '', location.pathname); }
const token = hashT || localStorage.getItem('geospax-token') || '';
const q = (params) => { const u = new URLSearchParams(params || {}); if (token) u.set('t', token); const s = u.toString(); return s ? '?' + s : ''; };
const key = 'geospax-device';
let device = localStorage.getItem(key);
if (!device) { device = Math.random().toString(16).slice(2, 8); localStorage.setItem(key, device); }
$('name').value = localStorage.getItem(key + '-name') || 'Phone ' + device.slice(0, 4).toUpperCase();
$('name').addEventListener('change', () => localStorage.setItem(key + '-name', $('name').value));
const msg = (t, cls) => { $('msg').textContent = t; $('msg').className = cls || ''; };
let maxBytes = 64 * 1048576, lastPos = null, watch = null, sent = 0;

// phone link (QR code) or the web edition's /phone.html (live location only)?
(async () => {
  try {
    const r = await fetch('api/phone/hello' + q());
    if (r.status === 401) { $('unpaired').hidden = false; document.body.dataset.link = 'unpaired'; return; }
    const h = r.ok ? await r.json() : {};
    if (!h.link) { document.body.dataset.link = 'web'; return; }  // web edition's /phone.html: live location only
    maxBytes = (h.max_upload_mb || 64) * 1048576;
    $('computer').textContent = h.computer;
    $('title').textContent = '→ ' + h.computer;
    $('intro').textContent = 'Send photos, tracks and sensor logs to GeoSpaX, or share your live location.';
    $('paired').hidden = false; $('send').hidden = false;
    document.body.dataset.link = 'paired';
  } catch (e) { document.body.dataset.link = 'error'; }
})();

// ---------------------------------------------------------------- live location
async function send(p) {
  lastPos = p;
  const c = p.coords;
  const body = { device, name: $('name').value || 'Phone', lat: c.latitude, lon: c.longitude, accuracy: c.accuracy,
                 altitude: c.altitude, heading: c.heading, speed: c.speed, t: p.timestamp };
  try {
    const r = await fetch('api/devices/live' + q(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    sent++;
    $('count').textContent = sent;
    $('acc').textContent = Math.round(c.accuracy);
    $('lat').textContent = c.latitude.toFixed(5);
    $('lon').textContent = c.longitude.toFixed(5);
    document.body.dataset.sent = String(sent);
    msg('Live on the map ✓', 'ok');
  } catch (e) { msg('Could not reach GeoSpaX: ' + e.message, 'err'); }
}
$('toggle').addEventListener('click', () => {
  if (watch !== null) {
    navigator.geolocation.clearWatch(watch); watch = null;
    $('toggle').textContent = 'Start sharing location'; $('toggle').className = 'alt'; msg('Stopped.');
    return;
  }
  if (!('geolocation' in navigator)) return msg('This browser has no location support.', 'err');
  if (!window.isSecureContext) return msg('Location needs https:// (scan the QR code in GeoSpaX).', 'err');
  msg('Waiting for a GPS fix…');
  watch = navigator.geolocation.watchPosition(send, (e) => msg('Location error: ' + e.message, 'err'),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  $('toggle').textContent = 'Stop sharing'; $('toggle').className = 'stop';
});

// ---------------------------------------------------------------- sending files
function position() {
  if (lastPos && Date.now() - lastPos.timestamp < 30000) return Promise.resolve(lastPos);
  if (!('geolocation' in navigator) || !window.isSecureContext) return Promise.resolve(null);
  return new Promise((res) => navigator.geolocation.getCurrentPosition((p) => { lastPos = p; res(p); }, () => res(null),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }));
}
function upload(file, params, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', 'api/phone/upload' + q(params));
    x.upload.onprogress = (e) => onProgress(e.loaded);
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch (e) {} x.status === 200 ? res(j) : rej(new Error(j.error || 'HTTP ' + x.status)); };
    x.onerror = () => rej(new Error('connection lost'));
    x.send(file);
  });
}
const busy = (on) => { $('pick').disabled = on; $('snap').disabled = on; };
async function sendFiles(files, camera) {
  if (!files.length) return;
  const batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0, ok = 0; const gps = { photo: 0, phone: 0 }, skipped = [];
  busy(true); $('progress').hidden = false; $('result').hidden = true; msg('');
  const show = (extra) => { $('bar').style.width = (total ? Math.round(100 * extra / total) : 100) + '%'; };
  for (const f of files) {
    if (f.size > maxBytes) { skipped.push(f.name); done += f.size; continue; }
    $('ptext').textContent = `Sending ${ok + 1} of ${files.length}: ${f.name}`;
    const params = { batch, name: f.name || 'photo.jpg' };
    if (camera) {
      const p = await position();
      if (p) Object.assign(params, { lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy), ts: Date.now() });
    }
    try {
      const r = await upload(f, params, (n) => show(done + n));
      ok++; if (r.gps) gps[r.gps] = (gps[r.gps] || 0) + 1;
    } catch (e) { skipped.push(f.name + ' (' + e.message + ')'); }
    done += f.size; show(done);
  }
  let commit = {};
  try {
    const r = await fetch('api/phone/commit' + q({ batch, live: watch !== null ? 'phone-' + device : '' }), { method: 'POST' });
    commit = await r.json();
    if (!r.ok) throw new Error(commit.error || 'HTTP ' + r.status);
  } catch (e) { busy(false); return msg('Sent, but GeoSpaX did not confirm: ' + e.message, 'err'); }
  $('ptext').textContent = `Sent ${ok} file${ok === 1 ? '' : 's'} ✓ — GeoSpaX is making your map…`;
  document.body.dataset.uploaded = String(ok);
  const notes = [];
  if (gps.phone) notes.push(`${gps.phone} placed with this phone's position`);
  const photos = files.filter((f) => /^image\//.test(f.type) || /\.(jpe?g|heic|png|tiff?)$/i.test(f.name)).length;
  if (!camera && photos && gps.photo < photos) notes.push(`${photos - gps.photo} of ${photos} photos had no location (phones often remove it when sharing). ${watch !== null ? 'They are placed along your live track by time.' : 'Turn on "Share live location" while you take photos and GeoSpaX places them by time.'}`);
  if (skipped.length) notes.push('Skipped: ' + skipped.join(', '));
  busy(false);
  await waitForMap(commit, notes);
}
async function waitForMap(commit, notes) {
  const since = Date.parse(commit.at) - 2000;
  const box = $('result'); box.hidden = false;
  box.innerHTML = notes.map((n) => `<p>${n.replace(/[<>&]/g, '')}</p>`).join('');
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let runs = [];
    try { runs = (await (await fetch('api/runs' + q())).json()).runs || []; } catch (e) { continue; }
    const mine = runs.filter((r) => Date.parse(r.started_at) >= since && (!commit.inbox || (r.trigger && r.trigger.root === commit.inbox)));
    const doneRun = mine.find((r) => r.status === 'done' && (r.artifacts || []).includes('map.png'));
    if (doneRun) {
      $('ptext').textContent = 'Your map is ready ✓';
      document.body.dataset.map = doneRun.id;
      const file = (n) => `api/runs/${encodeURIComponent(doneRun.id)}/files/${n}` + q();
      box.innerHTML += `<p><b>${(doneRun.title || doneRun.recipe).replace(/[<>&]/g, '')}</b> · ${(doneRun.message || '').replace(/[<>&]/g, '')}</p>`
        + `<a href="${file('map.png')}" target="_blank"><img alt="map" src="${file('map.png')}" /></a>`
        + ((doneRun.artifacts || []).includes('report.html') ? `<p><a href="${file('report.html')}" target="_blank">Open the report</a></p>` : '');
      return;
    }
    const failed = mine.find((r) => r.status === 'failed');
    if (failed) { $('ptext').textContent = 'GeoSpaX could not make a map: ' + (failed.error || 'see the run on the computer'); return; }
  }
  $('ptext').textContent = 'Sent ✓ — no map yet. GeoSpaX maps files that have locations (photos, tracks, logs).';
}
$('pick').addEventListener('click', () => $('files').click());
$('snap').addEventListener('click', () => { position(); $('camera').click(); });
$('files').addEventListener('change', (e) => { sendFiles([...e.target.files], false); e.target.value = ''; });
$('camera').addEventListener('change', (e) => { sendFiles([...e.target.files], true); e.target.value = ''; });
