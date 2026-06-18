# Plan: Run showdown-ui 24/7 on a Mac Studio, playable remotely from phone/tablet/laptop

> This file is written to be handed to a **fresh Claude Code chat** for implementation. It carries
> all the context that chat needs — it should not need to re-explore the codebase to start.

## Context — why this is being done

The user wants to leave the Pokémon Showdown helper app (`showdown-ui/`) running 24/7 on a Mac
Studio and **play through their phone / iPad / MacBook / Windows PC / Android phone**, with all the
real work (the Electron app, the WebSocket tap, the battle-log writing) happening on the Mac Studio.
Single user, one session at a time.

### The hard constraint that shapes the whole plan

`showdown-ui/` is a **GUI Electron app**, not a server. Verified facts from the codebase:

- It opens a full-work-area `BrowserWindow` (`showdown-ui/electron/main/index.ts:547-608`,
  `createWindow()`), with a `WebContentsView` (`psView`) overlaying the left region that loads
  `https://play.pokemonshowdown.com`, and a React helper panel docked on the right.
- The battle data path **requires the live window**: `injected.js` patches `window.WebSocket` in the
  psView's MAIN world (`electron/preload/ps.ts`), decodes SockJS frames, and relays them via
  `ps-frame` IPC to the main process, which runs a per-room `BattleTracker` and writes logs to
  `logs/battle_info/`. There is **no headless mode** — `PS_SMOKE=1` only boots-and-exits to prove the
  app launches; it does not run battles.
- There is **no server, no networking, no RPC, no remote-access code** anywhere in `showdown-ui/`.
  Login persists locally via the `persist:showdown-ui` Electron session partition
  (`electron/main/index.ts:582`).

Therefore "play through my phone with processing on the Mac Studio" is fundamentally a **remote
display / game-streaming** problem, *not* a server problem. The Mac Studio runs the real GUI app; the
phone is a thin client that streams the Mac's screen and sends back touch/keyboard input.

**This plan involves NO changes to the application source code.** It is a deployment runbook:
keep-alive + display capture + secure remote access. All decisions below were confirmed with the user.

### Decisions locked with the user

| Decision | Choice |
|---|---|
| Remote approach | **Off-the-shelf game streaming** (Sunshine host on Mac + Moonlight clients). No app code changes. |
| Network access from outside home | **Tailscale** (free mesh VPN; private, encrypted; works on cellular; no port-forwarding) |
| Display on the Mac Studio | **A real monitor stays physically attached** (no HDMI dummy plug / virtual display needed) |
| Clients to document | iPhone, iPad, MacBook, Windows PC, Android |

### Why Sunshine/Moonlight over the alternatives (already decided — recorded for the implementer)

- **Sunshine + Moonlight** — open-source, free, hardware-accelerated H.264/HEVC, ~game-grade latency,
  clients on iOS/iPadOS/macOS/Windows/Android. Chosen.
- *macOS Screen Sharing (VNC)* — kept only as a Mac-to-Mac fallback for administration; too laggy for
  gameplay and Apple-only.
- *Building WebRTC/HTTP streaming into the Electron app* — rejected: large new code surface
  (capture + signaling + `webContents.sendInputEvent` injection), worse latency than Moonlight,
  reinvents Parsec poorly.
- *Browser PS client on the phone + headless Mac-side helper* — rejected: requires a brand-new
  backend service and loses the docked helper-panel UX on the phone.

---

## Implementation steps (runbook)

All steps run **on the Mac Studio** unless a client device is named. Prefer Homebrew installs so they
are scriptable and updatable. The implementer should execute and verify each step, not just document
it. Note: several steps require **GUI interaction and OS permission grants that cannot be fully
automated** (System Settings toggles, Tailscale login in a browser, App Store installs on phones) —
for those, give the user precise click-by-click instructions and verify the result afterward.

### Step 1 — Keep the app running 24/7 (launchd, auto-restart, login-survival)

Goal: `showdown-ui` launches on boot/login and respawns if it crashes or is quit.

- The dev launch is `npm start` (repo root) → `cd showdown-ui && npm run dev` (electron-vite dev).
  For an always-on deployment prefer the **packaged app** over the dev server (no Vite watcher, no
  terminal needed, survives reboots cleanly):
  - Build once: from repo root `npm run dist:ui` → produces
    `showdown-ui/dist/mac*/Pokemon Showdown Battle UI.app` (and a `.dmg`). Move the `.app` to
    `/Applications`. macOS builds are **unsigned** — first launch needs right-click → Open, or
    `xattr -dr com.apple.quarantine "/Applications/Pokemon Showdown Battle UI.app"`.
  - Packaged paths: read-only data comes from `process.resourcesPath`; **writable state (config.json +
    logs) goes to `~/Documents/ps-local/`** (not the repo). Confirm logs land there after first run.
