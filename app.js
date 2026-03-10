// ═══════════════════════════════════════════════════════════════════════════
// MANHUNT — app.js  (v3 — full Firebase, boundaries, spectator, profile)
// ═══════════════════════════════════════════════════════════════════════════

// ─── Firebase Config ─────────────────────────────────────────────────────
const firebaseConfig = {
  apiKey:            "AIzaSyA9GXHq5N9fczDx_cXdZKrHB8NdSlEz1bE",
  authDomain:        "manhunt-49350.firebaseapp.com",
  databaseURL:       "https://manhunt-49350-default-rtdb.firebaseio.com",
  projectId:         "manhunt-49350",
  storageBucket:     "manhunt-49350.firebasestorage.app",
  messagingSenderId: "785860141000",
  appId:             "1:785860141000:web:0c07351336d4c9bb702afd",
};

firebase.initializeApp(firebaseConfig);
const db   = firebase.database();
const auth = firebase.auth();

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════
const S = {
  uid: null, displayName: null,
  isHost: false, isSpectator: false,
  gameCode: null, myRole: null,
  hunterCount: 1, hostMode: 'play',
  phase: null,
  players: {},
  escapeTimer: 600, huntTimer: 0,
  pingCooldown: 180, pingsFired: 0,
  kills: 0,
  caught: false,
  mainInterval: null,
  myPos: null, watchId: null,
  posHistory: [],
  topSpeed: 0,
  map: null, myMarker: null, accuracyCircle: null,
  pingMarkers: {}, playerMarkers: {},
  lastKnownPings: [], _centered: false,
  boundary: [],         // array of {lat,lng}
  boundaryPolygon: null,
  boundaryLayer: null,
  drawingMode: false,
  drawTempMarkers: [],
  oobActive: false, oobTimer: 0, oobInterval: null,
  dbListeners: [],
  wakeLock: null,

  // boundary map (create screen)
  bMap: null, bPolyline: null, bMarkers: [],
};

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════
function genCode()  { return Math.random().toString(36).slice(2,8).toUpperCase(); }
function fmt(s)     { s=Math.max(0,s); return Math.floor(s/60)+':'+(s%60).toString().padStart(2,'0'); }
function uid6()     { return Math.random().toString(36).slice(2,8); }
function now()      { return Date.now(); }

function haversine(a,b,c,d) {
  const R=6371000, f=(c-a)*Math.PI/180, g=(d-b)*Math.PI/180;
  const x=Math.sin(f/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(g/2)**2;
  return R*2*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}

// Point-in-polygon (ray casting)
function pointInPolygon(lat, lng, polygon) {
  if (!polygon || polygon.length < 3) return true; // no boundary = always in
  let inside = false;
  for (let i=0, j=polygon.length-1; i<polygon.length; j=i++) {
    const xi=polygon[i].lat, yi=polygon[i].lng;
    const xj=polygon[j].lat, yj=polygon[j].lng;
    if (((yi>lng)!==(yj>lng)) && (lat < (xj-xi)*(lng-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
  document.getElementById('screen-'+name).classList.add('active');
}

function toast(msg, color='var(--green)') {
  const t=document.getElementById('toast');
  t.textContent=msg; t.style.color=color;
  t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),2800);
}

// ═══════════════════════════════════════════════════════════════════════════
// FIREBASE HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function dbSet(path,data)    { return db.ref(path).set(data); }
function dbUpdate(path,data) { return db.ref(path).update(data); }
function dbPush(path,data)   { return db.ref(path).push(data); }
function dbOn(path,cb) {
  const ref=db.ref(path);
  ref.on('value',snap=>cb(snap.val()));
  S.dbListeners.push(ref);
}
function dbOff() { S.dbListeners.forEach(r=>r.off()); S.dbListeners=[]; }

// ═══════════════════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════════════════
auth.onAuthStateChanged(user => {
  if (user) {
    S.uid = user.uid;
    S.displayName = user.displayName || user.email.split('@')[0];
    document.getElementById('home-name').textContent = S.displayName;
    showScreen('home');
  } else {
    showScreen('auth');
  }
});

function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
  document.getElementById('tab-'+tab).classList.add('active');
  document.getElementById('auth-login-form').style.display  = tab==='login'  ? 'block':'none';
  document.getElementById('auth-signup-form').style.display = tab==='signup' ? 'block':'none';
}

async function doLogin() {
  const email=document.getElementById('login-email').value.trim();
  const pass =document.getElementById('login-pass').value;
  const err  =document.getElementById('login-error');
  err.textContent='';
  if (!email||!pass){err.textContent='Enter email and password.';return;}
  try { await auth.signInWithEmailAndPassword(email,pass); }
  catch(e){err.textContent=e.message;}
}

async function doSignup() {
  const name =document.getElementById('signup-name').value.trim();
  const email=document.getElementById('signup-email').value.trim();
  const pass =document.getElementById('signup-pass').value;
  const err  =document.getElementById('signup-error');
  err.textContent='';
  if(!name||!email||!pass){err.textContent='All fields required.';return;}
  if(pass.length<6){err.textContent='Password must be 6+ characters.';return;}
  try {
    const cred=await auth.createUserWithEmailAndPassword(email,pass);
    await cred.user.updateProfile({displayName:name});
    S.uid=cred.user.uid; S.displayName=name;
    await dbSet(`users/${S.uid}/profile`,{displayName:name,kills:0,caught:0,games:0,topSpeed:0,createdAt:now()});
  } catch(e){err.textContent=e.message;}
}

async function doLogout() {
  dbOff(); stopGPS();
  await auth.signOut();
}

// ═══════════════════════════════════════════════════════════════════════════
// HOME
// ═══════════════════════════════════════════════════════════════════════════
function goHome() {
  document.getElementById('home-name').textContent=S.displayName||'Player';
  showScreen('home');
}

// ═══════════════════════════════════════════════════════════════════════════
// CREATE GAME
// ═══════════════════════════════════════════════════════════════════════════
let _hunterCount=1;

function goCreate() {
  S.gameCode=genCode();
  S.isHost=true;
  S.hostMode='play';
  S.boundary=[];
  _hunterCount=1;
  document.getElementById('create-code').textContent=S.gameCode;
  document.getElementById('hunter-count').textContent=1;
  document.getElementById('spec-desc').style.display='none';
  document.getElementById('btn-host-play').style.color='var(--green)';
  document.getElementById('btn-host-play').style.borderColor='var(--green)';
  document.getElementById('btn-host-spec').style.color='var(--muted)';
  document.getElementById('btn-host-spec').style.borderColor='var(--muted)';
  document.getElementById('boundary-hint').textContent='';
  showScreen('create');
  // Init boundary mini-map after short delay
  setTimeout(initBoundaryMap,200);
}

function changeHunters(d) {
  _hunterCount=Math.max(1,Math.min(4,_hunterCount+d));
  document.getElementById('hunter-count').textContent=_hunterCount;
}

function setHostMode(mode) {
  S.hostMode=mode;
  const isSpec=mode==='spectate';
  document.getElementById('spec-desc').style.display=isSpec?'block':'none';
  document.getElementById('btn-host-play').style.color=isSpec?'var(--muted)':'var(--green)';
  document.getElementById('btn-host-play').style.borderColor=isSpec?'var(--muted)':'var(--green)';
  document.getElementById('btn-host-spec').style.color=isSpec?'var(--blue)':'var(--muted)';
  document.getElementById('btn-host-spec').style.borderColor=isSpec?'var(--blue)':'var(--muted)';
}

// ── Boundary map ──────────────────────────────────────────────────────────
function initBoundaryMap() {
  if (S.bMap) { S.bMap.remove(); S.bMap=null; }
  const center = S.myPos ? [S.myPos.lat,S.myPos.lng] : [51.505,-0.09];
  S.bMap = L.map('boundary-map',{center,zoom:16,zoomControl:true});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'© OSM', maxZoom:20
  }).addTo(S.bMap);

  // Try to center on user GPS
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(p=>{
      S.bMap.setView([p.coords.latitude,p.coords.longitude],16);
    },()=>{});
  }

  S.bMap.on('click',onBoundaryMapClick);
  document.getElementById('boundary-hint').textContent='Tap "Draw" then tap the map to place points.';
}

