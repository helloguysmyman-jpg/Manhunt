# MANHUNT PWA

Real-world GPS tracking game. Hunters get runner location snapshots every 3 minutes — not live.

## Files

```
manhunt-pwa/
├── index.html          # All screens (auth, home, create, join, lobby, game, leaderboard)
├── style.css           # All styles
├── app.js              # All game logic + Firebase integration points
├── service-worker.js   # Offline caching, background sync, push notifications
├── manifest.json       # PWA manifest (name, icons, display mode)
├── firebase-rules.json # Realtime DB security rules
└── icons/
    ├── icon-192.png    # Required — generate from any 512px image
    └── icon-512.png    # Required
```

---

## Running locally (GPS works over LAN)

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Open `http://YOUR_LOCAL_IP:8080` on your phone (same WiFi network).  
GPS requires either localhost or HTTPS — LAN IP works fine.

---

## Deploy to Netlify (free, HTTPS, permanent URL)

1. Go to https://netlify.com/drop
2. Drag the entire `manhunt-pwa/` folder onto the page
3. Done — you get an HTTPS URL immediately

Or via CLI:
```bash
npm install -g netlify-cli
netlify deploy --dir . --prod
```

---

## Firebase Setup (required for multiplayer)

1. Go to https://console.firebase.google.com
2. Create a new project
3. Enable these services:
   - **Authentication** → Email/Password
   - **Realtime Database** → Start in test mode, then apply rules below
   - **Hosting** (optional, for custom domain)

4. In Project Settings → Your Apps → Add web app → copy the config object

5. In `app.js`, replace the `firebaseConfig` object:
```js
const firebaseConfig = {
  apiKey:            "...",
  authDomain:        "your-project.firebaseapp.com",
  databaseURL:       "https://your-project-default-rtdb.firebaseio.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "...",
  appId:             "...",
};
```

6. Set `USE_FIREBASE = true` in `app.js`

7. Uncomment the three Firebase SDK `<script>` tags in `index.html`

8. In Realtime Database → Rules, paste the contents of `firebase-rules.json`

---

## Generate Icons

Easiest: go to https://realfavicongenerator.net  
Upload any 512×512 image, download the package, grab the 192 and 512 PNGs.

Or with ImageMagick:
```bash
convert your-icon.png -resize 192x192 icons/icon-192.png
convert your-icon.png -resize 512x512 icons/icon-512.png
```

---

## Add to Home Screen (makes it feel native)

**iOS Safari:** Share button → "Add to Home Screen"  
**Android Chrome:** Three-dot menu → "Add to Home Screen" or "Install App"

Once installed it launches fullscreen with no browser chrome.

---

## iOS Background GPS Note

iOS throttles `watchPosition` when the screen locks.  
The app requests a **Wake Lock** (`navigator.wakeLock`) to keep the screen on during play.  
For guaranteed background GPS on iOS, wrap with **Capacitor**:

```bash
npm install @capacitor/core @capacitor/ios
npx cap init
npx cap add ios
npx cap copy
npx cap open ios   # opens Xcode, enable background location entitlement
```

This does NOT require App Store submission for personal/friend group use.

---

## Realtime DB Schema

```
games/{gameCode}/
  meta/
    hostUid:     string
    hunterCount: number
    phase:       "WAITING" | "ESCAPE" | "HUNT" | "DONE"
    createdAt:   timestamp

  players/{uid}/
    displayName: string
    role:        "HUNTER" | "RUNNER" | null
    caught:      boolean
    lat:         number   (updated continuously during HUNT)
    lng:         number
    joinedAt:    timestamp

  pings/{uid}/{pingId}/
    lat: number           (snapshot only — written every 3 min by runners)
    lng: number
    ts:  timestamp

  events/{eventId}/
    msg:  string
    type: "info" | "danger" | "ping"
    ts:   timestamp
```

Hunters read `pings/{uid}` — they never get `players/{uid}/lat` or `lng` in real time.  
Runners' live coordinates are only in `players/{uid}` and only visible to the host for catch detection.
