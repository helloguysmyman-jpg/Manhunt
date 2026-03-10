// ═══════════════════════════════════════════════════════════════════════════
// MANHUNT — app.js
// ═══════════════════════════════════════════════════════════════════════════
//
// FIREBASE SETUP:
//   1. Create a project at https://console.firebase.google.com
//   2. Enable: Authentication (Email/Password), Realtime Database, Hosting
//   3. Replace the firebaseConfig object below with your project's config
//   4. In Realtime DB rules, use the rules from firebase-rules.json
//
// REALTIME DB SCHEMA:
//   games/{gameCode}/
//     meta: { hostUid, hunterCount, phase, createdAt }
//     players/{uid}: { displayName, role, lat, lng, caught, joinedAt }
//     pings/{uid}/{pingId}: { lat, lng, ts }   ← hunters read this
//     events/{eventId}: { msg, type, ts }
//
// ═══════════════════════════════════════════════════════════════════════════

// ─── Firebase Config (REPLACE WITH YOURS) ────────────────────────────────
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT.firebaseapp.com",
  databaseURL:       "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId:         "YOUR_PROJECT",
  storageBucket:     "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId:             "YOUR_APP_ID",
};

// ─── Feature flags ────────────────────────────────────────────────────────
const USE_FIREBASE = false; // ← set true once your config is filled in

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
const S = {
  // Auth
  uid:         null,
  displayName: null,
  isHost:      false,

  // Game
  gameCode:    null,
  myRole:      null,   // 'HUNTER' | 'RUNNER' — assigned by host at start
  hunterCount: 1,
  phase:       null,   // 'ESCAPE' | 'HUNT' | 'DONE'
  players:     {},     // uid -> { displayName, role, lat, lng, caught }

  // Timers
  escapeTimer:  600,
  huntTimer:    0,
  pingCooldown: 180,
  pingsFired:   0,
  caught:       false,
  mainInterval: null,
  pingAgeTimer: null,

  // GPS
  myPos:     null,
  watchId:   null,
  posHistory: [],

  // Map
  map:            null,
  myMarker:       null,
  accuracyCircle: null,
  pingMarkers:    {},
  lastKnownPings: [],
  _centered:      false,

  // Firebase listeners (so we can detach them)
  dbListeners: [],

  // Wake Lock
  wakeLock: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// FIREBASE SHIM
// ═══════════════════════════════════════════════════════════════════════════
let db = null, auth = null;

function initFirebase() {
  if (!USE_FIREBASE) return;
  firebase.initializeApp(firebaseConfig);
  db   = firebase.database();
  auth = firebase.auth();

  auth.onAuthStateChanged(user => {
    if (user) {
      S.uid         = user.uid;
      S.displayName = user.displayName || user.email.split('@')[0];
      showScreen('home');
    } else {
      showScreen('auth');
    }
  });
}

// DB helpers
function dbSet(path, data)   { return USE_FIREBASE ? db.ref(path).set(data)    : Promise.resolve(); }
function dbUpdate(path, data){ return USE_FIREBASE ? db.ref(path).update(data) : Promise.resolve(); }
function dbPush(path, data)  { return USE_FIREBASE ? db.ref(path).push(data)   : Promise.resolve(); }
function dbOn(path, cb) {
  if (!USE_FIREBASE) return;
  const ref = db.ref(path);
  ref.on('value', snap => cb(snap.val()));
  S.dbListeners.push(ref);
}
function dbOff() {
  S.dbListeners.forEach(ref => ref.off());
  S.dbListeners = [];
}

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function genCode()     { return Math.random().toString(36).slice(2, 8).toUpperCase(); }
function fmt(s)        { s=Math.max(0,s); return Math.floor(s/60)+':'+(s%60).toString().padStart(2,'0'); }
function uid6()        { return Math.random().toString(36).slice(2, 8); }
function haversine(a,b,c,d) {
  const R=6371000, dlat=(c-a)*Math.PI/180, dlng=(d-b)*Math.PI/180;
  const x=Math.sin(dlat/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dlng/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
}

function toast(msg, color = 'var(--green)') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.color = color;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('auth-login-form').style.display  = tab === 'login'    ? 'block' : 'none';
  document.getElementById('auth-signup-form').style.display = tab === 'signup'   ? 'block' : 'none';
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  if (!email || !pass) { errEl.textContent = 'Enter email and password.'; return; }

  if (USE_FIREBASE) {
    try {
      await auth.signInWithEmailAndPassword(email, pass);
    } catch(e) { errEl.textContent = e.message; }
  } else {
    // Demo mode: bypass auth
    S.uid = uid6(); S.displayName = email.split('@')[0];
    showScreen('home');
  }
}

async function doSignup() {
  const name  = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pass  = document.getElementById('signup-pass').value;
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';
  if (!name || !email || !pass) { errEl.textContent = 'All fields required.'; return; }
  if (pass.length < 6)          { errEl.textContent = 'Password must be 6+ characters.'; return; }

  if (USE_FIREBASE) {
    try {
      const cred = await auth.createUserWithEmailAndPassword(email, pass);
      await cred.user.updateProfile({ displayName: name });
      S.uid = cred.user.uid; S.displayName = name;
      showScreen('home');
    } catch(e) { errEl.textContent = e.message; }
  } else {
    S.uid = uid6(); S.displayName = name;
    showScreen('home');
  }
}

async function doLogout() {
  if (USE_FIREBASE) await auth.signOut();
  S.uid = null; S.displayName = null;
  showScreen('auth');
}

// ═══════════════════════════════════════════════════════════════════════════
// HOME
// ═══════════════════════════════════════════════════════════════════════════
function goHome() {
  document.getElementById('home-name').textContent = S.displayName || 'Player';
  showScreen('home');
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE
// ═══════════════════════════════════════════════════════════════════════════
let _hunterCount = 1;

function goCreate() {
  S.gameCode = genCode();
  S.isHost   = true;
  _hunterCount = 1;
  document.getElementById('create-code').textContent  = S.gameCode;
  document.getElementById('hunter-count').textContent = _hunterCount;
  showScreen('create');
}

function changeHunters(d) {
  _hunterCount = Math.max(1, Math.min(4, _hunterCount + d));
  document.getElementById('hunter-count').textContent = _hunterCount;
}

async function createAndLobby() {
  S.hunterCount = _hunterCount;
  S.players = {};

  // Register game in Firebase
  await dbSet(`games/${S.gameCode}/meta`, {
    hostUid:      S.uid,
    hunterCount:  S.hunterCount,
    phase:        'WAITING',
    createdAt:    Date.now(),
  });

  // Register self as a player (no role yet — assigned at start)
  await dbSet(`games/${S.gameCode}/players/${S.uid}`, {
    displayName: S.displayName,
    role:        null,
    caught:      false,
    joinedAt:    Date.now(),
  });

  enterLobby();
}

// ═══════════════════════════════════════════════════════════════════════════
// JOIN
// ═══════════════════════════════════════════════════════════════════════════
function goJoin() { showScreen('join'); }

function onJoinCodeInput() {
  const v   = document.getElementById('join-input').value;
  const btn = document.getElementById('join-btn');
  btn.disabled = v.length < 6;
}

async function joinAndLobby() {
  const code = document.getElementById('join-input').value.toUpperCase().trim();
  S.gameCode = code;
  S.isHost   = false;

  if (USE_FIREBASE) {
    // Verify game exists
    const snap = await db.ref(`games/${code}/meta`).once('value');
    if (!snap.exists()) { toast('Game not found.', 'var(--red)'); return; }
    const meta = snap.val();
    if (meta.phase !== 'WAITING') { toast('Game already started.', 'var(--red)'); return; }
  }

  // Register as player — NO role selection, assigned by host
  await dbSet(`games/${S.gameCode}/players/${S.uid}`, {
    displayName: S.displayName,
    role:        null,
    caught:      false,
    joinedAt:    Date.now(),
  });

  enterLobby();
}

// ═══════════════════════════════════════════════════════════════════════════
// LOBBY
// ═══════════════════════════════════════════════════════════════════════════
function enterLobby() {
  document.getElementById('lobby-code').textContent   = S.gameCode;
  document.getElementById('waiting-code').textContent = S.gameCode;
  document.getElementById('lobby-start-btn').style.display = S.isHost ? 'block' : 'none';
  document.getElementById('lobby-waiting-msg').style.display = S.isHost ? 'none' : 'block';

  renderLobbyPlayers();
  showScreen('lobby');
  startGPS(updateLobbyGPS);

  // Listen for player list changes
  dbOn(`games/${S.gameCode}/players`, data => {
    if (!data) return;
    S.players = data;
    renderLobbyPlayers();
  });

  // Non-hosts listen for game start
  if (!S.isHost) {
    dbOn(`games/${S.gameCode}/meta`, meta => {
      if (meta && meta.phase === 'ESCAPE') {
        dbOff();
        S.myRole = (S.players[S.uid] || {}).role || 'RUNNER';
        _beginGame();
      }
    });
  }
}

function renderLobbyPlayers() {
  const list = document.getElementById('player-list');
  const avatars = ['🧑','👩','🧔','👱','🧕','👦','👧','🧒'];
  list.innerHTML = Object.entries(S.players).map(([uid, p], i) => {
    const isYou = uid === S.uid;
    return `
      <div class="player-row" style="border-left:3px solid ${isYou?'var(--green)':'var(--border)'}">
        <div class="player-avatar">${avatars[i % avatars.length]}</div>
        <div>
          <div class="player-name">${p.displayName}${isYou ? ' <span style="color:var(--muted);font-size:11px">(you)</span>' : ''}</div>
          <div class="player-sub">${isYou && S.isHost ? 'Host' : 'Player'}</div>
        </div>
        <div class="player-badge muted" style="border-color:var(--muted)">PENDING</div>
      </div>`;
  }).join('');
}

function updateLobbyGPS(pos, err) {
  const el = document.getElementById('gps-status');
  if (err) {
    el.innerHTML = `<span style="color:var(--red)">⚠ GPS: ${err}</span>`;
  } else {
    el.innerHTML = `<span style="color:var(--green)">✓ GPS ±${Math.round(pos.accuracy||0)}m</span>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME START (host only)
// ═══════════════════════════════════════════════════════════════════════════
async function hostStartGame() {
  const uids      = Object.keys(S.players);
  const shuffled  = [...uids].sort(() => Math.random() - .5);
  const hunterUids = shuffled.slice(0, S.hunterCount);

  // Assign roles in Firebase
  const updates = {};
  uids.forEach(uid => {
    const role = hunterUids.includes(uid) ? 'HUNTER' : 'RUNNER';
    updates[`games/${S.gameCode}/players/${uid}/role`] = role;
    if (uid === S.uid) S.myRole = role;
  });
  await dbUpdate('/', updates);

  // Set phase → triggers all clients
  await dbUpdate(`games/${S.gameCode}/meta`, { phase: 'ESCAPE' });
  await dbPush(`games/${S.gameCode}/events`, { msg: '🚨 Game started! Runners — RUN!', type: 'danger', ts: Date.now() });

  dbOff();
  _beginGame();
}

function _beginGame() {
  S.phase       = 'ESCAPE';
  S.escapeTimer = 600;
  S.huntTimer   = 0;
  S.pingCooldown= 180;
  S.pingsFired  = 0;
  S.caught      = false;
  S.posHistory  = [];
  S.lastKnownPings = [];
  S._centered   = false;

  showScreen('game');
  initMap();
  renderHUD();
  addEvent('🚨 Game started! Runners — RUN NOW!', 'danger');
  acquireWakeLock();
  S.mainInterval = setInterval(tick, 1000);

  // Listen for other players' positions (if Firebase connected)
  if (USE_FIREBASE) {
    dbOn(`games/${S.gameCode}/players`, data => {
      if (!data) return;
      S.players = data;
      // Update markers for other players
      Object.entries(data).forEach(([uid, p]) => {
        if (uid === S.uid) return;
        updateOtherPlayerMarker(uid, p);
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GPS
// ═══════════════════════════════════════════════════════════════════════════
function startGPS(callback) {
  if (!navigator.geolocation) {
    callback && callback(null, 'Geolocation not supported on this device.');
    return;
  }
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = navigator.geolocation.watchPosition(
    pos => {
      const loc = {
        lat:      pos.coords.latitude,
        lng:      pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        speed:    pos.coords.speed,
        ts:       Date.now(),
      };
      S.myPos = loc;
      S.posHistory.push(loc);
      if (S.posHistory.length > 1000) S.posHistory = S.posHistory.slice(-800);

      callback && callback(loc, null);
      if (S.phase) onGPSUpdate(loc);

      // Push position to Firebase so other players can see you
      // Only push if in hunt phase (escape: runners hide their position from hunters)
      if (USE_FIREBASE && S.phase === 'HUNT') {
        dbUpdate(`games/${S.gameCode}/players/${S.uid}`, { lat: loc.lat, lng: loc.lng });
      }
    },
    err => { callback && callback(null, err.message); },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}

function stopGPS() {
  if (S.watchId != null) { navigator.geolocation.clearWatch(S.watchId); S.watchId = null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAP
// ═══════════════════════════════════════════════════════════════════════════
function initMap() {
  if (S.map) { S.map.remove(); S.map = null; S.myMarker = null; S.accuracyCircle = null; S.pingMarkers = {}; }

  const center = S.myPos ? [S.myPos.lat, S.myPos.lng] : [51.505, -0.09];
  S.map = L.map('map', { center, zoom: 17, zoomControl: true });

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://openstreetmap.org">OSM</a>',
    maxZoom: 20,
  }).addTo(S.map);

  if (S.myPos) {
    placeMyMarker(S.myPos);
    document.getElementById('ov-acquiring').style.display = 'none';
  }
}

function onGPSUpdate(loc) {
  document.getElementById('ov-acquiring').style.display = 'none';
  placeMyMarker(loc);
}

function placeMyMarker(loc) {
  const color = S.myRole === 'HUNTER' ? '#ff4d6d' : '#00ff9d';
  if (!S.myMarker) {
    const icon = L.divIcon({
      className: '',
      html: `<div class="m-me" style="background:${color};box-shadow:0 0 14px ${color}"></div>`,
      iconSize: [18,18], iconAnchor: [9,9],
    });
    S.myMarker = L.marker([loc.lat, loc.lng], { icon, zIndexOffset: 1000 })
      .addTo(S.map).bindPopup(`<b>You (${S.myRole})</b>`);
  } else {
    S.myMarker.setLatLng([loc.lat, loc.lng]);
  }
  if (loc.accuracy) {
    if (!S.accuracyCircle) {
      S.accuracyCircle = L.circle([loc.lat, loc.lng], {
        radius: loc.accuracy, color, fillColor: color, fillOpacity: .07, weight: 1,
      }).addTo(S.map);
    } else {
      S.accuracyCircle.setLatLng([loc.lat, loc.lng]).setRadius(loc.accuracy);
    }
  }
  if (!S._centered) { S.map.setView([loc.lat, loc.lng], 17); S._centered = true; }
}

function updateOtherPlayerMarker(uid, player) {
  // Show other players' markers — only hunters see runners during hunt phase
  // (runners don't see each other's live position)
  if (!player.lat || !player.lng) return;
  if (S.myRole === 'RUNNER' && player.role === 'RUNNER') return; // runners hidden from each other

  const color = player.role === 'HUNTER' ? '#ff4d6d' : '#ffd166';
  if (!S.pingMarkers[uid]) {
    const icon = L.divIcon({
      className: '',
      html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 10px ${color}"></div>`,
      iconSize:[14,14], iconAnchor:[7,7],
    });
    S.pingMarkers[uid] = L.marker([player.lat, player.lng], { icon })
      .addTo(S.map).bindPopup(`<b>${player.displayName}</b> (${player.role})`);
  } else {
    S.pingMarkers[uid].setLatLng([player.lat, player.lng]);
  }
}