function toggleDrawMode() {
  S.drawingMode=!S.drawingMode;
  const btn=document.getElementById('draw-btn');
  btn.textContent = S.drawingMode ? '✓ Done' : '✏ Draw';
  btn.style.color = S.drawingMode ? 'var(--green)' : 'var(--blue)';
  document.getElementById('boundary-hint').textContent = S.drawingMode
    ? 'Tap the map to place boundary points. Tap "Done" when finished.'
    : S.boundary.length>0 ? `${S.boundary.length} points set.` : '';
}

function onBoundaryMapClick(e) {
  if (!S.drawingMode) return;
  S.boundary.push({lat:e.latlng.lat,lng:e.latlng.lng});
  // Draw dot
  const m=L.circleMarker([e.latlng.lat,e.latlng.lng],{radius:5,color:'#a8dadc',fillColor:'#a8dadc',fillOpacity:1,weight:2}).addTo(S.bMap);
  S.bMarkers.push(m);
  // Redraw polygon preview
  if (S.bPolyline) S.bMap.removeLayer(S.bPolyline);
  if (S.boundary.length>1) {
    const pts=[...S.boundary,S.boundary[0]].map(p=>[p.lat,p.lng]);
    S.bPolyline=L.polyline(pts,{color:'#a8dadc',weight:2,dashArray:'6 4'}).addTo(S.bMap);
  }
  document.getElementById('boundary-hint').textContent=`${S.boundary.length} point${S.boundary.length>1?'s':''} placed.`;
}

function clearBoundary() {
  S.boundary=[];
  S.drawingMode=false;
  if (S.bPolyline) { S.bMap.removeLayer(S.bPolyline); S.bPolyline=null; }
  S.bMarkers.forEach(m=>S.bMap.removeLayer(m));
  S.bMarkers=[];
  document.getElementById('draw-btn').textContent='✏ Draw';
  document.getElementById('draw-btn').style.color='var(--blue)';
  document.getElementById('boundary-hint').textContent='Boundary cleared.';
}

async function createAndLobby() {
  S.hunterCount=_hunterCount;
  S.isSpectator = S.hostMode==='spectate';
  S.players={};

  await dbSet(`games/${S.gameCode}/meta`,{
    hostUid:     S.uid,
    hunterCount: S.hunterCount,
    phase:       'WAITING',
    boundary:    S.boundary.length>=3 ? S.boundary : null,
    createdAt:   now(),
  });
  await dbSet(`games/${S.gameCode}/players/${S.uid}`,{
    displayName: S.displayName,
    role:        S.isSpectator ? 'SPECTATOR' : null,
    caught:      false,
    joinedAt:    now(),
  });

  enterLobby();
}

// ═══════════════════════════════════════════════════════════════════════════
// JOIN GAME
// ═══════════════════════════════════════════════════════════════════════════
function goJoin() { showScreen('join'); }

function onJoinCodeInput() {
  document.getElementById('join-btn').disabled =
    document.getElementById('join-input').value.length < 6;
}