- Create a **LaunchAgent** (per-user, so it inherits the GUI login session — required, the app needs
  the window server) at `~/Library/LaunchAgents/com.abhishekr3.ps-local.plist`:
  - `ProgramArguments`: `open -W "/Applications/Pokemon Showdown Battle UI.app"` (or invoke the
    binary inside `Contents/MacOS/` directly so `KeepAlive` can see the process exit).
  - `RunAtLoad: true`, `KeepAlive: true` (respawn on crash/quit). Add a `ThrottleInterval` (~10s) so a
    crash-loop doesn't hammer the CPU.
  - Redirect `StandardOutPath`/`StandardErrorPath` to `~/Documents/ps-local/logs/debug/launchd-*.log`.
  - Load with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.abhishekr3.ps-local.plist`.
- Configure macOS to **auto-login the user on boot** (System Settings → Users & Groups → Automatic
  login) so an unattended reboot reaches the desktop and the LaunchAgent fires without manual login.
- Disable display sleep / system sleep so streaming stays available: `sudo pmset -a sleep 0
  displaysleep 0 disablesleep 1` (the real monitor will stay on — acceptable per user's choice). Also
  set "Prevent automatic sleeping when the display is off" / "Start up automatically after a power
  failure" in System Settings → Energy.
- (Optional, recommended) create `~/Documents/ps-local/config.json` with `{"saveLogs": true,
  "timezone": "<user's IANA tz>", "logLevel": "INFO"}`. Keys verified in
  `showdown-ui/electron/main/index.ts:23-42`. Login is **not** scripted — the user logs into PS once
  in the streamed window and the `persist:showdown-ui` partition keeps them logged in across restarts.

### Step 2 — Install & configure the streaming host (Sunshine) on the Mac Studio

- Install: `brew install --cask sunshine` (Homebrew cask). If the cask is unavailable, download the
  macOS Sunshine release from the LizardByte project and install the `.pkg`.
- macOS permission grants (GUI, cannot be scripted — instruct the user, then verify):
  System Settings → Privacy & Security → grant Sunshine **Screen Recording** and **Accessibility**
  (Accessibility is required for Sunshine to inject keyboard/mouse/touch input back into macOS).
  Sunshine must be restarted after the grants.
- Start Sunshine and open its web UI at `https://localhost:47990` — set the admin username/password on
  first run. The real attached monitor is the capture source (no dummy plug needed per the user's
  display choice).
- Set Sunshine to **launch at login** (it has a built-in toggle, or add a second LaunchAgent). Confirm
  it survives a reboot.
- Tune for low latency in the Sunshine web UI: HEVC if the Mac Studio GPU + clients support it,
  bitrate appropriate to the LAN/Tailscale link, and a frame rate matching the attached display.
- Leave the default "Desktop" application entry — the user will stream the whole desktop (the
  showdown-ui window runs maximized on it). Optionally add a dedicated app entry that focuses the
  showdown-ui window.

### Step 3 — Set up Tailscale for secure remote reach

- Mac Studio: `brew install --cask tailscale`, launch it, sign in (browser-based — user action), and
  note the Mac's Tailnet IP (`100.x.y.z`) via `tailscale ip -4` or the menu-bar app.
- Recommended: enable **Tailscale "MagicDNS"** so the Mac is reachable by a stable hostname instead of
  the raw `100.x` IP.
- Install Tailscale on **every client device** (iPhone, iPad, MacBook, Windows, Android) from the
  respective app store and sign into the **same Tailscale account** so all devices share one private
  Tailnet. This is what makes it work on cellular / away from home with no router port-forwarding.
- Verify from a phone on cellular (Wi-Fi off): `ping`/connect to the Mac's Tailnet hostname succeeds.
- Sunshine's pairing/stream ports do **not** need to be forwarded on the router — Tailscale tunnels
  them privately. Do not expose Sunshine to the public internet.

### Step 4 — Install Moonlight on each client and pair

For every client device:

1. Install Moonlight:
   - **iPhone / iPad**: "Moonlight Game Streaming" from the App Store.
   - **MacBook**: "Moonlight" from the Mac App Store or `brew install --cask moonlight` (a native
     Moonlight client gives lower latency than VNC; Screen Sharing remains a fallback for admin).
   - **Windows PC**: Moonlight from the Microsoft Store or the GitHub release.
   - **Android phone**: "Moonlight Game Streaming" from the Play Store.
2. In Moonlight, **Add Host** manually using the Mac's **Tailscale** hostname/IP (not the LAN IP), so
   the same configuration works at home and on cellular.
3. Pair: Moonlight shows a 4-digit PIN; enter it in the Sunshine web UI (`https://localhost:47990` →
   PIN tab) on the Mac. Pair each device once.
4. Connect to the "Desktop" stream. Confirm the showdown-ui window is visible and interactive.

### Step 5 — Input ergonomics for touch clients (iPhone / iPad / Android)

The PS web client + helper panel are mouse/keyboard UIs; phones send touch. Document in the runbook:

