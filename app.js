// ═══════════════════════════════════════════════════════════════
// MANHUNT  app.js  v4
// ═══════════════════════════════════════════════════════════════

// ── Firebase init ────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyA9GXHq5N9fczDx_cXdZKrHB8NdSlEz1bE",
  authDomain:        "manhunt-49350.firebaseapp.com",
  databaseURL:       "https://manhunt-49350-default-rtdb.firebaseio.com",
  projectId:         "manhunt-49350",
  storageBucket:     "manhunt-49350.appspot.com",
  messagingSenderId: "785860141000",
  appId:             "1:785860141000:web:0c07351336d4c9bb702afd",
};
firebase.initializeApp(firebaseConfig);
const db      = firebase.database();
const auth    = firebase.auth();
// Storage not used — avatars stored as compressed base64 in Realtime DB

// ── State ────────────────────────────────────────────────────
const S = {
  uid: null, displayName: null, photoURL: null,
  isHost: false, isSpectator: false, hostMode: 'play',
  gameCode: null, myRole: null,
  hunterCount: 1,
  phase: null,
  players: {},
  escapeTimer: 600, huntTimer: 0,
  pingCooldown: 180, pingsFired: 0,
  kills: 0, caught: false,
  myPos: null, watchId: null,
  posHistory: [], topSpeed: 0,
  oobActive: false, oobTimer: 0, oobInterval: null,
  boundary: [],
  map: null, myMarker: null, accCircle: null,
  playerMarkers: {}, pingMarkers: {},
  lastPings: [], _centered: false,
  mainInterval: null,
  dbRefs: [],
  bMap: null, bLine: null, bDots: [],
  drawing: false,
  wakeLock: null,
  // pending avatar data URL for signup
  pendingAvatarDataURL: null,
};