async function joinAndLobby() {
  const code=document.getElementById('join-input').value.toUpperCase().trim();
  const snap=await db.ref(`games/${code}/meta`).once('value');
  if (!snap.exists())               { toast('Game not found.','var(--red)'); return; }
  if (snap.val().phase!=='WAITING') { toast('Game already started.','var(--red)'); return; }

  S.gameCode=code; S.isHost=false; S.isSpectator=false;
  S.boundary=snap.val().boundary||[];

  await dbSet(`games/${S.gameCode}/players/${S.uid}`,{
    displayName:S.displayName, role:null, caught:false, joinedAt:now(),
  });
  enterLobby();
}

// ═══════════════════════════════════════════════════════════════════════════
// LOBBY
// ═══════════════════════════════════════════════════════════════════════════
function enterLobby() {
  document.getElementById('lobby-code').textContent   = S.gameCode;
  document.getElementById('waiting-code').textContent = S.gameCode;
  document.getElementById('lobby-start-btn').style.display  = S.isHost ? 'block':'none';
  document.getElementById('lobby-waiting-msg').style.display = S.isHost ? 'none':'block';
  showScreen('lobby');
  startGPS(updateLobbyGPS);

  dbOn(`games/${S.gameCode}/players`, data=>{
    if (!data) return;
    S.players=data;
    renderLobbyPlayers();
  });

  if (!S.isHost) {
    dbOn(`games/${S.gameCode}/meta`, meta=>{
      if (meta?.phase==='ESCAPE') {
        dbOff();
        S.myRole       = S.players[S.uid]?.role || 'RUNNER';
        S.boundary     = meta.boundary||[];
        _beginGame();
      }
    });
  }
}

function updateLobbyGPS(pos, err) {
  const el=document.getElementById('gps-status');
  el.innerHTML = err
    ? `<span style="color:var(--red)">⚠ GPS: ${err}</span>`
    : `<span style="color:var(--green)">✓ GPS ±${Math.round(pos.accuracy||0)}m</span>`;
}