- Moonlight's **touchscreen mode** maps taps to clicks; enable "touchscreen as virtual trackpad" vs
  "direct touch" per preference (direct touch is usually better for clicking PS move/switch buttons).
- For typing (team names, chat, login), Moonlight exposes an **on-screen keyboard** toggle — verify it
  produces text in PS.
- iPad benefits from the larger screen for the docked helper panel; note that the helper panel width is
  user-resizable by dragging the divider (persisted in `localStorage` as `ps-helper-width` —
  `showdown-ui/src/routes/Battle.tsx`), so the user can widen/narrow it once from any client and it
  sticks.
- Optional: a Bluetooth keyboard paired to the phone/tablet makes login and chat far easier.

### Step 6 — Resilience & "is it alive" checks

- Confirm the full auto-recovery chain by rebooting the Mac Studio and verifying, with **no manual
  intervention**: auto-login → LaunchAgent starts showdown-ui → Sunshine running → a client can
  connect and a battle still logs to `~/Documents/ps-local/logs/battle_info/`.
- Confirm crash recovery: `killall "Pokemon Showdown Battle UI"` and verify launchd respawns it within
  the `ThrottleInterval`.
- Note the existing in-app health surface for the user: the helper panel's status line already reports
  tap/page/log-write health (`PsStatus` in `showdown-ui/src/global.d.ts`,
  `deriveStatus()` in `HelperPanel.tsx`) — e.g. "Pokémon Showdown site unreachable",
  "Tap not active", "Battle log failed to save". The user can read this over the stream.
- Single-user note: the app holds a single-instance lock (`electron/main/index.ts:613`), and Sunshine
  serves one stream session at a time — this matches the "one user at a time" requirement; no
  multi-session work needed.

---

## Deliverable: a committed runbook doc

Produce a new doc **`docs/REMOTE-24-7-DEPLOYMENT.md`** capturing the executed setup so the user can
re-run it (e.g. after a macOS reinstall). It should contain:

- The architecture rationale (GUI app → must stream the display; Sunshine/Moonlight over Tailscale).
- The exact commands run (Homebrew installs, `pmset`, `launchctl`), the LaunchAgent plist (full
  contents), and the auto-login / energy settings toggled.
- Per-client install + pairing steps for iPhone, iPad, MacBook, Windows, Android.
- The GUI permission grants required (Screen Recording, Accessibility, Tailscale login).
- A troubleshooting section (stream black screen → Screen Recording permission; input not registering
  → Accessibility permission; can't reach host on cellular → both devices on same Tailnet; app not
  restarting → `launchctl print gui/$(id -u)/com.abhishekr3.ps-local`).

Cross-reference it from `README.md` (and optionally a one-line pointer in `CLAUDE.md`'s docs list).
This doc is the only intended file change to the repository; everything else is host/OS configuration.

---

## Verification (end-to-end)

1. **24/7 / restart**: reboot the Mac Studio; with no manual steps the desktop reaches login, the
   showdown-ui window appears, and Sunshine is running. Then `killall` the app and confirm launchd
   respawns it.
2. **Remote reach**: from an iPhone on **cellular** (home Wi-Fi off), connect via Moonlight over the
   Mac's Tailscale address and see the live PS client.
3. **Play + process-on-Mac proof**: start/spectate a battle from the phone over the stream; confirm
   (a) the docked helper panel updates live on screen, and (b) a battle log file is written on the
   **Mac Studio** at `~/Documents/ps-local/logs/battle_info/` (proving processing happens on the Mac,
   not the phone). Check filename format `<roomid>_<p1>_vs_<p2>_<result>_<ts>.txt` (or `SPEC_` prefix
   for spectated games).
4. **Each client**: repeat the Moonlight connect test from MacBook, Windows, and Android to confirm
   pairing and input work on each.
5. **Health line**: temporarily break connectivity (or stop the app) and confirm the helper panel's
   status line reflects it, so the user has an at-a-glance health indicator over the stream.

---

## Notes for the implementing chat

- **Do not edit anything under `vendor/`** and verify both submodules stay git-clean — the project's
  #1 invariant. This task shouldn't touch them at all.
- **No application source changes are required or intended.** If you find yourself editing
  `showdown-ui/electron/**` or `helper/**`, stop — that's out of scope for this deployment plan.
- Several steps need GUI/permission actions that **cannot be scripted** (System Settings privacy
  grants, Tailscale browser login, App Store installs, Sunshine↔Moonlight PIN pairing). For those,
  give the user exact instructions and then verify the outcome programmatically where possible
  (e.g. `tailscale status`, `launchctl print`, checking for a written log file).
- `git push` and any destructive git op require explicit user confirmation (global preference) — the
  only repo change here is adding `docs/REMOTE-24-7-DEPLOYMENT.md`; commit only when asked.
- If the user later wants to drop the attached monitor and run truly headless, the follow-up is an
  HDMI dummy plug or a virtual display (BetterDisplay) so Sunshine still has a capture target — note
  this as a future option but it is **out of scope** now (user chose to keep a real monitor attached).