function placePingMarker(uid, name, lat, lng) {
  // Only hunters call this. Yellow pin = last-known snapshot.
  if (S.pingMarkers['ping_'+uid]) S.map.removeLayer(S.pingMarkers['ping_'+uid]);
  const icon = L.divIcon({
    className: '',
    html: `<div style="position:relative">
      <div class="m-ping"></div>
      <div class="m-ping-lbl">${name}</div>
    </div>`,
    iconSize:[13,13], iconAnchor:[6,6],
  });
  S.pingMarkers['ping_'+uid] = L.marker([lat,lng], {icon}).addTo(S.map)
    .bindPopup(`<b>${name}</b><br>Ping snapshot — not live`);
  S.lastKnownPings = S.lastKnownPings.filter(p=>p.id!==uid);
  S.lastKnownPings.push({ id:uid, name, lat, lng, ts:Date.now() });
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME TICK
// ═══════════════════════════════════════════════════════════════════════════
function tick() {
  if (S.phase === 'ESCAPE') {
    S.escapeTimer--;
    if (S.escapeTimer <= 0) {
      S.phase = 'HUNT';
      S.pingCooldown = 180;
      addEvent('⚡ Hunt phase! Hunters released.', 'danger');
      if (USE_FIREBASE && S.isHost) dbUpdate(`games/${S.gameCode}/meta`, { phase: 'HUNT' });
      renderHuntOverlays();
    }
  } else if (S.phase === 'HUNT') {
    S.huntTimer++;
    S.pingCooldown--;
    if (S.pingCooldown <= 0) {
      firePing();
      S.pingCooldown = 180;
    }
  }
  renderHUD();
}

function firePing() {
  S.pingsFired++;

  if (S.myRole === 'RUNNER' && S.myPos) {
    addEvent('📡 Your location was pinged to hunters!', 'ping');
    // Push ping snapshot to Firebase — hunters will read this
    if (USE_FIREBASE) {
      dbPush(`games/${S.gameCode}/pings/${S.uid}`, {
        lat: S.myPos.lat, lng: S.myPos.lng, ts: Date.now(),
      });
    }
  }

  if (S.myRole === 'HUNTER') {
    addEvent('📡 Ping received — runner locations updated.', 'ping');

    if (USE_FIREBASE) {
      // Read latest ping for each runner from Firebase
      Object.entries(S.players)
        .filter(([,p]) => p.role === 'RUNNER' && !p.caught)
        .forEach(([uid, p]) => {
          db.ref(`games/${S.gameCode}/pings/${uid}`)
            .orderByChild('ts').limitToLast(1).once('value', snap => {
              const pings = snap.val();
              if (!pings) return;
              const latest = Object.values(pings)[0];
              placePingMarker(uid, p.displayName, latest.lat, latest.lng);
            });
        });
    } else {
      // Demo: drop a fake nearby ping
      if (S.myPos) {
        placePingMarker('demo', 'Runner', S.myPos.lat+(Math.random()-.5)*.003, S.myPos.lng+(Math.random()-.5)*.003);
      }
    }
  }

  if (S.myRole === 'HUNTER') renderHunterPanel();
}

// ═══════════════════════════════════════════════════════════════════════════
// HUD RENDERING
// ═══════════════════════════════════════════════════════════════════════════
function renderHUD() {
  const isEscape = S.phase === 'ESCAPE';
  const isHunter = S.myRole === 'HUNTER';
  const accent   = isHunter ? 'var(--red)' : 'var(--green)';

  // Timer
  const timerEl = document.getElementById('timer-val');
  document.getElementById('phase-lbl').textContent = isEscape ? 'ESCAPE PHASE' : 'HUNT PHASE';
  document.getElementById('phase-lbl').style.color = isEscape ? 'var(--green)' : 'var(--red)';
  timerEl.textContent = isEscape ? fmt(S.escapeTimer) : fmt(S.huntTimer);
  timerEl.style.color = isEscape
    ? (S.escapeTimer < 60 ? 'var(--red)' : 'var(--green)')
    : 'var(--red)';

  // Role chip
  const chip = document.getElementById('role-chip');
  document.getElementById('chip-icon').textContent  = isHunter ? '🎯' : '🏃';
  document.getElementById('chip-label').textContent = S.myRole;
  document.getElementById('chip-label').style.color = accent;
  chip.style.borderColor = isHunter ? 'rgba(255,77,109,.4)' : 'rgba(0,255,157,.3)';
  chip.style.background  = isHunter ? 'rgba(255,77,109,.12)' : 'rgba(0,255,157,.1)';

  // Ping chip
  const pchip = document.getElementById('ping-chip');
  if (!isEscape) {
    pchip.style.display = 'block';
    const hot = S.pingCooldown < 30;
    document.getElementById('ping-val').textContent  = fmt(S.pingCooldown);
    document.getElementById('ping-val').style.color  = hot ? 'var(--yellow)' : 'var(--red)';
    pchip.style.borderColor = hot ? 'rgba(255,209,102,.4)' : 'rgba(255,77,109,.3)';
    pchip.style.background  = hot ? 'rgba(255,209,102,.1)' : 'rgba(255,77,109,.1)';
  } else {
    pchip.style.display = 'none';
  }

  // Overlays
  if (isEscape) renderEscapeOverlay();
}

function renderEscapeOverlay() {
  const isHunter = S.myRole === 'HUNTER';
  const ov = document.getElementById('ov-phase');
  ov.style.display = 'block';
  document.getElementById('pb-icon').textContent  = isHunter ? '🔒' : '🏃';
  document.getElementById('pb-title').textContent = isHunter ? 'HUNTERS LOCKED' : 'RUN! GET FAR AWAY';
  document.getElementById('pb-title').style.color = isHunter ? 'var(--red)' : 'var(--green)';
  document.getElementById('pb-sub').textContent   = isHunter
    ? `Runners flee — you release in ${fmt(S.escapeTimer)}`
    : `Hunters release in ${fmt(S.escapeTimer)}`;
  const box = document.getElementById('phase-box');
  box.style.borderColor = isHunter ? 'rgba(255,77,109,.45)' : 'rgba(0,255,157,.4)';
  box.style.background  = isHunter ? 'rgba(255,77,109,.1)' : 'rgba(0,255,157,.08)';
}

function renderHuntOverlays() {
  document.getElementById('ov-phase').style.display = 'none';
  document.getElementById('ov-info').style.display  = 'block';
  if (S.myRole === 'HUNTER') renderHunterPanel();
  else renderRunnerPanel();
}

function renderHunterPanel() {
  document.getElementById('info-label').textContent = '📡 LAST KNOWN POSITIONS';
  document.getElementById('info-label').style.color = 'var(--red)';
  document.getElementById('ov-info').style.borderColor = 'rgba(255,77,109,.25)';
  const c = document.getElementById('info-content');
  if (S.lastKnownPings.length === 0) {
    c.innerHTML = `<span class="muted">Waiting for first ping…</span>`;
  } else {
    c.innerHTML = S.lastKnownPings.map(p => {
      const ago = Math.round((Date.now() - p.ts) / 1000);
      return `<div style="color:var(--yellow)">🟡 ${p.name} <span class="muted">${ago}s ago</span></div>`;
    }).join('');
  }
  document.getElementById('info-sub').textContent = 'Yellow pins = snapshot only, not live';
}

function renderRunnerPanel() {
  document.getElementById('info-label').textContent = 'YOUR STATUS';
  document.getElementById('info-label').style.color = 'var(--green)';
  document.getElementById('ov-info').style.borderColor = 'rgba(0,255,157,.2)';
  const hot = S.pingCooldown < 30;
  document.getElementById('info-content').innerHTML =
    `Next ping in <span style="color:${hot?'var(--red)':'var(--yellow)'}">${fmt(S.pingCooldown)}</span>`;
  document.getElementById('info-sub').textContent = 'Keep moving between pings';
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LOG
// ═══════════════════════════════════════════════════════════════════════════
function addEvent(msg, type = 'info') {
  const log = document.getElementById('event-log');
  const div = document.createElement('div');
  div.className = 'event-item mono';
  div.style.color = type==='danger' ? 'var(--red)' : type==='ping' ? 'var(--yellow)' : 'var(--muted)';
  div.textContent = msg;
  log.insertBefore(div, log.firstChild);
  if (log.children.length > 20) log.removeChild(log.lastChild);
}

// ═══════════════════════════════════════════════════════════════════════════
// END GAME / LEADERBOARD
// ═══════════════════════════════════════════════════════════════════════════
function endGame() {
  clearInterval(S.mainInterval);
  stopGPS();
  dbOff();
  releaseWakeLock();
  S.phase = 'DONE';
  if (USE_FIREBASE && S.isHost) dbUpdate(`games/${S.gameCode}/meta`, { phase: 'DONE' });
  showLeaderboard();
}

function showLeaderboard() {
  const dist = S.posHistory.length > 1
    ? S.posHistory.reduce((acc,p,i,a)=>i===0?0:acc+haversine(a[i-1].lat,a[i-1].lng,p.lat,p.lng), 0)
    : 0;
  const speeds = S.posHistory.filter(p=>p.speed!=null&&p.speed>=0).map(p=>p.speed*3.6);
  const avgSpeed = speeds.length ? (speeds.reduce((a,b)=>a+b,0)/speeds.length).toFixed(1) : null;
  const isHunter = S.myRole === 'HUNTER';

  document.getElementById('lb-code').textContent = `GAME · ${S.gameCode}`;
  document.getElementById('lb-role').innerHTML =
    `<div style="font-size:28px;font-weight:900;color:${isHunter?'var(--red)':'var(--green)'}">
      ${isHunter?'🎯 Hunter':'🏃 Runner'}${S.caught?' · CAUGHT':''}
    </div>`;
  document.getElementById('stat-dist').textContent   = `${Math.round(dist)}m`;
  document.getElementById('stat-time').textContent   = fmt(S.huntTimer);
  document.getElementById('stat-speed').textContent  = avgSpeed ? `${avgSpeed} km/h` : '—';
  document.getElementById('stat-pings').textContent  = S.pingsFired;
  document.getElementById('stat-samples').textContent= `${S.posHistory.length} GPS samples`;

  showScreen('leaderboard');
}

function newGame() {
  if (S.map) { S.map.remove(); S.map = null; }
  S.myMarker = null; S.accuracyCircle = null; S.pingMarkers = {};
  S.lastKnownPings = []; S._centered = false;
  S.players = {}; S.myRole = null; S.isHost = false;
  S.gameCode = null;
  showScreen('home');
}

// ═══════════════════════════════════════════════════════════════════════════
// WAKE LOCK
// ═══════════════════════════════════════════════════════════════════════════
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen');
  } catch(e) {}
}
function releaseWakeLock() {
  if (S.wakeLock) { S.wakeLock.release(); S.wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.phase === 'HUNT') acquireWakeLock();
});

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE WORKER REGISTRATION
// ═══════════════════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js')
    .then(reg => console.log('[SW] registered', reg.scope))
    .catch(err => console.warn('[SW] failed:', err));

  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data.type === 'SYNC_COMPLETE') toast('Pings synced after reconnect', 'var(--yellow)');
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════
window.addEventListener('DOMContentLoaded', () => {
  if (USE_FIREBASE) {
    initFirebase(); // will route to auth or home based on auth state
  } else {
    // Demo mode: skip auth, go straight to home
    S.uid = uid6();
    S.displayName = 'Player';
    showScreen('home');
  }
});