function renderLobbyPlayers() {
  const avatars=['🧑','👩','🧔','👱','🧕','👦','👧','🧒'];
  document.getElementById('player-list').innerHTML=
    Object.entries(S.players).map(([uid,p],i)=>`
      <div class="player-row" style="border-left:3px solid ${uid===S.uid?'var(--green)':'var(--border)'}">
        <div class="player-avatar">${avatars[i%avatars.length]}</div>
        <div>
          <div class="player-name">${p.displayName}${uid===S.uid?' <span style="color:var(--muted);font-size:11px">(you)</span>':''}</div>
          <div class="player-sub">${uid===S.uid&&S.isHost?'Host':'Player'}</div>
        </div>
        <div class="player-badge muted" style="border-color:var(--muted)">
          ${p.role||'PENDING'}
        </div>
      </div>`).join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// HOST START GAME
// ═══════════════════════════════════════════════════════════════════════════
async function hostStartGame() {
  const uids=Object.keys(S.players).filter(u=>S.players[u].role!=='SPECTATOR');
  const shuffled=[...uids].sort(()=>Math.random()-.5);
  const hunterUids=shuffled.slice(0,S.hunterCount);
  const updates={};

  uids.forEach(uid=>{
    const role=hunterUids.includes(uid)?'HUNTER':'RUNNER';
    updates[`games/${S.gameCode}/players/${uid}/role`]=role;
    if (uid===S.uid) S.myRole=role;
  });
  await dbUpdate('/',updates);
  await dbUpdate(`games/${S.gameCode}/meta`,{phase:'ESCAPE'});
  await dbPush(`games/${S.gameCode}/events`,{msg:'🚨 Game started! Runners — RUN!',type:'danger',ts:now()});

  dbOff();
  _beginGame();
}

// ═══════════════════════════════════════════════════════════════════════════
// BEGIN GAME
// ═══════════════════════════════════════════════════════════════════════════
function _beginGame() {
  S.phase='ESCAPE';
  S.escapeTimer=600; S.huntTimer=0;
  S.pingCooldown=180; S.pingsFired=0;
  S.kills=0; S.caught=false;
  S.posHistory=[]; S.topSpeed=0;
  S.lastKnownPings=[]; S._centered=false;
  S.oobActive=false;

  showScreen('game');
  initGameMap();
  renderHUD();
  addEvent('🚨 Game started!','danger');
  acquireWakeLock();

  // Show/hide spectator ping button
  document.getElementById('spec-ping-btn').style.display =
    S.isSpectator ? 'block' : 'none';

  S.mainInterval=setInterval(tick,1000);

  // Listen for player updates
  dbOn(`games/${S.gameCode}/players`, data=>{
    if (!data) return;
    S.players=data;
    Object.entries(data).forEach(([uid,p])=>{
      if (uid===S.uid) return;
      updatePlayerMarker(uid,p);
      // Spectator always sees live positions
      // OOB players are visible to all
    });
  });

  // Listen for game end triggered by host
  dbOn(`games/${S.gameCode}/meta`, meta=>{
    if (meta?.phase==='DONE' && S.phase!=='DONE') {
      _finishGame();
    }
    if (meta?.phase==='HUNT' && S.phase==='ESCAPE') {
      S.phase='HUNT';
      S.pingCooldown=180;
      addEvent('⚡ Hunt phase! Hunters released.','danger');
      renderHuntOverlays();
    }
  });

  // Listen for pings (hunters only)
  if (S.myRole==='HUNTER') {
    dbOn(`games/${S.gameCode}/pings`, allPings=>{
      if (!allPings || S.phase!=='HUNT') return;
      Object.entries(allPings).forEach(([uid,pings])=>{
        if (!pings) return;
        const latest=Object.values(pings).sort((a,b)=>b.ts-a.ts)[0];
        if (latest && now()-latest.ts < 5000) { // fresh ping
          const p=S.players[uid];
          if (p && !p.caught) placePingMarker(uid, p.displayName, latest.lat, latest.lng);
        }
      });
    });
  }

  // Non-host: listen for phase changes
  if (!S.isHost) {
    dbOn(`games/${S.gameCode}/meta`, meta=>{
      if (meta?.phase==='DONE') _finishGame();
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GPS
// ═══════════════════════════════════════════════════════════════════════════
function startGPS(callback) {
  if (!navigator.geolocation) { callback&&callback(null,'Not supported'); return; }
  if (S.watchId!=null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId=navigator.geolocation.watchPosition(
    pos=>{
      const loc={lat:pos.coords.latitude,lng:pos.coords.longitude,
        accuracy:pos.coords.accuracy,speed:pos.coords.speed,ts:now()};
      S.myPos=loc;
      S.posHistory.push(loc);
      if (S.posHistory.length>1000) S.posHistory=S.posHistory.slice(-800);

      // Track top speed
      if (loc.speed!=null && loc.speed>=0) {
        const kmh=loc.speed*3.6;
        if (kmh>S.topSpeed) S.topSpeed=kmh;
      }

      callback&&callback(loc,null);
      if (S.phase&&S.phase!=='DONE') onGameGPSUpdate(loc);
    },
    err=>{ callback&&callback(null,err.message); },
    {enableHighAccuracy:true,maximumAge:0,timeout:15000}
  );
}

function stopGPS() {
  if (S.watchId!=null){ navigator.geolocation.clearWatch(S.watchId); S.watchId=null; }
}

function onGameGPSUpdate(loc) {
  document.getElementById('ov-acquiring').style.display='none';
  placeMyMarker(loc);

  // Push position to Firebase during hunt
  if (S.phase==='HUNT' && !S.isSpectator) {
    dbUpdate(`games/${S.gameCode}/players/${S.uid}`,{lat:loc.lat,lng:loc.lng});
  }
  // Spectator pushes position always for their own marker
  if (S.isSpectator) {
    dbUpdate(`games/${S.gameCode}/players/${S.uid}`,{lat:loc.lat,lng:loc.lng});
  }

  // Check out-of-bounds
  if (S.boundary.length>=3 && S.phase==='HUNT' && !S.isSpectator && !S.caught) {
    const inBounds=pointInPolygon(loc.lat,loc.lng,S.boundary);
    if (!inBounds && !S.oobActive) startOOB();
    if (inBounds  &&  S.oobActive) stopOOB();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// OUT OF BOUNDS
// ═══════════════════════════════════════════════════════════════════════════
function startOOB() {
  S.oobActive=true; S.oobTimer=25;
  document.getElementById('ov-oob').style.display='block';
  document.getElementById('oob-countdown').textContent=25;
  addEvent('⚠ OUT OF BOUNDS — everyone can see you!','danger');
  toast('⚠ Out of bounds! 25s exposure','var(--red)');

  // Tell Firebase this player is exposed
  dbUpdate(`games/${S.gameCode}/players/${S.uid}`,{oob:true,lat:S.myPos.lat,lng:S.myPos.lng});

  S.oobInterval=setInterval(()=>{
    S.oobTimer--;
    document.getElementById('oob-countdown').textContent=S.oobTimer;
    if (S.oobTimer<=0) stopOOB();
  },1000);
}

function stopOOB() {
  S.oobActive=false;
  clearInterval(S.oobInterval);
  document.getElementById('ov-oob').style.display='none';
  dbUpdate(`games/${S.gameCode}/players/${S.uid}`,{oob:false});
}

// ═══════════════════════════════════════════════════════════════════════════
// MAP
// ═══════════════════════════════════════════════════════════════════════════
function initGameMap() {
  if (S.map){S.map.remove();S.map=null;S.myMarker=null;S.accuracyCircle=null;S.pingMarkers={};S.playerMarkers={};}
  const center=S.myPos?[S.myPos.lat,S.myPos.lng]:[51.505,-0.09];
  S.map=L.map('map',{center,zoom:17,zoomControl:true});
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    attribution:'© <a href="https://openstreetmap.org">OSM</a>',maxZoom:20
  }).addTo(S.map);

  // Draw boundary on game map
  if (S.boundary.length>=3) {
    const pts=S.boundary.map(p=>[p.lat,p.lng]);
    S.boundaryPolygon=L.polygon(pts,{
      color:'#a8dadc',fillColor:'#a8dadc',fillOpacity:.06,weight:2,dashArray:'8 4'
    }).addTo(S.map);
  }

  if (S.myPos) { placeMyMarker(S.myPos); document.getElementById('ov-acquiring').style.display='none'; }
}

function placeMyMarker(loc) {
  const color=S.isSpectator?'#a8dadc':S.myRole==='HUNTER'?'#ff4d6d':'#00ff9d';
  if (!S.myMarker) {
    const icon=L.divIcon({className:'',
      html:`<div class="m-me" style="background:${color};box-shadow:0 0 14px ${color}"></div>`,
      iconSize:[18,18],iconAnchor:[9,9]});
    S.myMarker=L.marker([loc.lat,loc.lng],{icon,zIndexOffset:1000})
      .addTo(S.map).bindPopup(`<b>You (${S.isSpectator?'SPECTATOR':S.myRole})</b>`);
  } else {
    S.myMarker.setLatLng([loc.lat,loc.lng]);
  }
  if (loc.accuracy) {
    if (!S.accuracyCircle) {
      S.accuracyCircle=L.circle([loc.lat,loc.lng],{radius:loc.accuracy,
        color,fillColor:color,fillOpacity:.06,weight:1}).addTo(S.map);
    } else {
      S.accuracyCircle.setLatLng([loc.lat,loc.lng]).setRadius(loc.accuracy);
    }
  }
  if (!S._centered){S.map.setView([loc.lat,loc.lng],17);S._centered=true;}
}

function updatePlayerMarker(uid, player) {
  if (!player.lat||!player.lng) return;

  // Visibility rules:
  // - Spectators always see everyone
  // - During escape: nobody sees anyone
  // - During hunt: hunters see runners via pings only (not live), unless OOB
  // - OOB players: everyone sees them live
  // - Hunters see other hunters live
  const isMe = uid===S.uid;
  if (isMe) return;

  const shouldShow =
    S.isSpectator ||
    player.oob ||
    (S.phase==='HUNT' && S.myRole==='HUNTER' && player.role==='HUNTER') ||
    (S.phase==='HUNT' && player.role==='SPECTATOR');

  if (!shouldShow) {
    if (S.playerMarkers[uid]) { S.map.removeLayer(S.playerMarkers[uid]); delete S.playerMarkers[uid]; }
    return;
  }

  const color = player.oob ? '#ff4d6d' :
    player.role==='HUNTER' ? '#ff4d6d' :
    player.role==='SPECTATOR' ? '#a8dadc' : '#00ff9d';

  const label = player.oob ? `${player.displayName} ⚠OOB` : player.displayName;

  if (!S.playerMarkers[uid]) {
    const icon=L.divIcon({className:'',
      html:`<div style="position:relative">
        <div style="width:13px;height:13px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 0 8px ${color}"></div>
        <div style="position:absolute;top:-18px;left:50%;transform:translateX(-50%);
          background:#080e18;color:${color};font-size:9px;padding:1px 4px;border-radius:2px;
          white-space:nowrap;font-family:'Share Tech Mono',monospace;border:1px solid ${color}33">
          ${label}</div></div>`,
      iconSize:[13,13],iconAnchor:[6,6]});
    S.playerMarkers[uid]=L.marker([player.lat,player.lng],{icon})
      .addTo(S.map).bindPopup(`<b>${player.displayName}</b> (${player.role})`);
  } else {
    S.playerMarkers[uid].setLatLng([player.lat,player.lng]);
  }
}

function placePingMarker(uid, name, lat, lng) {
  if (S.pingMarkers['ping_'+uid]) S.map.removeLayer(S.pingMarkers['ping_'+uid]);
  const icon=L.divIcon({className:'',
    html:`<div style="position:relative">
      <div class="m-ping"></div>
      <div class="m-ping-lbl">${name}</div>
    </div>`,
    iconSize:[13,13],iconAnchor:[6,6]});
  S.pingMarkers['ping_'+uid]=L.marker([lat,lng],{icon})
    .addTo(S.map).bindPopup(`<b>${name}</b><br>Ping snapshot — not live`);
  S.lastKnownPings=S.lastKnownPings.filter(p=>p.id!==uid);
  S.lastKnownPings.push({id:uid,name,lat,lng,ts:now()});
}

// ═══════════════════════════════════════════════════════════════════════════
// TICK
// ═══════════════════════════════════════════════════════════════════════════
function tick() {
  if (S.phase==='ESCAPE') {
    S.escapeTimer--;
    if (S.escapeTimer<=0) {
      S.phase='HUNT'; S.pingCooldown=180;
      addEvent('⚡ Hunt phase! Hunters released.','danger');
      if (S.isHost) dbUpdate(`games/${S.gameCode}/meta`,{phase:'HUNT'});
      renderHuntOverlays();
    }
  } else if (S.phase==='HUNT') {
    S.huntTimer++;
    S.pingCooldown--;
    if (S.pingCooldown<=0) { firePing(); S.pingCooldown=180; }
    if (S.myRole==='HUNTER') renderHunterPanel();
    else if (!S.isSpectator) renderRunnerPanel();
  }
  renderHUD();
}

// ═══════════════════════════════════════════════════════════════════════════
// PINGS
// ═══════════════════════════════════════════════════════════════════════════
function firePing() {
  S.pingsFired++;
  if ((S.myRole==='RUNNER'||S.isSpectator) && S.myPos) {
    if (S.myRole==='RUNNER') addEvent('📡 Your location was pinged to hunters!','ping');
    dbPush(`games/${S.gameCode}/pings/${S.uid}`,{lat:S.myPos.lat,lng:S.myPos.lng,ts:now()});
  }
  if (S.myRole==='HUNTER') {
    addEvent('📡 Ping received.','ping');
  }
}

// Spectator can force a ping of all runners
function spectatorForcePing() {
  if (!S.isSpectator) return;
  Object.entries(S.players)
    .filter(([,p])=>p.role==='RUNNER'&&!p.caught&&p.lat)
    .forEach(([uid,p])=>{
      dbPush(`games/${S.gameCode}/pings/${uid}`,{lat:p.lat,lng:p.lng,ts:now()});
    });
  addEvent('👁 Spectator pinged all runners to hunters.','ping');
  toast('All runners pinged','var(--yellow)');
}

// ═══════════════════════════════════════════════════════════════════════════
// HUD
// ═══════════════════════════════════════════════════════════════════════════
function renderHUD() {
  const isEscape=S.phase==='ESCAPE';
  const isHunter=S.myRole==='HUNTER';
  const accent=S.isSpectator?'var(--blue)':isHunter?'var(--red)':'var(--green)';

  document.getElementById('phase-lbl').textContent=isEscape?'ESCAPE PHASE':'HUNT PHASE';
  document.getElementById('phase-lbl').style.color=isEscape?'var(--green)':'var(--red)';

  const tv=document.getElementById('timer-val');
  tv.textContent=isEscape?fmt(S.escapeTimer):fmt(S.huntTimer);
  tv.style.color=isEscape?(S.escapeTimer<60?'var(--red)':'var(--green)'):'var(--red)';

  document.getElementById('chip-icon').textContent=S.isSpectator?'👁':isHunter?'🎯':'🏃';
  document.getElementById('chip-label').textContent=S.isSpectator?'SPECTATOR':S.myRole;
  document.getElementById('chip-label').style.color=accent;

  const pchip=document.getElementById('ping-chip');
  if (!isEscape&&!S.isSpectator) {
    pchip.style.display='block';
    const hot=S.pingCooldown<30;
    document.getElementById('ping-val').textContent=fmt(S.pingCooldown);
    document.getElementById('ping-val').style.color=hot?'var(--yellow)':'var(--red)';
  } else { pchip.style.display='none'; }

  if (isEscape) renderEscapeOverlay();
}

function renderEscapeOverlay() {
  const isHunter=S.myRole==='HUNTER';
  const isSpec=S.isSpectator;
  document.getElementById('ov-phase').style.display='block';
  document.getElementById('pb-icon').textContent=isSpec?'👁':isHunter?'🔒':'🏃';
  document.getElementById('pb-title').textContent=isSpec?'SPECTATING':isHunter?'HUNTERS LOCKED':'RUN! GET FAR AWAY';
  document.getElementById('pb-title').style.color=isSpec?'var(--blue)':isHunter?'var(--red)':'var(--green)';
  document.getElementById('pb-sub').textContent=isSpec?`Hunt begins in ${fmt(S.escapeTimer)}`:isHunter?`Release in ${fmt(S.escapeTimer)}`:`Hunters release in ${fmt(S.escapeTimer)}`;
  const box=document.getElementById('phase-box');
  box.style.borderColor=isSpec?'rgba(168,218,220,.4)':isHunter?'rgba(255,77,109,.45)':'rgba(0,255,157,.4)';
  box.style.background =isSpec?'rgba(168,218,220,.08)':isHunter?'rgba(255,77,109,.1)':'rgba(0,255,157,.08)';
}

function renderHuntOverlays() {
  document.getElementById('ov-phase').style.display='none';
  document.getElementById('ov-info').style.display='block';
  if (S.isSpectator) renderSpectatorPanel();
  else if (S.myRole==='HUNTER') renderHunterPanel();
  else renderRunnerPanel();
}

function renderHunterPanel() {
  document.getElementById('info-label').textContent='📡 LAST KNOWN';
  document.getElementById('info-label').style.color='var(--red)';
  const c=document.getElementById('info-content');
  c.innerHTML=S.lastKnownPings.length===0
    ?`<span class="muted">Waiting for first ping…</span>`
    :S.lastKnownPings.map(p=>{
      const ago=Math.round((now()-p.ts)/1000);
      return `<div style="color:var(--yellow)">🟡 ${p.name} <span class="muted">${ago}s ago</span></div>`;
    }).join('');
  document.getElementById('info-sub').textContent='Yellow pins = snapshot, not live';
}

function renderRunnerPanel() {
  document.getElementById('info-label').textContent='YOUR STATUS';
  document.getElementById('info-label').style.color='var(--green)';
  const hot=S.pingCooldown<30;
  document.getElementById('info-content').innerHTML=
    `Next ping in <span style="color:${hot?'var(--red)':'var(--yellow)'}">${fmt(S.pingCooldown)}</span>`;
  document.getElementById('info-sub').textContent='Keep moving between pings';
}

function renderSpectatorPanel() {
  document.getElementById('info-label').textContent='👁 SPECTATING';
  document.getElementById('info-label').style.color='var(--blue)';
  const runners=Object.values(S.players).filter(p=>p.role==='RUNNER'&&!p.caught);
  const hunters=Object.values(S.players).filter(p=>p.role==='HUNTER');
  document.getElementById('info-content').innerHTML=
    `<div>🏃 ${runners.length} runner${runners.length!==1?'s':''} active</div>
     <div>🎯 ${hunters.length} hunter${hunters.length!==1?'s':''}</div>`;
  document.getElementById('info-sub').textContent='Tap 📡 PING to force-ping all runners';
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT LOG
// ═══════════════════════════════════════════════════════════════════════════
function addEvent(msg, type='info') {
  const log=document.getElementById('event-log');
  const div=document.createElement('div');
  div.className='event-item mono';
  div.style.color=type==='danger'?'var(--red)':type==='ping'?'var(--yellow)':'var(--muted)';
  div.textContent=msg;
  log.insertBefore(div,log.firstChild);
  if (log.children.length>20) log.removeChild(log.lastChild);
}

// ═══════════════════════════════════════════════════════════════════════════
// END GAME
// ═══════════════════════════════════════════════════════════════════════════
function confirmEndGame() {
  const overlay=document.getElementById('confirm-overlay');
  overlay.style.display='flex';
}
function closeConfirm() {
  document.getElementById('confirm-overlay').style.display='none';
}

async function doEndGame() {
  closeConfirm();
  clearInterval(S.mainInterval);
  stopGPS(); dbOff(); releaseWakeLock();
  S.phase='DONE';
  if (S.isHost) await dbUpdate(`games/${S.gameCode}/meta`,{phase:'DONE'});
  await _saveGameResults();
  showLeaderboard();
}

function _finishGame() {
  if (S.phase==='DONE') return;
  clearInterval(S.mainInterval);
  stopGPS(); dbOff(); releaseWakeLock();
  S.phase='DONE';
  _saveGameResults().then(()=>showLeaderboard());
}

// ─── Save results to Firebase ─────────────────────────────────────────────
async function _saveGameResults() {
  const dist=calcDist();
  const topSpd=parseFloat(S.topSpeed.toFixed(1));

  // Save to game record (all participants can read)
  await dbUpdate(`games/${S.gameCode}/results/${S.uid}`,{
    displayName: S.displayName,
    role:        S.myRole||'SPECTATOR',
    caught:      S.caught,
    dist:        Math.round(dist),
    topSpeed:    topSpd,
    kills:       S.kills,
    huntTime:    S.huntTimer,
    ts:          now(),
  });

  // Save to user's personal history
  const gameRef=`users/${S.uid}/games/${S.gameCode}`;
  await dbSet(gameRef,{
    gameCode:  S.gameCode,
    role:      S.myRole||'SPECTATOR',
    caught:    S.caught,
    dist:      Math.round(dist),
    topSpeed:  topSpd,
    kills:     S.kills,
    huntTime:  S.huntTimer,
    ts:        now(),
  });

  // Update career stats
  const profileSnap=await db.ref(`users/${S.uid}/profile`).once('value');
  const profile=profileSnap.val()||{kills:0,caught:0,games:0,topSpeed:0};
  await dbUpdate(`users/${S.uid}/profile`,{
    kills:    (profile.kills||0)+S.kills,
    caught:   (profile.caught||0)+(S.caught?1:0),
    games:    (profile.games||0)+1,
    topSpeed: Math.max(profile.topSpeed||0, topSpd),
  });
}

function calcDist() {
  return S.posHistory.length>1
    ? S.posHistory.reduce((acc,p,i,a)=>i===0?0:acc+haversine(a[i-1].lat,a[i-1].lng,p.lat,p.lng),0)
    : 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// LEADERBOARD
// ═══════════════════════════════════════════════════════════════════════════
async function showLeaderboard() {
  document.getElementById('lb-code').textContent=`GAME · ${S.gameCode}`;
  const isHunter=S.myRole==='HUNTER';
  document.getElementById('lb-role').innerHTML=
    `<div style="font-size:26px;font-weight:900;color:${isHunter?'var(--red)':'var(--green)'}">
      ${S.isSpectator?'👁 Spectator':isHunter?'🎯 Hunter':'🏃 Runner'}
      ${S.caught?' · <span style="color:var(--red)">CAUGHT</span>':''}
    </div>`;

  document.getElementById('stat-dist').textContent=`${Math.round(calcDist())}m`;
  document.getElementById('stat-topspeed').textContent=`${S.topSpeed.toFixed(1)} km/h`;
  document.getElementById('stat-time').textContent=fmt(S.huntTimer);
  document.getElementById('stat-kills').textContent=S.kills;

  // Load all player results
  const snap=await db.ref(`games/${S.gameCode}/results`).once('value');
  const results=snap.val()||{};
  const rows=Object.values(results).sort((a,b)=>(b.kills||0)-(a.kills||0));
  document.getElementById('lb-all-players').innerHTML=rows.map((r,i)=>{
    const medal=i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
    const color=r.role==='HUNTER'?'var(--red)':r.role==='SPECTATOR'?'var(--blue)':'var(--green)';
    return `<div class="player-row" style="margin-bottom:6px">
      <div style="font-size:20px">${medal||'  '}</div>
      <div style="flex:1">
        <div class="player-name" style="color:${color}">${r.displayName} <span class="mono muted" style="font-size:10px">${r.role}</span></div>
        <div class="mono muted" style="font-size:10px">
          ${r.dist}m · ${r.topSpeed}km/h top · ${r.kills} kill${r.kills!==1?'s':''}${r.caught?' · caught':''}
        </div>
      </div>
    </div>`;
  }).join('');

  showScreen('leaderboard');
}

function newGame() {
  if (S.map){S.map.remove();S.map=null;}
  S.myMarker=null;S.accuracyCircle=null;S.pingMarkers={};S.playerMarkers={};
  S.lastKnownPings=[];S._centered=false;
  S.players={};S.myRole=null;S.isHost=false;S.isSpectator=false;
  S.gameCode=null;S.boundary=[];
  showScreen('home');
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME HISTORY
// ═══════════════════════════════════════════════════════════════════════════
async function goHistory() {
  showScreen('history');
  document.getElementById('history-list').innerHTML=
    `<div class="mono muted" style="font-size:12px;text-align:center;padding:32px 0">Loading…</div>`;

  const snap=await db.ref(`users/${S.uid}/games`).orderByChild('ts').limitToLast(20).once('value');
  const games=snap.val();
  if (!games) {
    document.getElementById('history-list').innerHTML=
      `<div class="mono muted" style="font-size:12px;text-align:center;padding:32px 0">No games yet.</div>`;
    return;
  }

  const sorted=Object.values(games).sort((a,b)=>b.ts-a.ts);
  document.getElementById('history-list').innerHTML=sorted.map(g=>{
    const d=new Date(g.ts);
    const dateStr=d.toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    const color=g.role==='HUNTER'?'var(--red)':g.role==='SPECTATOR'?'var(--blue)':'var(--green)';
    return `<div class="card" style="margin-bottom:8px;cursor:pointer" onclick="goGameDetail('${g.gameCode}')">
      <div class="row">
        <div style="flex:1">
          <div class="mono" style="font-size:10px;letter-spacing:2px;color:${color}">${g.role}</div>
          <div style="font-size:18px;font-weight:900;color:#fff;letter-spacing:3px">${g.gameCode}</div>
          <div class="mono muted" style="font-size:10px">${dateStr} · ${g.dist}m · ${g.kills} kill${g.kills!==1?'s':''}${g.caught?' · caught':''}</div>
        </div>
        <div class="mono muted" style="font-size:18px">›</div>
      </div>
    </div>`;
  }).join('');
}

async function goGameDetail(gameCode) {
  showScreen('game-detail');
  document.getElementById('detail-header').innerHTML=
    `<div class="mono" style="font-size:10px;letter-spacing:3px;color:var(--muted)">GAME</div>
     <div class="title-lg">${gameCode}</div>`;
  document.getElementById('detail-body').innerHTML=
    `<div class="mono muted" style="font-size:12px;padding:20px 0">Loading…</div>`;

  const snap=await db.ref(`games/${gameCode}/results`).once('value');
  const results=snap.val();
  if (!results) {
    document.getElementById('detail-body').innerHTML=
      `<div class="mono muted" style="font-size:12px;padding:20px 0">No data for this game.</div>`;
    return;
  }

  const rows=Object.values(results).sort((a,b)=>(b.kills||0)-(a.kills||0));
  document.getElementById('detail-body').innerHTML=`
    <div class="card">
      <span class="label">All Players</span>
      ${rows.map((r,i)=>{
        const medal=i===0?'🥇':i===1?'🥈':i===2?'🥉':'';
        const color=r.role==='HUNTER'?'var(--red)':r.role==='SPECTATOR'?'var(--blue)':'var(--green)';
        return `<div class="player-row" style="margin-top:8px">
          <div style="font-size:20px;width:28px">${medal||''}</div>
          <div style="flex:1">
            <div style="font-weight:700;color:${color}">${r.displayName}
              <span class="mono muted" style="font-size:10px">${r.role}</span>
            </div>
            <div class="mono muted" style="font-size:10px;line-height:2">
              Distance: <span style="color:#dde">${r.dist}m</span> ·
              Top speed: <span style="color:var(--yellow)">${r.topSpeed} km/h</span><br/>
              Kills: <span style="color:var(--red)">${r.kills||0}</span> ·
              Hunt time: <span style="color:var(--blue)">${fmt(r.huntTime||0)}</span>
              ${r.caught?' · <span style="color:var(--red)">CAUGHT</span>':''}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROFILE
// ═══════════════════════════════════════════════════════════════════════════
async function goProfile() {
  showScreen('profile');
  document.getElementById('profile-name').textContent=S.displayName;

  const snap=await db.ref(`users/${S.uid}/profile`).once('value');
  const p=snap.val()||{kills:0,caught:0,games:0,topSpeed:0};

  document.getElementById('profile-kills').textContent=p.kills||0;
  document.getElementById('profile-topspeed').textContent=`${(p.topSpeed||0).toFixed(1)} km/h`;
  document.getElementById('profile-games').textContent=p.games||0;
  document.getElementById('profile-caught').textContent=p.caught||0;

  // Medals
  const medals=calcMedals(p);
  document.getElementById('profile-medals').innerHTML=medals.length
    ? medals.map(m=>`
        <div style="text-align:center">
          <div style="font-size:36px">${m.icon}</div>
          <div class="mono muted" style="font-size:9px;margin-top:2px">${m.label}</div>
        </div>`).join('')
    : `<div class="mono muted" style="font-size:11px">Play more games to earn medals!</div>`;

  // Recent games
  const gSnap=await db.ref(`users/${S.uid}/games`).orderByChild('ts').limitToLast(5).once('value');
  const games=gSnap.val();
  if (!games) {
    document.getElementById('profile-recent').innerHTML=
      `<div class="mono muted" style="font-size:11px">No games yet.</div>`;
    return;
  }
  const sorted=Object.values(games).sort((a,b)=>b.ts-a.ts);
  document.getElementById('profile-recent').innerHTML=sorted.map(g=>{
    const color=g.role==='HUNTER'?'var(--red)':g.role==='SPECTATOR'?'var(--blue)':'var(--green)';
    const d=new Date(g.ts).toLocaleDateString('en-GB',{day:'numeric',month:'short'});
    return `<div style="padding:8px 0;border-bottom:1px solid var(--border)">
      <div class="mono" style="font-size:10px;color:${color}">${g.role} · ${g.gameCode} · ${d}</div>
      <div class="mono muted" style="font-size:10px">${g.dist}m · ${g.kills} kill${g.kills!==1?'s':''}${g.caught?' · caught':''}</div>
    </div>`;
  }).join('');
}

function calcMedals(p) {
  const medals=[];
  // Kill medals
  if ((p.kills||0)>=1)  medals.push({icon:'🥉',label:'First Blood'});
  if ((p.kills||0)>=5)  medals.push({icon:'🥈',label:'Hunter'});
  if ((p.kills||0)>=15) medals.push({icon:'🥇',label:'Apex Predator'});
  // Speed medals
  if ((p.topSpeed||0)>=10) medals.push({icon:'⚡',label:'Fast'});
  if ((p.topSpeed||0)>=20) medals.push({icon:'🚀',label:'Sprinter'});
  // Games played
  if ((p.games||0)>=5)  medals.push({icon:'🎮',label:'Veteran'});
  if ((p.games||0)>=20) medals.push({icon:'🏆',label:'Legend'});
  // Survivor (never been caught after 5 games)
  if ((p.games||0)>=5 && (p.caught||0)===0) medals.push({icon:'👻',label:'Ghost'});
  return medals;
}

// ═══════════════════════════════════════════════════════════════════════════
// WAKE LOCK
// ═══════════════════════════════════════════════════════════════════════════
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) S.wakeLock=await navigator.wakeLock.request('screen'); } catch(e){}
}
function releaseWakeLock() {
  if (S.wakeLock){S.wakeLock.release();S.wakeLock=null;}
}
document.addEventListener('visibilitychange',()=>{
  if (document.visibilityState==='visible'&&S.phase==='HUNT') acquireWakeLock();
});

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE WORKER
// ═══════════════════════════════════════════════════════════════════════════
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js')
    .then(r=>console.log('[SW] registered',r.scope))
    .catch(e=>console.warn('[SW] failed:',e));
}