// ── Helpers ──────────────────────────────────────────────────
const genCode = () => Math.random().toString(36).slice(2,8).toUpperCase();
const fmt = s => { s=Math.max(0,s|0); return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`; };
const now = () => Date.now();

function haversine(a,b,c,d) {
  const R=6371000, f=(c-a)*Math.PI/180, g=(d-b)*Math.PI/180;
  const x=Math.sin(f/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(g/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

// Ray-cast point-in-polygon
function inPolygon(lat, lng, poly) {
  if (!poly || poly.length < 3) return true;
  let inside = false;
  for (let i=0, j=poly.length-1; i<poly.length; j=i++) {
    const xi=poly[i].lat, yi=poly[i].lng, xj=poly[j].lat, yj=poly[j].lng;
    if (((yi>lng)!==(yj>lng)) && lat < (xj-xi)*(lng-yi)/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
}

function toast(msg, color='var(--green)') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.style.color = color;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── Firebase shortcuts ────────────────────────────────────────
function dbSet(path, data)    { return db.ref(path).set(data); }
function dbUpd(path, data)    { return db.ref(path).update(data); }
function dbPush(path, data)   { return db.ref(path).push(data); }
function dbListen(path, cb) {
  const ref = db.ref(path);
  ref.on('value', snap => cb(snap.val()));
  S.dbRefs.push(ref);
}
function dbOff() { S.dbRefs.forEach(r=>r.off()); S.dbRefs=[]; }

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════
auth.onAuthStateChanged(async user => {
  if (user) {
    S.uid         = user.uid;
    S.displayName = user.displayName || user.email.split('@')[0];
    S.photoURL    = user.photoURL || null;
    // Make sure profile exists
    const snap = await db.ref(`users/${S.uid}/profile`).once('value');
    if (!snap.exists()) {
      await dbSet(`users/${S.uid}/profile`, {
        displayName: S.displayName,
        kills:0, caught:0, games:0, topSpeed:0, createdAt:now()
      });
    }
    // Load avatar from DB (stored as compressed base64)
    const avatarSnap = await db.ref(`users/${S.uid}/avatar`).once('value');
    if (avatarSnap.exists()) S.photoURL = avatarSnap.val();
    loadHomeHeader();
    showScreen('home');
  } else {
    showScreen('auth');
  }
});

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.add('active');
  document.getElementById('auth-login-form').style.display  = tab==='login'  ? '' : 'none';
  document.getElementById('auth-signup-form').style.display = tab==='signup' ? '' : 'none';
}

// ── Avatar selection (signup) ─────────────────────────────────
function onAvatarSelected(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    S.pendingAvatarDataURL = e.target.result;
    const prev = document.getElementById('signup-avatar-preview');
    prev.innerHTML = `<img src="${e.target.result}" style="width:80px;height:80px;border-radius:50%;object-fit:cover"/>`;
    prev.classList.remove('placeholder');
  };
  reader.readAsDataURL(file);
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const err   = document.getElementById('login-error');
  err.textContent = '';
  if (!email||!pass) { err.textContent='Enter email and password.'; return; }
  try { await auth.signInWithEmailAndPassword(email, pass); }
  catch(e) { err.textContent = e.message; }
}

async function doSignup() {
  const name  = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pass  = document.getElementById('signup-pass').value;
  const err   = document.getElementById('signup-error');
  err.textContent = '';
  if (!name||!email||!pass) { err.textContent='All fields required.'; return; }
  if (pass.length<6) { err.textContent='Password must be 6+ characters.'; return; }
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    let photoURL = '';
    // Upload avatar if selected
    if (S.pendingAvatarDataURL) {
      photoURL = await uploadAvatarDataURL(cred.user.uid, S.pendingAvatarDataURL);
    }
    await cred.user.updateProfile({ displayName: name });
    await dbSet(`users/${cred.user.uid}/profile`, {
      displayName: name,
      kills:0, caught:0, games:0, topSpeed:0, createdAt:now()
    });
  } catch(e) { err.textContent = e.message; }
}

// Compress image to small JPEG data URL using canvas, then store in DB
async function uploadAvatarDataURL(uid, dataURL) {
  try {
    const compressed = await compressImage(dataURL, 120, 0.7);
    await dbSet(`users/${uid}/avatar`, compressed);
    return compressed;
  } catch(e) { console.warn('Avatar save failed:', e); return ''; }
}

function compressImage(dataURL, size, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      // Crop to square from center
      const s = Math.min(img.width, img.height);
      const sx = (img.width - s) / 2;
      const sy = (img.height - s) / 2;
      ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = reject;
    img.src = dataURL;
  });
}

async function changeProfilePic(input) {
  const file = input.files[0];
  if (!file) return;
  toast('Saving…', 'var(--yellow)');
  const reader = new FileReader();
  reader.onload = async e => {
    const compressed = await compressImage(e.target.result, 120, 0.7);
    await dbSet(`users/${S.uid}/avatar`, compressed);
    S.photoURL = compressed;
    loadHomeHeader();
    goProfile();
    toast('Photo updated!');
  };
  reader.readAsDataURL(file);
}

async function doLogout() {
  dbOff(); stopGPS();
  await auth.signOut();
}

// ── Load home header ──────────────────────────────────────────
function loadHomeHeader() {
  document.getElementById('home-name').textContent = S.displayName;
  const img   = document.getElementById('home-avatar');
  const emoji = document.getElementById('home-avatar-emoji');
  if (S.photoURL) {
    img.src = S.photoURL; img.style.display = 'block'; emoji.style.display = 'none';
  } else {
    img.style.display = 'none'; emoji.style.display = 'block';
  }
}

// ═══════════════════════════════════════════════════════════════
// CREATE GAME
// ═══════════════════════════════════════════════════════════════
function goCreate() {
  S.gameCode = genCode();
  S.isHost   = true;
  S.hostMode = 'play';
  S.boundary = [];
  S.hunterCount = 1;
  document.getElementById('create-code').textContent = S.gameCode;
  document.getElementById('hunter-count').textContent = 1;
  document.getElementById('spec-desc').style.display = 'none';
  document.getElementById('btn-play').style.color = 'var(--green)';
  document.getElementById('btn-play').style.borderColor = 'var(--green)';
  document.getElementById('btn-spec').style.color = 'var(--muted)';
  document.getElementById('btn-spec').style.borderColor = 'var(--muted)';
  document.getElementById('boundary-hint').textContent = '';
  showScreen('create');
  setTimeout(initBoundaryMap, 250);
}

function changeHunters(d) {
  S.hunterCount = Math.max(1, Math.min(4, S.hunterCount + d));
  document.getElementById('hunter-count').textContent = S.hunterCount;
}

function setHostMode(mode) {
  S.hostMode = mode;
  const spec = mode === 'spectate';
  document.getElementById('spec-desc').style.display = spec ? '' : 'none';
  document.getElementById('btn-play').style.color       = spec ? 'var(--muted)'  : 'var(--green)';
  document.getElementById('btn-play').style.borderColor = spec ? 'var(--muted)'  : 'var(--green)';
  document.getElementById('btn-spec').style.color       = spec ? 'var(--blue)'   : 'var(--muted)';
  document.getElementById('btn-spec').style.borderColor = spec ? 'var(--blue)'   : 'var(--muted)';
}

// ── Boundary mini-map ─────────────────────────────────────────
function initBoundaryMap() {
  if (S.bMap) { S.bMap.remove(); S.bMap = null; }
  const c = S.myPos ? [S.myPos.lat, S.myPos.lng] : [51.505, -0.09];
  S.bMap = L.map('boundary-map', { center: c, zoom: 16, zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom:20, attribution:'© OSM' }).addTo(S.bMap);
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p => {
      S.bMap.setView([p.coords.latitude, p.coords.longitude], 16);
    }, () => {});
  }
  S.bMap.on('click', onBoundaryClick);
  document.getElementById('boundary-hint').textContent = 'Tap "Draw" then tap the map to place points.';
}

function toggleDraw() {
  S.drawing = !S.drawing;
  const btn = document.getElementById('draw-btn');
  btn.textContent = S.drawing ? '✓ Done' : '✏ Draw';
  if (S.drawing) btn.classList.add('drawing'); else btn.classList.remove('drawing');
  document.getElementById('boundary-hint').textContent = S.drawing
    ? 'Tap map to place points. Tap "Done" when finished.'
    : (S.boundary.length ? `${S.boundary.length} points set.` : '');
}

function onBoundaryClick(e) {
  if (!S.drawing) return;
  const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
  S.boundary.push(pt);
  const dot = L.circleMarker([pt.lat, pt.lng], { radius:5, color:'#a8dadc', fillColor:'#a8dadc', fillOpacity:1, weight:2 }).addTo(S.bMap);
  S.bDots.push(dot);
  if (S.bLine) S.bMap.removeLayer(S.bLine);
  if (S.boundary.length > 1) {
    const pts = [...S.boundary, S.boundary[0]].map(p=>[p.lat,p.lng]);
    S.bLine = L.polyline(pts, { color:'#a8dadc', weight:2, dashArray:'6 4' }).addTo(S.bMap);
  }
  document.getElementById('boundary-hint').textContent = `${S.boundary.length} point${S.boundary.length>1?'s':''} placed.`;
}

function clearBoundary() {
  S.boundary = []; S.drawing = false;
  if (S.bLine)  { S.bMap.removeLayer(S.bLine); S.bLine = null; }
  S.bDots.forEach(d => S.bMap.removeLayer(d)); S.bDots = [];
  document.getElementById('draw-btn').textContent = '✏ Draw';
  document.getElementById('draw-btn').classList.remove('drawing');
  document.getElementById('boundary-hint').textContent = 'Boundary cleared.';
}

async function createAndLobby() {
  S.isSpectator = S.hostMode === 'spectate';
  await dbSet(`games/${S.gameCode}/meta`, {
    hostUid:     S.uid,
    hunterCount: S.hunterCount,
    phase:       'WAITING',
    boundary:    S.boundary.length >= 3 ? S.boundary : null,
    createdAt:   now(),
  });
  await dbSet(`games/${S.gameCode}/players/${S.uid}`, {
    displayName: S.displayName,
    photoURL:    S.photoURL || '',
    role:        S.isSpectator ? 'SPECTATOR' : null,
    caught:      false,
    joinedAt:    now(),
  });
  enterLobby();
}

// ═══════════════════════════════════════════════════════════════
// JOIN
// ═══════════════════════════════════════════════════════════════
function goJoin()    { showScreen('join'); }
function onJoinInput() {
  document.getElementById('join-btn').disabled = document.getElementById('join-input').value.length < 6;
}

async function joinAndLobby() {
  const code = document.getElementById('join-input').value.toUpperCase().trim();
  const snap = await db.ref(`games/${code}/meta`).once('value');
  if (!snap.exists())               { toast('Game not found.', 'var(--red)'); return; }
  if (snap.val().phase !== 'WAITING') { toast('Game already started.', 'var(--red)'); return; }
  S.gameCode    = code;
  S.isHost      = false;
  S.isSpectator = false;
  S.boundary    = snap.val().boundary || [];
  await dbSet(`games/${code}/players/${S.uid}`, {
    displayName: S.displayName, photoURL: S.photoURL||'',
    role: null, caught: false, joinedAt: now(),
  });
  enterLobby();
}

// ═══════════════════════════════════════════════════════════════
// LOBBY
// ═══════════════════════════════════════════════════════════════
function enterLobby() {
  document.getElementById('lobby-code').textContent = S.gameCode;
  document.getElementById('wait-code').textContent  = S.gameCode;
  document.getElementById('start-btn').style.display  = S.isHost ? '' : 'none';
  document.getElementById('lobby-wait').style.display = S.isHost ? 'none' : '';
  showScreen('lobby');
  startGPS(updateLobbyGPS);

  dbListen(`games/${S.gameCode}/players`, data => {
    if (!data) return;
    S.players = data;
    renderLobbyPlayers();
  });

  if (!S.isHost) {
    dbListen(`games/${S.gameCode}/meta`, meta => {
      if (meta?.phase === 'ESCAPE') {
        dbOff();
        S.myRole   = S.players[S.uid]?.role || 'RUNNER';
        S.boundary = meta.boundary || [];
        beginGame();
      }
    });
  }
}

function updateLobbyGPS(pos, err) {
  const el = document.getElementById('gps-status');
  el.innerHTML = err
    ? `<span style="color:var(--red)">⚠ GPS: ${err}</span>`
    : `<span style="color:var(--green)">✓ ±${Math.round(pos.accuracy||0)}m</span>`;
}

function renderLobbyPlayers() {
  document.getElementById('player-list').innerHTML = Object.entries(S.players).map(([uid, p]) => {
    const color = uid === S.uid ? 'var(--green)' : 'var(--border)';
    const pic = p.photoURL
      ? `<img src="${p.photoURL}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid var(--border)"/>`
      : `<div style="width:36px;height:36px;border-radius:50%;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:18px">👤</div>`;
    return `<div class="player-row" style="border-left:3px solid ${color}">
      ${pic}
      <div style="flex:1">
        <div style="font-weight:700">${p.displayName}${uid===S.uid?' <span class="mono muted" style="font-size:10px">(you)</span>':''}</div>
        <div class="mono muted" style="font-size:10px">${uid===S.uid&&S.isHost?'Host':'Player'}</div>
      </div>
      <div class="player-badge muted" style="border-color:var(--muted)">${p.role||'PENDING'}</div>
    </div>`;
  }).join('');
}

// ═══════════════════════════════════════════════════════════════
// HOST START
// ═══════════════════════════════════════════════════════════════
async function hostStart() {
  const eligible = Object.entries(S.players).filter(([,p])=>p.role!=='SPECTATOR').map(([uid])=>uid);
  const shuffled = [...eligible].sort(()=>Math.random()-.5);
  const hunters  = shuffled.slice(0, S.hunterCount);
  const upd = {};
  eligible.forEach(uid => {
    const role = hunters.includes(uid) ? 'HUNTER' : 'RUNNER';
    upd[`games/${S.gameCode}/players/${uid}/role`] = role;
    if (uid === S.uid) S.myRole = role;
  });
  await dbUpd('/', upd);
  await dbUpd(`games/${S.gameCode}/meta`, { phase:'ESCAPE' });
  await dbPush(`games/${S.gameCode}/events`, { msg:'🚨 Game started! Runners — RUN!', type:'danger', ts:now() });
  dbOff();
  beginGame();
}

// ═══════════════════════════════════════════════════════════════
// BEGIN GAME
// ═══════════════════════════════════════════════════════════════
function beginGame() {
  S.phase        = 'ESCAPE';
  S.escapeTimer  = 600; S.huntTimer = 0;
  S.pingCooldown = 180; S.pingsFired = 0;
  S.kills = 0; S.caught = false;
  S.posHistory = []; S.topSpeed = 0;
  S.lastPings = []; S._centered = false;

  showScreen('game');
  initGameMap();
  renderHUD();
  addEvent('🚨 Game started!', 'danger');
  acquireWakeLock();

  document.getElementById('spec-ping-btn').style.display = S.isSpectator ? '' : 'none';

  S.mainInterval = setInterval(tick, 1000);

  // Live player positions
  dbListen(`games/${S.gameCode}/players`, data => {
    if (!data) return;
    S.players = data;
    Object.entries(data).forEach(([uid, p]) => {
      if (uid !== S.uid) drawPlayerMarker(uid, p);
    });
  });

  // Meta (phase changes, game end)
  dbListen(`games/${S.gameCode}/meta`, meta => {
    if (!meta) return;
    if (meta.phase === 'HUNT' && S.phase === 'ESCAPE') {
      S.phase = 'HUNT'; S.pingCooldown = 180;
      addEvent('⚡ Hunt phase!', 'danger');
      document.getElementById('ov-phase').style.display = 'none';
      document.getElementById('ov-info').style.display = '';
    }
    if (meta.phase === 'DONE' && S.phase !== 'DONE') finishGame();
  });

  // Pings (hunters read this)
  if (S.myRole === 'HUNTER') {
    dbListen(`games/${S.gameCode}/pings`, allPings => {
      if (!allPings || S.phase !== 'HUNT') return;
      Object.entries(allPings).forEach(([uid, pings]) => {
        if (!pings) return;
        const latest = Object.values(pings).sort((a,b)=>b.ts-a.ts)[0];
        if (latest && now()-latest.ts < 6000) {
          const player = S.players[uid];
          if (player && !player.caught) drawPingMarker(uid, player.displayName, latest.lat, latest.lng);
        }
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// GPS
// ═══════════════════════════════════════════════════════════════
function startGPS(cb) {
  if (!navigator.geolocation) { cb&&cb(null,'Not supported'); return; }
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = navigator.geolocation.watchPosition(
    pos => {
      const loc = { lat:pos.coords.latitude, lng:pos.coords.longitude, accuracy:pos.coords.accuracy, speed:pos.coords.speed, ts:now() };
      S.myPos = loc;
      S.posHistory.push(loc);
      if (S.posHistory.length > 1200) S.posHistory = S.posHistory.slice(-1000);
      if (loc.speed != null && loc.speed >= 0) {
        const kmh = loc.speed * 3.6;
        if (kmh > S.topSpeed) S.topSpeed = kmh;
      }
      cb && cb(loc, null);
      if (S.phase && S.phase !== 'DONE') onGameGPS(loc);
    },
    err => cb && cb(null, err.message),
    { enableHighAccuracy:true, maximumAge:0, timeout:15000 }
  );
}

function stopGPS() {
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
}

function onGameGPS(loc) {
  document.getElementById('ov-acquiring').style.display = 'none';
  placeMyMarker(loc);

  if (!S.isSpectator) {
    dbUpd(`games/${S.gameCode}/players/${S.uid}`, { lat:loc.lat, lng:loc.lng });
  } else {
    dbUpd(`games/${S.gameCode}/players/${S.uid}`, { lat:loc.lat, lng:loc.lng });
  }

  // OOB check
  if (S.boundary.length >= 3 && S.phase === 'HUNT' && !S.isSpectator && !S.caught) {
    const inside = inPolygon(loc.lat, loc.lng, S.boundary);
    if (!inside && !S.oobActive) startOOB();
    if ( inside &&  S.oobActive) stopOOB();
  }

  // Catch detection (hunter only)
  if (S.myRole === 'HUNTER' && S.phase === 'HUNT') {
    Object.entries(S.players).forEach(([uid, p]) => {
      if (p.role !== 'RUNNER' || p.caught || !p.lat) return;
      const dist = haversine(loc.lat, loc.lng, p.lat, p.lng);
      if (dist < 8) {
        dbUpd(`games/${S.gameCode}/players/${uid}`, { caught: true });
        dbPush(`games/${S.gameCode}/events`, { msg:`🎯 ${S.displayName} caught ${p.displayName}!`, type:'danger', ts:now() });
        S.kills++;
        toast(`🎯 You caught ${p.displayName}!`, 'var(--red)');
      }
    });
  }

  // Update my caught status
  const me = S.players[S.uid];
  if (me?.caught && !S.caught) {
    S.caught = true;
    document.getElementById('ov-caught').style.display = '';
    toast('You were caught!', 'var(--red)');
  }
}

// ═══════════════════════════════════════════════════════════════
// OUT OF BOUNDS
// ═══════════════════════════════════════════════════════════════
function startOOB() {
  S.oobActive = true; S.oobTimer = 25;
  const ov = document.getElementById('ov-oob');
  ov.style.display = '';
  document.getElementById('oob-count').textContent = 25;
  addEvent('⚠ OUT OF BOUNDS — everyone sees you for 25s!', 'danger');
  toast('⚠ Out of bounds!', 'var(--red)');
  dbUpd(`games/${S.gameCode}/players/${S.uid}`, { oob:true, lat:S.myPos.lat, lng:S.myPos.lng });
  S.oobInterval = setInterval(() => {
    S.oobTimer--;
    document.getElementById('oob-count').textContent = S.oobTimer;
    if (S.oobTimer <= 0) stopOOB();
  }, 1000);
}

function stopOOB() {
  S.oobActive = false;
  clearInterval(S.oobInterval);
  document.getElementById('ov-oob').style.display = 'none';
  dbUpd(`games/${S.gameCode}/players/${S.uid}`, { oob:false });
}

// ═══════════════════════════════════════════════════════════════
// MAP
// ═══════════════════════════════════════════════════════════════
function initGameMap() {
  if (S.map) { S.map.remove(); S.map=null; S.myMarker=null; S.accCircle=null; S.playerMarkers={}; S.pingMarkers={}; }
  const center = S.myPos ? [S.myPos.lat, S.myPos.lng] : [51.505,-0.09];
  S.map = L.map('map', { center, zoom:17, zoomControl:true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OSM', maxZoom:20 }).addTo(S.map);
  if (S.boundary.length >= 3) {
    L.polygon(S.boundary.map(p=>[p.lat,p.lng]), {
      color:'#a8dadc', fillColor:'#a8dadc', fillOpacity:.05, weight:2, dashArray:'8 4'
    }).addTo(S.map);
  }
  if (S.myPos) { placeMyMarker(S.myPos); document.getElementById('ov-acquiring').style.display='none'; }
}

function placeMyMarker(loc) {
  const color = S.isSpectator ? '#a8dadc' : S.myRole==='HUNTER' ? '#ff4d6d' : '#00ff9d';
  if (!S.myMarker) {
    const icon = L.divIcon({ className:'',
      html:`<div class="m-me" style="background:${color};box-shadow:0 0 12px ${color}66"></div>`,
      iconSize:[18,18], iconAnchor:[9,9] });
    S.myMarker = L.marker([loc.lat,loc.lng],{icon,zIndexOffset:1000}).addTo(S.map).bindPopup(`You (${S.isSpectator?'SPECTATOR':S.myRole})`);
  } else {
    S.myMarker.setLatLng([loc.lat,loc.lng]);
  }
  if (loc.accuracy) {
    if (!S.accCircle) S.accCircle = L.circle([loc.lat,loc.lng],{radius:loc.accuracy,color,fillColor:color,fillOpacity:.05,weight:1}).addTo(S.map);
    else S.accCircle.setLatLng([loc.lat,loc.lng]).setRadius(loc.accuracy);
  }
  if (!S._centered) { S.map.setView([loc.lat,loc.lng],17); S._centered=true; }
}

function drawPlayerMarker(uid, player) {
  if (!player.lat||!player.lng) return;
  const visible =
    S.isSpectator ||
    player.oob ||
    (S.phase==='HUNT' && S.myRole==='HUNTER' && player.role==='HUNTER') ||
    (player.role==='SPECTATOR');

  if (!visible) {
    if (S.playerMarkers[uid]) { S.map.removeLayer(S.playerMarkers[uid]); delete S.playerMarkers[uid]; }
    return;
  }
  const color = player.oob ? '#ff4d6d' : player.role==='HUNTER' ? '#ff4d6d' : player.role==='SPECTATOR' ? '#a8dadc' : '#00ff9d';
  const label = player.oob ? `${player.displayName} ⚠` : player.displayName;
  const pic   = player.photoURL ? `<img src="${player.photoURL}" style="width:22px;height:22px;border-radius:50%;object-fit:cover;border:2px solid ${color}"/>` : `<div style="width:22px;height:22px;border-radius:50%;background:#080e18;border:2px solid ${color};display:flex;align-items:center;justify-content:center;font-size:11px">👤</div>`;

  if (!S.playerMarkers[uid]) {
    const icon = L.divIcon({ className:'',
      html:`<div style="position:relative;text-align:center">
        ${pic}
        <div style="position:absolute;top:-18px;left:50%;transform:translateX(-50%);
          background:#080e18;color:${color};font-size:9px;padding:2px 5px;border-radius:2px;
          white-space:nowrap;font-family:'Share Tech Mono',monospace;border:1px solid ${color}44">
          ${label}</div></div>`,
      iconSize:[22,22], iconAnchor:[11,11] });
    S.playerMarkers[uid] = L.marker([player.lat,player.lng],{icon}).addTo(S.map);
  } else {
    S.playerMarkers[uid].setLatLng([player.lat,player.lng]);
  }
}

function drawPingMarker(uid, name, lat, lng) {
  const key = 'ping_'+uid;
  if (S.pingMarkers[key]) S.map.removeLayer(S.pingMarkers[key]);
  const icon = L.divIcon({ className:'',
    html:`<div style="position:relative"><div class="m-ping"></div><div class="m-ping-lbl">${name}</div></div>`,
    iconSize:[13,13], iconAnchor:[6,6] });
  S.pingMarkers[key] = L.marker([lat,lng],{icon}).addTo(S.map);
  S.lastPings = S.lastPings.filter(p=>p.id!==uid);
  S.lastPings.push({id:uid,name,ts:now()});
}

// ═══════════════════════════════════════════════════════════════
// TICK
// ═══════════════════════════════════════════════════════════════
function tick() {
  if (S.phase === 'ESCAPE') {
    S.escapeTimer--;
    if (S.escapeTimer <= 0) {
      S.phase = 'HUNT'; S.pingCooldown = 180;
      addEvent('⚡ Hunt phase! Hunters released.', 'danger');
      if (S.isHost) dbUpd(`games/${S.gameCode}/meta`, { phase:'HUNT' });
      document.getElementById('ov-phase').style.display = 'none';
      document.getElementById('ov-info').style.display = '';
    }
  } else if (S.phase === 'HUNT') {
    S.huntTimer++;
    S.pingCooldown--;
    if (S.pingCooldown <= 0) { firePing(); S.pingCooldown = 180; }
  }
  renderHUD();
}

// ═══════════════════════════════════════════════════════════════
// PINGS
// ═══════════════════════════════════════════════════════════════
function firePing() {
  S.pingsFired++;
  if ((S.myRole === 'RUNNER' || S.isSpectator) && S.myPos) {
    if (S.myRole === 'RUNNER') addEvent('📡 Your location was pinged to hunters.', 'ping');
    dbPush(`games/${S.gameCode}/pings/${S.uid}`, { lat:S.myPos.lat, lng:S.myPos.lng, ts:now() });
  }
  if (S.myRole === 'HUNTER') addEvent('📡 Ping received.', 'ping');
  updateInfoPanel();
}

function spectatorPing() {
  if (!S.isSpectator) return;
  let count = 0;
  Object.entries(S.players).forEach(([uid, p]) => {
    if (p.role === 'RUNNER' && !p.caught && p.lat) {
      dbPush(`games/${S.gameCode}/pings/${uid}`, { lat:p.lat, lng:p.lng, ts:now() });
      count++;
    }
  });
  addEvent(`👁 Spectator force-pinged ${count} runner${count!==1?'s':''}.`, 'ping');
  toast(`${count} runner${count!==1?'s':''} pinged`, 'var(--yellow)');
}

// ═══════════════════════════════════════════════════════════════
// HUD / PANELS
// ═══════════════════════════════════════════════════════════════
function renderHUD() {
  const esc = S.phase === 'ESCAPE';
  const hunterColor = 'var(--red)', runnerColor = 'var(--green)', specColor = 'var(--blue)';
  const myColor = S.isSpectator ? specColor : S.myRole==='HUNTER' ? hunterColor : runnerColor;

  document.getElementById('phase-lbl').textContent = esc ? 'ESCAPE PHASE' : 'HUNT PHASE';
  document.getElementById('phase-lbl').style.color  = esc ? 'var(--green)' : 'var(--red)';
  const tv = document.getElementById('timer-val');
  tv.textContent = esc ? fmt(S.escapeTimer) : fmt(S.huntTimer);
  tv.style.color  = esc ? (S.escapeTimer<60?'var(--red)':'var(--green)') : 'var(--red)';

  document.getElementById('chip-icon').textContent  = S.isSpectator ? '👁' : S.myRole==='HUNTER' ? '🎯' : '🏃';
  document.getElementById('chip-label').textContent = S.isSpectator ? 'SPECTATOR' : (S.myRole||'—');
  document.getElementById('chip-label').style.color = myColor;
  document.getElementById('role-chip').style.borderColor = myColor+'55';

  const pchip = document.getElementById('ping-chip');
  if (!esc && !S.isSpectator) {
    pchip.style.display = '';
    document.getElementById('ping-val').textContent = fmt(S.pingCooldown);
    document.getElementById('ping-val').style.color = S.pingCooldown<30 ? 'var(--yellow)' : 'var(--red)';
  } else {
    pchip.style.display = 'none';
  }

  if (esc) renderEscapeOverlay(); else updateInfoPanel();
}

function renderEscapeOverlay() {
  document.getElementById('ov-phase').style.display = '';
  const isHunter = S.myRole === 'HUNTER';
  const isSpec   = S.isSpectator;
  const box = document.getElementById('phase-box');
  const [ic, ti, su, bc, bg] = isSpec
    ? ['👁','SPECTATING',`Hunt in ${fmt(S.escapeTimer)}`,'rgba(168,218,220,.4)','rgba(168,218,220,.07)']
    : isHunter
    ? ['🔒','HUNTERS LOCKED',`Release in ${fmt(S.escapeTimer)}`,'rgba(255,77,109,.4)','rgba(255,77,109,.08)']
    : ['🏃','RUN! GET FAR AWAY',`Hunters release in ${fmt(S.escapeTimer)}`,'rgba(0,255,157,.4)','rgba(0,255,157,.06)'];
  document.getElementById('pb-icon').textContent  = ic;
  document.getElementById('pb-title').textContent = ti;
  document.getElementById('pb-title').style.color = isSpec?'var(--blue)':isHunter?'var(--red)':'var(--green)';
  document.getElementById('pb-sub').textContent   = su;
  box.style.borderColor = bc; box.style.background = bg;
}

function updateInfoPanel() {
  if (S.phase !== 'HUNT') return;
  document.getElementById('ov-info').style.display = '';
  if (S.isSpectator) {
    const runners = Object.values(S.players).filter(p=>p.role==='RUNNER'&&!p.caught).length;
    document.getElementById('info-label').textContent = '👁 SPECTATING';
    document.getElementById('info-label').style.color = 'var(--blue)';
    document.getElementById('info-body').innerHTML =
      `<div>🏃 ${runners} runner${runners!==1?'s':''} alive</div>
       <div>🎯 ${Object.values(S.players).filter(p=>p.role==='HUNTER').length} hunters</div>`;
    document.getElementById('info-sub').textContent = 'Tap PING ALL to expose runners';
  } else if (S.myRole === 'HUNTER') {
    document.getElementById('info-label').textContent = '📡 LAST KNOWN';
    document.getElementById('info-label').style.color = 'var(--red)';
    document.getElementById('info-body').innerHTML = S.lastPings.length
      ? S.lastPings.map(p=>`<div style="color:var(--yellow)">🟡 ${p.name} <span class="muted">${Math.round((now()-p.ts)/1000)}s ago</span></div>`).join('')
      : `<span class="muted">Waiting for first ping…</span>`;
    document.getElementById('info-sub').textContent = 'Yellow pins = snapshot, not live';
  } else {
    document.getElementById('info-label').textContent = 'STATUS';
    document.getElementById('info-label').style.color = 'var(--green)';
    document.getElementById('info-body').innerHTML =
      `Next ping <span style="color:${S.pingCooldown<30?'var(--red)':'var(--yellow)'}">${fmt(S.pingCooldown)}</span>`;
    document.getElementById('info-sub').textContent = 'Keep moving between pings';
  }
}

// ═══════════════════════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════════════════════
function addEvent(msg, type='info') {
  const log = document.getElementById('event-log');
  const div = document.createElement('div');
  div.className = 'event-item mono';
  div.style.color = type==='danger'?'var(--red)':type==='ping'?'var(--yellow)':'var(--muted)';
  div.textContent = msg;
  log.insertBefore(div, log.firstChild);
  while (log.children.length > 12) log.removeChild(log.lastChild);
}

// ═══════════════════════════════════════════════════════════════
// END GAME
// ═══════════════════════════════════════════════════════════════
function confirmEnd() {
  document.getElementById('confirm-overlay').classList.add('open');
}
function closeConfirm() {
  document.getElementById('confirm-overlay').classList.remove('open');
}
async function doEndGame() {
  closeConfirm();
  clearInterval(S.mainInterval);
  stopGPS(); dbOff(); releaseWakeLock();
  S.phase = 'DONE';
  if (S.isHost) await dbUpd(`games/${S.gameCode}/meta`, { phase:'DONE' });
  await saveResults();
  showLeaderboard();
}
function finishGame() {
  if (S.phase === 'DONE') return;
  clearInterval(S.mainInterval);
  stopGPS(); dbOff(); releaseWakeLock();
  S.phase = 'DONE';
  saveResults().then(showLeaderboard);
}

// ═══════════════════════════════════════════════════════════════
// SAVE RESULTS
// ═══════════════════════════════════════════════════════════════
async function saveResults() {
  const dist    = calcDist();
  const topSpd  = parseFloat(S.topSpeed.toFixed(1));
  const result  = {
    displayName: S.displayName,
    photoURL:    S.photoURL || '',
    role:        S.myRole || 'SPECTATOR',
    caught:      S.caught,
    dist:        Math.round(dist),
    topSpeed:    topSpd,
    kills:       S.kills,
    huntTime:    S.huntTimer,
    ts:          now(),
  };

  // Save to shared game results (all participants can read)
  await dbUpd(`games/${S.gameCode}/results/${S.uid}`, result);

  // Save to my game history
  await dbSet(`users/${S.uid}/games/${S.gameCode}`, { ...result, gameCode: S.gameCode });

  // Update career stats
  const snap = await db.ref(`users/${S.uid}/profile`).once('value');
  const p = snap.val() || {};
  await dbUpd(`users/${S.uid}/profile`, {
    kills:    (p.kills||0) + S.kills,
    caught:   (p.caught||0) + (S.caught ? 1 : 0),
    games:    (p.games||0) + 1,
    topSpeed: Math.max(p.topSpeed||0, topSpd),
  });
}

function calcDist() {
  return S.posHistory.length > 1
    ? S.posHistory.reduce((acc,p,i,a) => i===0?0:acc+haversine(a[i-1].lat,a[i-1].lng,p.lat,p.lng), 0)
    : 0;
}

// ═══════════════════════════════════════════════════════════════
// LEADERBOARD
// ═══════════════════════════════════════════════════════════════
async function showLeaderboard() {
  document.getElementById('lb-code').textContent = `GAME · ${S.gameCode}`;
  const myColor = S.isSpectator ? 'var(--blue)' : S.myRole==='HUNTER' ? 'var(--red)' : 'var(--green)';
  document.getElementById('lb-role-card').innerHTML =
    `<div style="font-size:24px;font-weight:900;color:${myColor}">
      ${S.isSpectator?'👁 Spectator':S.myRole==='HUNTER'?'🎯 Hunter':'🏃 Runner'}
      ${S.caught?' · <span style="color:var(--red)">CAUGHT</span>':''}
    </div>`;
  document.getElementById('s-dist').textContent  = `${Math.round(calcDist())}m`;
  document.getElementById('s-spd').textContent   = `${S.topSpeed.toFixed(1)} km/h`;
  document.getElementById('s-time').textContent  = fmt(S.huntTimer);
  document.getElementById('s-kills').textContent = S.kills;

  const snap = await db.ref(`games/${S.gameCode}/results`).once('value');
  const results = snap.val() || {};
  const rows = Object.values(results).sort((a,b)=>(b.kills||0)-(a.kills||0));
  document.getElementById('lb-players').innerHTML = rows.map((r,i) => {
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
    const color = r.role==='HUNTER'?'var(--red)':r.role==='SPECTATOR'?'var(--blue)':'var(--green)';
    const pic = r.photoURL
      ? `<img src="${r.photoURL}" style="width:32px;height:32px;border-radius:50%;object-fit:cover;border:1px solid ${color}"/>`
      : `<div style="width:32px;height:32px;border-radius:50%;background:var(--bg3);border:1px solid ${color};display:flex;align-items:center;justify-content:center;font-size:14px">👤</div>`;
    return `<div class="player-row">
      <div style="font-size:18px;width:24px">${medal}</div>
      ${pic}
      <div style="flex:1">
        <div style="font-weight:700;color:${color}">${r.displayName} <span class="mono muted" style="font-size:10px">${r.role}</span></div>
        <div class="mono muted" style="font-size:10px">${r.dist}m · ${r.topSpeed}km/h · ${r.kills} kill${r.kills!==1?'s':''}${r.caught?' · caught':''}</div>
      </div>
    </div>`;
  }).join('');
  showScreen('leaderboard');
}

function newGame() {
  if (S.map) { S.map.remove(); S.map=null; }
  S.myMarker=null; S.accCircle=null; S.playerMarkers={}; S.pingMarkers={};
  S.players={}; S.myRole=null; S.isHost=false; S.isSpectator=false;
  S.gameCode=null; S.boundary=[];
  showScreen('home');
}

// ═══════════════════════════════════════════════════════════════
// GAME HISTORY
// ═══════════════════════════════════════════════════════════════
async function goHistory() {
  showScreen('history');
  document.getElementById('history-list').innerHTML =
    `<div class="mono muted" style="text-align:center;padding:32px 0;font-size:12px">Loading…</div>`;
  const snap = await db.ref(`users/${S.uid}/games`).orderByChild('ts').limitToLast(30).once('value');
  const games = snap.val();
  if (!games) {
    document.getElementById('history-list').innerHTML =
      `<div class="mono muted" style="text-align:center;padding:32px 0;font-size:12px">No games yet. Play your first game!</div>`;
    return;
  }
  const sorted = Object.values(games).sort((a,b)=>b.ts-a.ts);
  document.getElementById('history-list').innerHTML = sorted.map(g => {
    const color = g.role==='HUNTER'?'var(--red)':g.role==='SPECTATOR'?'var(--blue)':'var(--green)';
    const date  = new Date(g.ts).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
    return `<div class="history-item" onclick="goGameDetail('${g.gameCode}')">
      <div class="row">
        <div style="flex:1">
          <div class="mono" style="font-size:10px;letter-spacing:2px;color:${color}">${g.role}</div>
          <div style="font-size:22px;font-weight:900;color:#fff;letter-spacing:3px">${g.gameCode}</div>
          <div class="mono muted" style="font-size:10px">${date} · ${g.dist}m · ${g.kills} kill${g.kills!==1?'s':''}${g.caught?' · caught':''}</div>
        </div>
        <div class="mono muted" style="font-size:22px">›</div>
      </div>
    </div>`;
  }).join('');
}

async function goGameDetail(gameCode) {
  showScreen('game-detail');
  document.getElementById('detail-header').innerHTML =
    `<div class="mono muted" style="font-size:9px;letter-spacing:3px">GAME</div>
     <div class="title-lg">${gameCode}</div>`;
  document.getElementById('detail-body').innerHTML =
    `<div class="mono muted" style="padding:20px 0;font-size:12px">Loading…</div>`;

  const snap = await db.ref(`games/${gameCode}/results`).once('value');
  const results = snap.val();
  if (!results) {
    document.getElementById('detail-body').innerHTML =
      `<div class="mono muted" style="padding:20px 0;font-size:12px">No data available.</div>`;
    return;
  }
  const rows = Object.values(results).sort((a,b)=>(b.kills||0)-(a.kills||0));
  document.getElementById('detail-body').innerHTML = `<div class="card">
    <span class="label">All Players</span>
    ${rows.map((r,i) => {
      const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
      const color = r.role==='HUNTER'?'var(--red)':r.role==='SPECTATOR'?'var(--blue)':'var(--green)';
      const pic = r.photoURL
        ? `<img src="${r.photoURL}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;border:1px solid ${color}"/>`
        : `<div style="width:36px;height:36px;border-radius:50%;background:var(--bg3);border:1px solid ${color};display:flex;align-items:center;justify-content:center;font-size:16px">👤</div>`;
      return `<div class="player-row" style="margin-top:8px">
        <div style="font-size:18px;width:24px">${medal}</div>
        ${pic}
        <div style="flex:1">
          <div style="font-weight:700;color:${color}">${r.displayName}
            <span class="mono muted" style="font-size:10px">${r.role}</span>
          </div>
          <div class="mono muted" style="font-size:10px;line-height:2">
            ${r.dist}m · ${r.topSpeed} km/h top · ${r.kills||0} kill${(r.kills||0)!==1?'s':''}
            · ${fmt(r.huntTime||0)} hunt time
            ${r.caught?' · <span style="color:var(--red)">CAUGHT</span>':''}
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// ═══════════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════════
async function goProfile() {
  showScreen('profile');
  document.getElementById('profile-name').textContent = S.displayName;
  // Photo
  const pic   = document.getElementById('profile-pic');
  const emoji = document.getElementById('profile-emoji');
  if (S.photoURL) {
    pic.src = S.photoURL; pic.style.display=''; emoji.style.display='none';
  } else {
    pic.style.display='none'; emoji.style.display='';
  }

  const snap = await db.ref(`users/${S.uid}/profile`).once('value');
  const p = snap.val() || {};
  document.getElementById('p-kills').textContent  = p.kills  || 0;
  document.getElementById('p-spd').textContent    = `${(p.topSpeed||0).toFixed(1)} km/h`;
  document.getElementById('p-games').textContent  = p.games  || 0;
  document.getElementById('p-caught').textContent = p.caught || 0;

  // Medals
  const medals = calcMedals(p);
  document.getElementById('profile-medals').innerHTML = medals.length
    ? medals.map(m=>`<div class="medal-item"><div class="medal-icon">${m.icon}</div><div class="medal-label">${m.label}</div></div>`).join('')
    : `<div class="mono muted" style="font-size:11px">Play more games to earn medals!</div>`;

  // Recent games
  const gSnap = await db.ref(`users/${S.uid}/games`).orderByChild('ts').limitToLast(5).once('value');
  const games = gSnap.val();
  document.getElementById('p-recent').innerHTML = games
    ? Object.values(games).sort((a,b)=>b.ts-a.ts).map(g => {
        const color = g.role==='HUNTER'?'var(--red)':g.role==='SPECTATOR'?'var(--blue)':'var(--green)';
        const date  = new Date(g.ts).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
        return `<div style="padding:9px 0;border-bottom:1px solid var(--border)">
          <div class="mono" style="font-size:10px;color:${color}">${g.role} · ${g.gameCode} · ${date}</div>
          <div class="mono muted" style="font-size:10px">${g.dist}m · ${g.kills} kill${g.kills!==1?'s':''}${g.caught?' · caught':''}</div>
        </div>`;
      }).join('')
    : `<div class="mono muted" style="font-size:11px">No games yet.</div>`;
}

function calcMedals(p) {
  const m = [];
  if ((p.kills||0) >= 1)  m.push({icon:'🥉',label:'First Blood'});
  if ((p.kills||0) >= 5)  m.push({icon:'🥈',label:'Hunter'});
  if ((p.kills||0) >= 15) m.push({icon:'🥇',label:'Apex Predator'});
  if ((p.topSpeed||0) >= 10) m.push({icon:'⚡',label:'Fast'});
  if ((p.topSpeed||0) >= 20) m.push({icon:'🚀',label:'Sprinter'});
  if ((p.games||0) >= 5)  m.push({icon:'🎮',label:'Veteran'});
  if ((p.games||0) >= 20) m.push({icon:'🏆',label:'Legend'});
  if ((p.games||0) >= 5 && (p.caught||0) === 0) m.push({icon:'👻',label:'Ghost'});
  return m;
}

// ═══════════════════════════════════════════════════════════════
// WAKE LOCK
// ═══════════════════════════════════════════════════════════════
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen'); } catch(e){}
}
function releaseWakeLock() {
  if (S.wakeLock) { S.wakeLock.release(); S.wakeLock=null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.phase === 'HUNT') acquireWakeLock();
});
