# Handoff: browser-playable CS 1.6 on OpenShift

**Goal:** devs open a URL on the restricted network and play Counter-Strike 1.6
in the browser — no installs, no Steam, nothing external at runtime.
The org confirms it holds the licenses/permits for the CS 1.6 game data;
treat the `cstrike`/`valve` asset folders as org-licensed input artifacts.

## Architecture

```
browser (restricted net)
  │  HTTPS ──► Route/web ──► nginx pod: static Xash3D-WASM client + game data bundle
  │  WSS   ──► Route/net ──► ws↔udp relay pod ──► UDP ──► xash3d dedicated server pod
```

Everything the browser touches is TCP/HTTP(S), so plain OpenShift Routes
work end to end — no NodePort, no UDP exposure, no LoadBalancer.

There is **no way around the WASM engine port**: GoldSrc was never open-sourced,
so the browser client is the community engine **Xash3D** (FWGS fork) compiled
with Emscripten, running the open-source **cs16client** game logic on top of
the org-licensed game data. A native HLDS server cannot serve these clients —
the dedicated server must be Xash3D too (same protocol family).

## Components

### 1. Web client (browser)

- Engine: https://github.com/FWGS/xash3d-fwgs — Emscripten/wasm support in
  tree (`./waf configure -T emscripten`). Pin a known-good emsdk version;
  bit-rot in emscripten builds is the #1 risk — budget time for it.
- Game logic: https://github.com/Velaron/cs16-client — reverse-engineered
  CS 1.6 client dll (`client.so`/`menu.so` equivalents for the wasm target).
- Reference wasm forks to crib page/loading plumbing from (small/stale, do
  not rely on): ColinVanderMeer/XashWR, arc360alt/webXash,
  Buggem/xash3d-emscripten. Do NOT fetch anything from external sites at
  runtime — restricted network.
- Output: `index.html` + `xash.js` + `xash.wasm` + a data bundle
  (`cstrike.zip` / folder tree the client downloads once into IndexedDB).
- Data bundle: `valve/` + `cstrike/` from a licensed CS 1.6 install
  (any Steam copy, or SteamCMD app 90). Org covers licensing; still keep the
  bundle on our own host only.
- The page must be HTTPS (OpenShift edge TLS) → the game socket **must be
  `wss://`** and the data bundle must be same-origin (or CORS-enabled).

### 2. Dedicated server (game logic)

- Xash3D dedicated server, Linux amd64 container, `+sv_lan 1` (no Steam auth),
  `+map de_dust2`, maxplayers as needed.
- Needs the same org-licensed `valve/` + `cstrike/` data — bake into the image.
- Listens UDP 27015 **inside the cluster only** (ClusterIP Service; never
  exposed directly).

### 3. WebSocket ↔ game-server relay

- The wasm client cannot speak raw UDP to the server directly. Put a relay in
  front of it translating the browser's WebSocket connection to the xash3d
  server's UDP 27015.
- **Verify the exact transport the chosen client build implements first** —
  this decides the relay: some xash3d-emscripten builds tunnel UDP over ws,
  others use a WebRTC-datachannel relay, and xash3d-fwgs has native ws server
  support in some configurations (check the engine's net layer before writing
  manifests).
- If a simple ws→TCP/UDP bridge fits: https://github.com/novnc/websockify
  (note: upstream websockify is TCP-only; for UDP either use the proxy bundled
  with the chosen wasm fork or a ~100-line node/go ws→UDP forwarder).

## Exact downloads

| Piece | URL | Notes |
| --- | --- | --- |
| Engine source | https://github.com/FWGS/xash3d-fwgs | active upstream; build with `./waf configure -T emscripten` |
| CS 1.6 client logic | https://github.com/Velaron/cs16-client | reverse-engineered CS client dll |
| Emscripten SDK | https://github.com/emscripten-core/emsdk | `git clone`, then `emsdk install/activate` a pinned version |
| SteamCMD (game data) | https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz | anonymous login OK for app 90 |
| CS 1.6 game data | `steamcmd +login anonymous +app_set_config 90 mod cstrike +app_update 90 validate +quit` | yields `hlds/` with `valve/` + `cstrike/` — org-licensed assets |
| Alternative fetcher | https://github.com/SteamRE/DepotDownloader/releases | .NET, arm64/x64 native; also works anonymously for app 90 |
| Relay (if TCP fits) | https://github.com/novnc/websockify | TCP-only upstream; see transport note above |
| Web static server | docker.io/library/nginx:alpine | mirror through your internal registry |

### 4. OpenShift objects

- `Deployment/web` (nginx:alpine, serves client + bundle; all files < 50 MB,
  gzip on) → `Service` → `Route` (edge TLS).
- `Deployment/relay` (websockify) → `Service` → second `Route` (edge TLS →
  wss). Sticky-ish timeouts: bump the Route's idle timeout for long game
  sessions (`haproxy.router.openshift.io/timeout` / `timeout tunnel`).
- `Deployment/xash3d-ds` → `Service` ClusterIP UDP 27015.
- SCC: build all images to run as an arbitrary UID (OpenShift default):
  `chgrp -R 0` + `g=u` on writable dirs, no setuid, ports ≥ 1024 inside
  containers (map 8080/8081 in Services).
- Persistence: not required for v1 (bake data into images). Add a PVC only if
  you later want server-side configs/logs to survive restarts.

## Build order

1. Get the xash3d-fwgs + cs16client wasm build running **locally** with the
   data bundle and a local xash3d server (proves engine + assets + transport).
2. Containerize web / relay / server; wire Services + Routes on the cluster.
3. Test from a browser on the restricted network: page load → data bundle
   fetch → `connect` through the wss relay → join de_dust2.

## Known pitfalls (learned the hard way on the GLM/QuakeJS work)

- Do not link out to external CDNs/download sites — the target network is
  restricted; the page must be fully self-contained on our Routes.
- HTTPS page + `ws://` = mixed-content block. Relay route must be TLS (wss).
- Emscripten builds of xash3d are fragile across emsdk versions — pin the
  toolchain, vendor everything.
- Expect playable-but-janky performance; this is a fun internal toy, not a
  competitive server.

## Acceptance

- URL on the restricted network loads the client, downloads the bundle once
  (IndexedDB cached), and joins the office LAN server in de_dust2 with bots
  or other devs.
- Zero external network calls from the page (verify in devtools).
- Everything runs as non-root under OpenShift's default restricted SCC.
