# UWP WebView2 Xbox Sideload App

## Context

Port `showdown-ui/` to a UWP app using WebView2 that can be sideloaded onto Xbox Series X in Developer Mode. Xbox runs a Windows 10/11 variant under the hood; Developer Mode enables sideloading via Device Portal or MSIX packages. WebView2 gives you Chromium with `AddScriptToExecuteOnDocumentCreatedAsync()` — the structural equivalent of Electron's `contextIsolation:false` preload.

The goal: same experience as the desktop Electron app (split-view PS client + helper panel + battle log writing) but running as a packaged UWP MSIX on Xbox.

### Two architectural decisions (locked)

- **Tracker model = JS-in-WebView2 + event-post (not C# reimplementation, not per-frame polling).**
  Keep `parser.js` / `exporter.js` / `render.js` running as JS inside WebView2 — zero reimplementation,
  no risk of drifting from upstream protocol changes. Per frame, C# only buffers the raw frame string;
  it does **not** poll full state. Instead the injected JS runs `battleEndReason()` (from `logmeta.js`)
  and posts a single `{ __psHelper: true, type: 'battle-end', roomid }` when the battle ends. C# then
  does **one** `getState()` round-trip at end-of-battle to build the log. (This replaces the earlier
  "query `getState()` after every frame" idea — that serialized the entire, unbounded `turnLog` object
  ~20×/sec; see Phase 4.)
- **Panel data loading = `ms-appx-web://` fetch adapter.** The existing data loaders don't work here:
  `showdown-ui/src/lib/data.ts` uses Vite `import.meta.glob` (build-time only) and
  `helper/extension/lib/data.js` uses `api.runtime.getURL` (extension runtime only). Neither resolves
  under a plain `ms-appx:///Assets/panel.html`. Add a **third** adapter that `fetch`es
  `Assets/data/**` via `ms-appx-web:///` from inside `panel.html`, and pass the `ms-appx-web://…/Assets/`
  base as `render.js`'s `assetBase` option (which already exists for exactly this) so category icons
  resolve. Data stays bundled in the MSIX; the panel is self-contained.

> **De-risk first.** The single highest-risk unknown is whether WebView2's out-of-process renderer
> even activates on Xbox (see Failure Modes). Validate that on real hardware in a **Phase 0** before
> building anything else — if OOP is blocked, the whole approach is dead. Don't leave it to Phase 7.

---

## Failure Modes

| Failure | Blast radius | Mitigation |
|---|---|---|
| **WebView2 runtime not present on Xbox** | App won't launch at all | WebView2 ships inbox on Windows 11; Xbox Developer Mode is Win10. Bundle the Fixed Version runtime in the MSIX. Without it = silent crash on launch. |
| **`AddScriptToExecuteOnDocumentCreatedAsync` timing race** | Frames silently dropped; tracker never populates | Unlike Electron's synchronous `new Function()` in the preload, the async API schedules injection at "next document creation." Inject at `NavigationStarting` event, before content loads. |
| **SockJS framing change** | Entire tap goes dark; blank panel, no logs | `injected.js` assumes `a[...]` array frames. PS has changed transport before. Blast radius: total. Log the `__psHelper: false` tap-status messages to the debug file. |
| **WebView2 WebMessage size limit** | Large `\|request\|` frames silently truncated | `PostWebMessageAsString` has a practical ~1 MB limit. `\|request\|` JSON can be large, and the end-of-battle `getState()` round-trip returns the whole state object. Use `PostWebMessageAsJson` / `ExecuteScriptAsync` (which returns JSON, not a capped string message) and confirm Xbox's WebView2 version handles full payloads. |
| **Async injection race drops early frames** | Blank panel; battle never reconstructs | `AddScriptToExecuteOnDocumentCreatedAsync` is async (worse than Electron's synchronous `new Function()` preload). The first `\|init\|`/`\|request\|` frames can be missed. **Mitigation is mandatory, not optional:** relay frames to a C#-side buffer from the first frame, and reproduce `HelperPanel.tsx`'s buffered-frame replay + 5s auto-resync + manual resync so a late listener rebuilds the tracker from the buffer. |
| **Tap-status channel dropped** | Tap silently dead; user sees a blank panel with no explanation | `injected.js` posts a *second* shape — `{ __psHelper: true, tap: 'inactive', reason: 'no-socket' \| 'framing' }` (after ~15s with no sim socket, or on an unknown SockJS prefix). The bridge must relay this too, and the panel must render "tap dead" on screen (no terminal on a console). |
| **Disk write failure invisible** | Battles silently not saved | The Electron UI sets `PsStatus.logWrite='error'` on write failure and renders it (guard-enforced). Reproduce: surface write failures **on screen**, since there's no console to read the debug log from. |
| **Xbox storage path restrictions** | Logs never written | UWP can't write to arbitrary paths. Use `ApplicationData.Current.LocalFolder`; `StorageFile` throws `UnauthorizedAccessException` if capability not declared. |
| **WebView2 cookie persistence** | User logs out every session | Point `CoreWebView2Profile` at `ApplicationData.Current.LocalFolder\webview2-profile\` — not `~/Documents`. |
| **Xbox resolution/input model mismatch** | UI unusable with controller | Xbox default is 1920×1080 at 150% DPI. Helper panel divider is mouse-driven; controllers send gamepad input. Panel width must be fixed; all navigation handled via `Windows.Gaming.Input` (see Phase 5.5). |
| **MSIX signing for sideload** | Package won't install | Xbox Developer Mode accepts self-signed certs. Must install `.cer` in trusted root via Device Portal before deploying the `.msixbundle`. |
| **WebView2 OOP process model on Xbox** | COM activation failure | WebView2 uses an out-of-process renderer. On Xbox, third-party OOP child processes may be restricted by platform security policy. **Highest-risk unknown — test on device early.** |
| **`flushAllRooms` on suspend** | In-progress battles lost | Xbox aggressively suspends background apps. UWP `Suspending` event fires with a 5-second deadline. Must flush rooms in the `Suspending` handler. |
| **ESM module bundling** | Tracker never runs | `parser.js`/`exporter.js` are ESM. Can't `import` from C# side. Bundle them into a single injected script. |

---

## Scale Cliff

This is a single-user, low-throughput console app. There is no realistic scale cliff.

| Dimension | Current ceiling | Cliff | Verdict |
|---|---|---|---|
| **Concurrent rooms** | 6 rooms, 2000 frames/room | >6 tabs evicts oldest | Moot on Xbox — one browser session |
| **Frame volume** | 100K frame hard cap | Standard battle: 300–2000 frames | Not a concern |
| **Log accumulation** | Unbounded `LocalFolder` writes | 500 battles × 20 KB = 10 MB/season | Trivial vs. Xbox storage |
| **WebView2 memory** | ~400 MB for WebView2 + 50 MB XAML | Xbox Series X: 13.5 GB available | Well under limit |
| **Log write throughput** | Async `StorageFile.WriteTextAsync` | One write per battle, ~50 KB | <100 ms, no cliff |
| **JS bridge message rate** | `WebMessageReceived` per frame; peak ~20 Hz | At 20 msg/s, C# overhead is negligible | Not a concern |

Only realistic memory risk: if WebView2 renderer process is killed under memory pressure, the tap is lost for that session. Handle `WebView2.ProcessFailed` → show error, offer reload.

---

## Data Strategy

### Data flows

| Data | Source | Processing | Stored where | Risk |
|---|---|---|---|---|
| **Battle frames** | WebSocket tap (`injected.js`) | `BattleTracker.feed()` (bundled JS) | In-memory `rooms` map in C# | Low |
| **Raw frames for log** | Same tap | Accumulated in `List<string>` per room | In-memory until flush | Low |
| **Core data** | Bundled in MSIX | Read once at startup (`loadCore`) | In-memory | `pokedex.json` 277 KB, `moves.json` 102 KB, `abilities-desc.json` 41 KB |
| **Format data** | Bundled JSON under `data/` | Loaded lazily per format (`loadFormat`) | In-memory, per-format | `sets/` 24–260 KB per gen, `abilities/` 6.5–38 KB, `moves-freq/` 31–108 KB. **`items/` `tera/` `stats/` are currently 0 bytes** — loaders already tolerate null; don't size the MSIX around them. |
| **Battle log output** | `generateBattleLog()` (bundled JS) | String generation from state + rawFrames | `LocalFolder\logs\battle_info\` | Low |
| **Debug log** | C# host logger | Append per event | `LocalFolder\logs\debug\` | Low |
| **Config** | `config.json` in `LocalFolder` | Read once at startup | In-memory `Config` | Low |
| **WebView2 profile** | Browser | Managed by WebView2 runtime | `LocalFolder\webview2-profile\` | Low |

### What becomes expensive

- `generateBattleLog(state, rawFrames, movesData, timezone)` is synchronous JS. It runs once per battle (at the `battle-end` event), not per frame — imperceptible.
- The discarded approach — `ExecuteScriptAsync("JSON.stringify(getState())")` **per frame** — was the one real cost: `state.turnLog` accumulates every raw protocol line and grows unboundedly, so polling re-serialized a growing object ~20×/sec. The event-post model removes this entirely.
- Bundling `parser.js` + `exporter.js` + `injected.js` = ~50 KB. Parse time on injection is <5 ms.

### Per-frame hot path (optimize only this)

`WebSocket.onmessage` (in-page) → `decodeSockJS` → `postMessage` → C# `WebMessageReceived` → JSON deserialize → buffer the raw frame string + `feed()` in the panel's JS tracker → coalesced render. Per frame, C# does **only** a deserialize + append to the room's `rawFrames` list. Renders are coalesced (one per animation frame, as `HelperPanel.tsx` does) so a 20-frame burst is one render. Everything else (config read, `loadCore`/`loadFormat`, log write) is per-startup or per-battle — leave it un-optimized.

### What becomes impossible

- **Arbitrary file paths**: Can't write to `~/Documents/ps-local/logs/`. Use `LocalFolder` (always available, no manifest approval needed). Path: `C:\Users\<user>\AppData\Local\Packages\<PFN>\LocalState\logs\`.
- **Env var overrides**: UWP has no shell env vars. `PS_LOG_LEVEL` / `PS_TIMEZONE` won't work. Config file only (`config.json` already supports this).
- **Single-instance lock**: UWP enforces this at platform level. No code needed.
- **Auto-update (`checkUpdatesOnBoot`)**: Not applicable for Xbox sideloaded apps. Remove.

### Staleness / cache invalidation

The `data/**` bundle is frozen at MSIX build time and **nothing detects staleness** after an upstream PS data change. With no auto-update path on Xbox, staleness is permanent until the user rebuilds and re-sideloads the MSIX. Mitigation: ship a `data/VERSION` asset (the source commit hash of the bundle) and show it in the panel so the user can tell how old their predictions are. The only mutable cache at runtime is the `rooms` map, invalidated by four triggers (battle-end, 30-min stale sweep, 100K-frame cap, `flushAllRooms` on exit) — reproduce **all four** or an abandoned spectator tab leaks for the session. `loadCore`/`loadFormat` caches are process-lifetime and immutable per build (no invalidation needed). WebView2 profile cookies are the one user-facing stale surface — a stale `sid` loops login; let WebView2 own that by pointing the profile at `LocalFolder`.

---

## Implementation Plan

### Stack

| Layer | Technology |
|---|---|
| Shell / host | C# UWP (WinUI 2 / `Windows.UI.Xaml`) — **not** WinUI 3, which has limited Xbox support |
| Embedded browser | `Microsoft.Web.WebView2` (NuGet) |
| Helper panel | Second `WebView2` control loading local `panel.html` (v1); native XAML (v2) |
| Pure libs | `injected.js` + `parser.js` + `exporter.js` bundled into one injected script |
| Log writing | `Windows.Storage` async APIs |
| Packaging | MSIX via Visual Studio UWP project |

> **WinUI 2 vs WinUI 3**: WinUI 3 (Windows App SDK) has known gaps on Xbox. WinUI 2 on UWP is the Microsoft-documented Xbox dev path.

---

### Phase 0 — De-risk on hardware (do this first)

Minimal UWP shell: one `WebView2` → `play.pokemonshowdown.com`, nothing else. Sideload to the **actual
Xbox**. Prove two things before writing any more code:
1. The WebView2 **out-of-process renderer activates** and a battle page loads (the highest-risk
   unknown — Xbox platform security may block third-party OOP child processes).
2. `AddScriptToExecuteOnDocumentCreatedAsync` fires **before** SockJS captures the socket — inject a
   trivial `console.log` tap and confirm it sees the sim WebSocket.

If either fails, stop — the approach is not viable on Xbox.

---

### Phase 1 — Project scaffold

1. New Visual Studio **Blank App (Universal Windows)** project. `MinVersion: Windows 10 Fall Creators Update (10.0.16299)` (WebView2 minimum; Xbox ships this or newer).
2. NuGet: `Microsoft.Web.WebView2` (latest stable).
3. Target platform: `x64` only (Xbox Series X is x64).
4. `Package.appxmanifest` capabilities: `internetClient`. No `documentsLibrary` — use `LocalFolder`.

**Files:**
- `MainPage.xaml` / `MainPage.xaml.cs` — split layout + host logic
- `App.xaml.cs` — lifecycle (suspend/resume)
- `BattleLogWriter.cs` — room tracking + log writing
- `Config.cs` — config model + loader
- `Logger.cs` — debug logger

---

### Phase 2 — Split-view layout

```xml
<!-- MainPage.xaml -->
<Grid>
  <Grid.ColumnDefinitions>
    <ColumnDefinition Width="*" />
    <ColumnDefinition Width="Auto" />
    <ColumnDefinition Width="400" />
  </Grid.ColumnDefinitions>
  <WebView2 x:Name="PsView" Grid.Column="0" Source="https://play.pokemonshowdown.com" />
  <GridSplitter Grid.Column="1" Width="5" />
  <WebView2 x:Name="HelperView" Grid.Column="2" />
</Grid>
```

```csharp
// MainPage.xaml.cs — PsView setup
var env = await CoreWebView2Environment.CreateAsync(
    null,
    Path.Combine(ApplicationData.Current.LocalFolder.Path, "webview2-profile"));
await PsView.EnsureCoreWebView2Async(env);
PsView.CoreWebView2.NavigationStarting += OnNavigationStarting;
PsView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
```

Ad blocking: `AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All)` + same `AD_ANALYTICS_PATTERNS` list from `showdown-ui/electron/main/index.ts`.

---

### Phase 3 — WebSocket tap injection

Bundle `helper/extension/injected.js` as `Assets/injected.js` (Content, Copy Always). Inject at `NavigationStarting`:

```csharp
private async void OnNavigationStarting(CoreWebView2 sender, CoreWebView2NavigationStartingEventArgs e)
{
    string tapSrc = await ReadAssetAsync("injected.js");
    string bridge = @"
        window.addEventListener('message', function(e) {
            var m = e.data;
            if (!m || m.__psHelper !== true) return;
            // Frame data (mirror ps.ts: validate token + string payload, never trust origin '*').
            if (typeof m.data === 'string') {
                window.chrome.webview.postMessage(JSON.stringify({ type: 'ps-frame', data: m.data }));
                return;
            }
            // Tap-status channel — relay so the host/panel can surface a dead tap.
            if (m.tap === 'inactive') {
                window.chrome.webview.postMessage(JSON.stringify({ type: 'tap-status', reason: m.reason }));
            }
        });
    ";
    await sender.AddScriptToExecuteOnDocumentCreatedAsync(tapSrc + "\n" + bridge);
}
```

> **Relay both message shapes.** `injected.js` posts frames (`{ __psHelper:true, data }`) **and** status
> (`{ __psHelper:true, tap:'inactive', reason }`). Validate `__psHelper === true` and (for frames)
> `typeof data === 'string'` exactly as `showdown-ui/electron/preload/ps.ts:47-52` does. `injected.js`
> already posts to `window.location.origin` (never `'*'`) — a guard test enforces this; mirror it by
> ignoring messages whose origin isn't `play.pokemonshowdown.com`. **Buffer every frame in C# from the
> first one** so a late/raced panel listener can replay (Failure Mode: async injection race).

`window.chrome.webview.postMessage()` is WebView2's built-in JS→C# relay. Receive in C#:

```csharp
private void OnWebMessageReceived(CoreWebView2 sender, CoreWebView2WebMessageReceivedEventArgs e)
{
    var msg = JsonSerializer.Deserialize<WebMessage>(e.WebMessageAsJson);
    switch (msg?.Type)
    {
        case "ps-frame":     _ = HandleFrameAsync(msg.Data); break;       // buffer + feed panel tracker
        case "tap-status":   ShowTapDead(msg.Reason); break;             // surface on screen
        case "battle-end":   _ = WriteLogForRoomAsync(msg.Roomid); break; // one getState() round-trip here
    }
}
```

Treat `WebMessageAsJson` as fully untrusted input: parse defensively and cap message size. Never build
`ExecuteScriptAsync` strings by interpolating frame data with `$"...{x}..."` — always go through
`JsonSerializer` (injection risk).

---

### Phase 4 — Frame handling and log writing

**Approach (decided): JS tracker + event-post.** Keep `parser.js` + `exporter.js` inside `PsView`'s JS
context behind a `window.__psTracker`. The injected JS feeds each frame and runs the end-detection
predicate; only when a battle **ends** does it post `{ __psHelper:true, type:'battle-end', roomid }`.
C# then does a **single** round-trip to fetch state + build the log:

```csharp
// Only at battle-end (not per frame) — one round-trip, builds the log string in JS.
async Task WriteLogForRoomAsync(string roomid)
{
    string richLogText = await PsView.CoreWebView2.ExecuteScriptAsync(
        $"window.__psTracker.buildLog({JsonSerializer.Serialize(roomid)})");  // generateBattleLog inside
    await WriteLogAsync(roomid, richLogText);
}
```

**End-detection is a contract — port `helper/extension/lib/logmeta.js` verbatim** (it's already pure and
unit-tested). Reproduce `battleEndReason(frameData, turn)` exactly, including its subtleties:
`|win|` → `/\|win\|/`; tie → **line-anchored** `/^\|tie\b/m` (the real frame is bare `|tie` with no
trailing pipe; `\|tie\|` never fires and `\|tie` false-positives on chat); `|deinit` only ends the
battle when `turn >= 1`.

> Not chosen: porting `BattleTracker` + `generateBattleLog` to C# (~800 JS → ~1200 C# lines). Full type
> safety, but a second implementation that must track every upstream protocol change forever. Revisit
> only if the JS round-trip proves problematic on device.

**Filename format (correction).** Use `battleLogFilename()`/`sanitize()` from `logmeta.js` exactly — the
scheme is `<ts>_<roomid>_[SPEC_]<p1>_vs_<p2>.txt` (ts first; `SPEC_` prefix when `state.mySide` is null;
**no `WIN`/`TIE`/`winner` token in the name**). `sanitize` maps `[^A-Za-z0-9_-] → _` and is also the
trust gate that prevents a crafted player name from path-traversing the filename. The filename is a
de-facto schema other tooling reads — don't invent a new one.

Log writing:
```csharp
var folder = await ApplicationData.Current.LocalFolder
    .CreateFolderAsync(@"logs\battle_info", CreationCollisionOption.OpenIfExists);
var file = await folder.CreateFileAsync(filename, CreationCollisionOption.ReplaceExisting);
await FileIO.WriteTextAsync(file, richLogText);
```

Room tracking: `Dictionary<string, RoomEntry>` in `BattleLogWriter`. Stale sweep via `DispatcherQueueTimer` (5 min interval, 30 min idle threshold). Hard cap: 100K frames → flush + evict.

---

### Phase 5 — Helper panel

**v1 (build this):** `HelperView` loads `Assets/panel.html` (`ms-appx:///Assets/panel.html`). The HTML
inlines `render.js` + `panel.css` + `BattleTracker`. C# sends frames via:

```csharp
await HelperView.CoreWebView2.ExecuteScriptAsync(
    $"window.onPsFrame({JsonSerializer.Serialize(frameData)})");
```

Panel JS calls `BattleTracker.feed()`, renders via `render.js`, updates `innerHTML` — identical to the
React panel's `dangerouslySetInnerHTML` path. **Required additions** (the WebView2 injection race makes
these mandatory, not optional — copy `HelperPanel.tsx`'s behavior): buffered-frame **replay** on panel
load, a **5s auto-resync** (frames arriving but nothing parsing → rebuild from buffer), manual resync,
and rendering the **tap-dead / write-failed** status on screen.

**Data loading — the `ms-appx-web://` adapter (decided).** The panel needs `loadCore`/`loadFormat`, but
neither existing loader works here (Vite `import.meta.glob` is build-time; the extension's
`api.runtime.getURL` is extension-only). Add a third adapter inside `panel.html` that
`fetch`es `ms-appx-web:///Assets/data/<path>.json`, and pass `ms-appx-web://…/Assets/` as `render.js`'s
`assetBase` so category icons resolve. The loaders already tolerate missing files (returns null), so the
0-byte `items/`/`tera/`/`stats/` assets are fine.

**v2 (later):** Native XAML controls + C# view-model. Controller-navigable, Xbox UI guidelines compliant. Translates `render.js` HTML output to XAML bindings.

---

### Phase 5.5 — Controller input

> **Local prototype first.** `showdown-ui/` (the Electron app) now ships a `useGamepad.ts` hook so the controller UX can be validated on Mac before writing any C# input code. The Gamepad API (`navigator.getGamepads()`) is standard in Chromium/Electron; the button indices and focus model below are identical to what the UWP port will use.

#### Interaction model

| Button | Mode | Action |
|---|---|---|
| LB (4) / RB (5) | always | Toggle focus: **GAME** ↔ **HELPER** |
| A (0) | HELPER | Re-sync — rebuild the battle helper from the frame buffer |
| Left stick Y / D-pad ↑↓ | HELPER | Scroll the helper panel |

**GAME mode** (default): only the LB/RB toggle fires; all other buttons are no-ops. The PS game itself does not understand controller input — this just prevents accidental Re-sync while playing.

**HELPER mode**: LB/RB switches back; A triggers Re-sync; stick/D-pad scrolls the panel.

Visual indicator: a 2 px accent inset ring on the helper panel column + a small **GAME** / **HELPER** badge in the header bar.

#### Electron implementation (`showdown-ui/`)

Five files change — no new IPC channels needed:

**`src/hooks/useGamepad.ts`** (new file) — owns the rAF polling loop.

```ts
// Self-scheduling rAF loop; callbacks accessed via stable cbRef to avoid stale closures.
// Button deduplication: prevButtons boolean[] — fire only on rising edge (pressed && !prev).
// Scroll is continuous: axes[1] * SCROLL_SPEED (8 px/frame), deadzone 0.15.
const SCROLL_SPEED = 8
export function useGamepad({ onToggleFocus, onResync, onScroll, helperFocusedRef }: GamepadCallbacks) {
  // empty-deps useEffect; cbRef keeps callbacks current without recreating the loop
}
```

**`src/App.tsx`** — add `helperFocused` state + ref, `scrollHelperByRef`, `useGamepad` call, focus badge.

```ts
const [helperFocused, setHelperFocused] = useState(false)
const helperFocusedRef = useRef(false)
const scrollHelperByRef = useRef<(delta: number) => void>(() => {})
useEffect(() => { helperFocusedRef.current = helperFocused }, [helperFocused])

useGamepad({
  onToggleFocus: useCallback(() => setHelperFocused(f => !f), []),
  onResync: useCallback(() => setResyncSignal(n => n + 1), []),
  onScroll: (delta) => scrollHelperByRef.current(delta),
  helperFocusedRef,
})
```

Header badge (before Re-sync button):
```tsx
<span className={`focus-badge${helperFocused ? ' focus-badge--active' : ''}`}>
  {helperFocused ? 'HELPER' : 'GAME'}
</span>
```

**`src/routes/Battle.tsx`** — take `helperFocused` + `scrollHelperByRef` props; own the scroll container (moved from `HelperPanel`); apply focus ring class.

```tsx
// Scroll container (replaces HelperPanel's overflowY: auto wrapper)
const scrollRef = useRef<HTMLDivElement>(null)
useEffect(() => {
  scrollHelperByRef.current = (delta) => scrollRef.current?.scrollBy({ top: delta, behavior: 'auto' })
}, [scrollHelperByRef])

// Right column wrapper
<div className={`panel-column${helperFocused ? ' panel-column--focused' : ''}`} ...>
  <div style={colHeader}>Battle Helper</div>
  <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto' }}>
    <HelperPanel resyncSignal={resyncSignal} />
  </div>
</div>
```

**`src/components/HelperPanel.tsx`** — remove `overflowY: 'auto'` from the outer div (scroll now owned by `Battle`).

**`src/styles/global.css`** — focus ring and badge classes:
```css
.panel-column { transition: box-shadow 0.1s ease-out; }
.panel-column--focused { box-shadow: inset 0 0 0 2px var(--accent); }
.focus-badge { font-size: 10px; color: var(--muted); border: 1px solid currentColor;
               border-radius: 3px; padding: 1px 5px; letter-spacing: 0.04em; user-select: none; }
.focus-badge--active { color: var(--accent); }
```

#### UWP/C# port (`ps-local-xbox/`)

The Electron prototype maps 1:1 to UWP input APIs:

| Electron | UWP |
|---|---|
| `navigator.getGamepads()` rAF loop | `Gamepad.GetCurrentReadings()` in a `DispatcherQueueTimer` (16 ms) |
| button index 4/5 (LB/RB) | `GamepadButtons.LeftShoulder` / `RightShoulder` |
| button index 0 (A) | `GamepadButtons.A` |
| `axes[1]` left stick Y | `GamepadReading.LeftThumbstickY` |
| D-pad 12/13 | `GamepadButtons.DPadUp` / `DPadDown` |
| `helperFocused` boolean | `FocusManager.TrySetFocus(helperScrollViewer)` vs `TrySetFocus(psWebView2)` |
| panel `.scrollBy()` | `helperScrollViewer.ChangeView(null, offset + delta, null)` |
| focus ring `inset box-shadow` | XAML `BorderBrush` / `BorderThickness` on the panel column |

**Panel width on Xbox**: fix at 400 px (no `GridSplitter` — no mouse). Remove the divider `ColumnDefinition Width="Auto"` from `MainPage.xaml` and set the panel column to `Width="400"`. The Electron divider continues to work on Mac/PC (mouse users keep resize; controller users use the fixed layout).

**Xbox 10-foot UI notes**: set `IsTabStop="False"` on all non-interactive XAML elements inside the helper panel (v1 is a `WebView2` — tab stops are inside the HTML, not XAML). In v2 (native XAML panel), apply `XYFocusKeyboardNavigation="Disabled"` to the `PsView` column so D-pad automatically flows into the helper column when HELPER mode is active.

---

### Phase 6 — Lifecycle and flush

```csharp
// App.xaml.cs
protected override async void OnSuspending(object sender, SuspendingEventArgs e)
{
    var deferral = e.SuspendingOperation.GetDeferral();
    await BattleLogWriter.Instance.FlushAllRoomsAsync("suspend");
    deferral.Complete();
}

// Also wire:
Application.Current.UnhandledException += async (s, e) => {
    e.Handled = true;
    await BattleLogWriter.Instance.FlushAllRoomsAsync("unhandled-exception");
};
```

---

### Phase 7 — MSIX packaging and Xbox sideload

**Build:**
1. Visual Studio → **Project → Publish → Create App Packages → Sideloading**.
2. Self-sign with new certificate (wizard handles this).
3. Export `.cer` from the signing certificate.

**Bundle WebView2 runtime** (required — Xbox ships Win10, WebView2 may not be inbox):
- NuGet WebView2: select "Fixed Version" runtime packaging.
- Add `Extensions` entry in `Package.appxmanifest` pointing at the runtime folder.
- Adds ~130 MB to MSIX; acceptable for a sideloaded dev tool.

**Deploy to Xbox Series X (Developer Mode):**
1. Open Xbox Device Portal: `https://<xbox-ip>:11443`
2. **Home → Add certificate** → upload `.cer` to trust your self-sign cert.
3. **Apps → Deploy** → upload `.msixbundle`.
4. Launch from **My Games & Apps → Apps**.

---

### Xbox-specific constraints

| Constraint | Handling |
|---|---|
| No mouse/keyboard by default | Fix helper panel at 400px width; skip GridSplitter or make it controller-focusable |
| UWP file I/O sandbox | All writes via `ApplicationData.Current.LocalFolder` |
| 5-second suspend deadline | `SuspendingEventArgs.GetDeferral()` + async flush |
| No shell env vars | Config file only (`LocalFolder\config.json`) |
| Self-signed MSIX | Device Portal cert install before package deploy |
| WebView2 OOP process policy | **Test on device first** (Phase 0) — Xbox may block child renderer processes |

---

### Security, trust & blast radius

- **Trust boundaries:** (1) untrusted in-page JS (PS client + any ad that slips the blocklist) → tap:
  the only auth is the `__psHelper` token + same-origin `postMessage`; the C# bridge must re-validate.
  (2) JS → C# `WebMessageReceived`: untrusted input — parse defensively, cap size, never string-interpolate
  into `ExecuteScriptAsync`. (3) frame data → filesystem: `sanitize()` on player names is the path-traversal
  gate. (4) self-signed cert → Xbox trusted root: a real trust decision (below).
- **Blast radius:** a compromised in-page tap can post arbitrary frames (worst case: attacker-influenced
  log `.txt` bodies, local-only, low impact) but **cannot escape the WebView2 sandbox** or reach Xbox
  system APIs. A compromised C# host is capped by declared capabilities — **declare only `internetClient`,
  write only to `LocalFolder`; do NOT add `documentsLibrary`/`broadFileSystemAccess`**. The widest-reach
  item is the **trusted-root cert** (any package signed with it can install) — use a **dedicated cert for
  this app only** and document its removal.
- **Crypto:** no app-level crypto. TLS is Chromium's; the only key is the MSIX signing cert (RSA-2048+/
  ECDSA-P256, SHA-256, real expiry — VS wizard defaults are fine; don't reuse across apps).
- **Secrets:** **do not** reproduce the legacy testclient-`sid` injection — use normal PS login + WebView2
  profile cookies, so no secret lives in code/config. PS frames can carry auth-adjacent data
  (`|challstr|`/`|updateuser|`); the rich log appends raw frames verbatim — acceptable on a single-user
  console in `LocalFolder`, but never log raw frames at INFO, and note it in the privacy section.
- **Reversibility:** the port lives in a **separate repo** and the `helper/` asset copy must be **one-way**
  (a `cp`/concat into the C# project, never an edit back). Assert `git -C ps-local status --porcelain` is
  clean after the build step (mirrors the `vendor/` invariant). On-device, Device Portal uninstall removes
  the app + `LocalFolder`; the only residue is the trusted-root cert — make removing it a documented step.

### Observability (file-based — there's no terminal on a console)

- Reproduce the three-logger format (`ISO [LEVEL] [ns] msg`, `PS_LOG_LEVEL` threshold via config since
  there are no env vars) into `LocalFolder\logs\debug\showdown-ui-<ts>.log` — the only post-mortem tool.
- **Surface tap-status + write-failure on screen** (no terminal to read the file from).
- Log lifecycle events: WebView2 `ProcessFailed`, injection success, every `flushAllRooms(reason)` with
  room count, stale + frame-cap evictions, and whether the `Suspending` flush finished inside the 5s budget.
- Add an on-screen **tap heartbeat** (frames-seen, last-frame-age) — the single best "is it working now?"
  signal — and a resync counter (high rate ⇒ the injection race is biting).
- Enable WebView2 DevTools via Device Portal / `--remote-debugging-port` in dev builds (verification §6).

---

### Project structure

```
ps-local-xbox/               (new repo, separate from ps-local)
  ps-local-xbox.sln
  ps-local-xbox/
    Package.appxmanifest
    App.xaml
    App.xaml.cs
    MainPage.xaml
    MainPage.xaml.cs
    BattleLogWriter.cs
    Config.cs
    Logger.cs
    Assets/
      injected.js            ← copy of helper/extension/injected.js
      panel.html             ← inlines parser.js + exporter.js + render.js + logmeta.js + panel.css
      data/                  ← copy of helper/extension/data/** (incl. moves.json, pokedex.json)
      data/VERSION           ← source commit hash of the bundle (staleness signal)
```

Pure libs (`parser.js`, `exporter.js`, `render.js`, **`logmeta.js`** — the filename + end-detection
contract) are inlined into `panel.html` at build time via a concat script. The C# project lives outside
this repo and pulls assets from `helper/` as a **one-way** build step (assert the source repo stays
git-clean afterward — the `vendor/` invariant applied to `helper/`).

---

### Verification checklist

0. **Phase 0 gate**: On real Xbox hardware, the WebView2 OOP renderer activates and the injection tap sees the sim socket. (If not, stop.)
1. **Tap works**: Start a battle in `PsView`, confirm `WebMessageReceived` fires with `ps-frame` payloads in the debugger.
2. **Log written + filename**: Complete a battle; confirm the file matches `<ts>_<roomid>_[SPEC_]<p1>_vs_<p2>.txt` (the corrected scheme — **not** the old WIN/TIE form) with correct content.
3. **Tie / early-leave edge cases**: Drive a tie and an unstarted-room leave through the tap; confirm the tie writes and the unstarted leave writes nothing (validates the `battleEndReason` port).
4. **Tap-dead surfacing**: Block the sim socket; confirm a `tap:'inactive'` status renders **on screen**, not just in the log.
5. **Injection-race resilience**: Force a slow injection; confirm buffered-frame replay reconstructs the battle (no permanently-blank panel).
6. **Session persistence**: Log in, close app, reopen — PS shows logged-in state (WebView2 profile cookie persistence).
7. **Xbox install**: Deploy MSIX via Device Portal. App appears in My Games & Apps. Launches without crash.
8. **Suspend flush within 5s**: Start a battle, suspend, resume — confirm an `INPROGRESS` file **and** a debug-log line showing the flush completed inside the deadline.
9. **Ad blocking**: No Venatus/Google Ad network requests in WebView2 DevTools (connect via `--remote-debugging-port` or Device Portal browser tool).
10. **Repo cleanliness + cert removal**: After the asset-copy build step, `git status --porcelain` on `ps-local` is empty; document removing the trusted-root cert via Device Portal.
11. **Controller — Electron prototype (Mac)**: Connect a USB/Bluetooth controller. `npm start` from `showdown-ui/`. Press RB/LB — GAME/HELPER badge toggles and panel focus ring appears/disappears. In HELPER mode: left stick Y / D-pad scrolls the helper panel; A button triggers Re-sync. In GAME mode: all buttons are no-ops except LB/RB.
12. **Controller — UWP/Xbox**: Same interaction model via `Windows.Gaming.Input`. LB/RB toggles focus (XAML `FocusManager`); D-pad/stick scrolls `ScrollViewer`; A triggers resync. Helper panel is fixed 400 px — no divider drag needed. Focus ring visible as XAML border on the panel column.
