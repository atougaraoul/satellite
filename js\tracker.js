// tracker.js
// Uses satellite.js + Leaflet to fetch TLE, propagate and show on map
// Works without API keys (fetches TLE from Celestrak). If CORS blocks, fallback TLE is used.

const CelestrakTLEByNORAD = async (norad) => {
  const url = `https://celestrak.com/satcat/tle.php?CATNR=${encodeURIComponent(norad)}`;
  try {
    const res = await fetch(url);
    if(!res.ok) throw new Error('fetch failed');
    const txt = await res.text();
    // Expecting 3-line TLE (name, line1, line2) or just two lines
    const lines = txt.trim().split('\n').map(s=>s.trim()).filter(Boolean);
    if(lines.length >= 2) {
      // If name missing, augment
      if(lines.length === 2) {
        return {name:`NORAD ${norad}`, line1:lines[0], line2:lines[1]};
      } else {
        return {name: lines[0], line1: lines[1], line2: lines[2]};
      }
    }
    throw new Error('invalid TLE');
  } catch (e) {
    console.warn('Celestrak fetch failed', e);
    return null;
  }
};

const sampleISS = {
  name: "ISS (ZARYA) - sample fallback",
  // A recent-ish sample TLE (replaceable)
  line1: "1 25544U 98067A   25336.20547222  .00021320  00000-0  43887-3 0  9991",
  line2: "2 25544  51.6413  11.9812 0007892 304.9859  54.9765 15.50089713338645"
};

let map, satMarker, orbitLayer, updateHandle;

function initMap() {
  map = L.map('map', { worldCopyJump: true }).setView([0, 0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  orbitLayer = L.layerGroup().addTo(map);
}

function showTelemetry(obj) {
  document.getElementById('telemetry').style.display = 'block';
  document.getElementById('sat-name').textContent = obj.name || '—';
  document.getElementById('sat-id').textContent = obj.id || '—';
  document.getElementById('lat').textContent = obj.lat?.toFixed(4) ?? '—';
  document.getElementById('lng').textContent = obj.lng?.toFixed(4) ?? '—';
  document.getElementById('alt').textContent = obj.alt?.toFixed(3) ?? '—';
  document.getElementById('vel').textContent = obj.vel?.toFixed(4) ?? '—';
  document.getElementById('ts').textContent = obj.ts || '—';
}

function clearOrbit() {
  orbitLayer.clearLayers();
  if(satMarker) { map.removeLayer(satMarker); satMarker = null; }
}

function plotOrbit(satrec, steps=240, secondsStep=60) {
  // steps points, each secondsStep seconds apart (past + future)
  orbitLayer.clearLayers();
  const path = [];
  const now = new Date();
  for(let i=-Math.floor(steps/2); i<Math.ceil(steps/2); i++){
    const when = new Date(now.getTime() + i * secondsStep * 1000);
    const positionAndVelocity = satellite.propagate(satrec, when);
    if(positionAndVelocity.position) {
      const gmst = satellite.gstime(when);
      const geo = satellite.eciToGeodetic(positionAndVelocity.position, gmst);
      const lat = satellite.degreesLat(geo.latitude);
      const lon = satellite.degreesLong(geo.longitude);
      path.push([lat, lon]);
    }
  }
  L.polyline(path, {color:'#0b7285', weight:2, opacity:0.9}).addTo(orbitLayer);
}

function startUpdating(satrec, meta) {
  if(updateHandle) clearInterval(updateHandle);
  updateHandle = setInterval(() => {
    const now = new Date();
    const pv = satellite.propagate(satrec, now);
    if(!pv.position) return;
    const gmst = satellite.gstime(now);
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    let lat = satellite.degreesLat(geo.latitude);
    let lon = satellite.degreesLong(geo.longitude);
    // normalize lon to [-180,180]
    if(lon > 180) lon -= 360;
    const altitude = geo.height; // km
    const vel = Math.sqrt(pv.velocity.x*pv.velocity.x + pv.velocity.y*pv.velocity.y + pv.velocity.z*pv.velocity.z); // km/s

    const obj = {
      name: meta.name,
      id: meta.id,
      lat, lng: lon, alt: altitude, vel,
      ts: now.toUTCString()
    };
    showTelemetry(obj);

    if(!satMarker) {
      satMarker = L.circleMarker([lat, lon], {radius:6, color:'#ff5722', fill:true, fillOpacity:0.9}).addTo(map);
      satMarker.bindPopup(`${meta.name} (${meta.id || '—'})`);
    } else {
      satMarker.setLatLng([lat, lon]);
    }
    // center lightly (do not force if user panned; only if zoomed out)
    if(map.getZoom() < 5) map.setView([lat, lon], 2);
  }, 1000);
}

document.addEventListener('DOMContentLoaded', function(){
  initMap();

  const input = document.getElementById('sat-input');
  const trackBtn = document.getElementById('track-btn');
  const stopBtn = document.getElementById('stop-btn');

  trackBtn.addEventListener('click', async () => {
    const query = (input.value || '').trim();
    if(!query) {
      alert('Enter NORAD ID or name (e.g., 25544 or ISS). Using sample ISS TLE.');
    }
    const norad = query && /^\d+$/.test(query) ? query : null;
    let tleObj = null;

    if(norad) {
      tleObj = await CelestrakTLEByNORAD(norad);
    } else if(query) {
      // try name based TLE search via Celestrak group (best-effort)
      // fallback: attempt to fetch stations list and find name match (simple)
      try {
        const txt = await fetch('https://celestrak.com/NORAD/elements/stations.txt').then(r=>r.text());
        const lines = txt.split('\n').map(s=>s.trim()).filter(Boolean);
        // simple search for containing name
        for(let i=0;i<lines.length;i+=3){
          const name = lines[i];
          if(name && name.toLowerCase().includes(query.toLowerCase())){
            tleObj = { name: name, line1: lines[i+1], line2: lines[i+2] };
            break;
          }
        }
      } catch(e){
        console.warn('name search failed', e);
      }
    }

    if(!tleObj) {
      // fallback to sample
      tleObj = sampleISS;
    }

    // Create satrec
    try {
      const satrec = satellite.twoline2satrec(tleObj.line1, tleObj.line2);
      clearOrbit();
      plotOrbit(satrec, 360, 60);
      startUpdating(satrec, {name: tleObj.name, id: norad || '—'});
    } catch (err) {
      alert('Failed to parse TLE. Paste a valid 2-line element or try another ID.');
      console.error(err);
    }
  });

  stopBtn.addEventListener('click', () => {
    if(updateHandle) clearInterval(updateHandle);
    updateHandle = null;
    clearOrbit();
    document.getElementById('telemetry').style.display = 'none';
  });
});
