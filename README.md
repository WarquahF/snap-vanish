# Snap Vanish - Thanos dust for video calls

Snap your fingers in a browser video call and you dissolve into dust, live on
camera. Snap again and the dust flies back and you reassemble. Only people
vanish - your background stays.

Works in **Firefox / Zen Browser** on supported browser call sites (the desktop
apps' cameras cannot be touched - always join from the browser).

Supported sites (camera is only ever intercepted on sites YOU enable, one
toggle per site in the extension popup):

| Site | Host | Status |
| --- | --- | --- |
| Zoom web client | *.zoom.us | expected to work - not live-tested |
| Google Meet | meet.google.com | expected to work - not live-tested |
| Proton Meet | meet.proton.me | expected to work - not live-tested |
| Microsoft Teams | teams.microsoft.com, teams.live.com | expected to work - not live-tested |
| Discord (web) | discord.com | expected to work - not live-tested |
| Webex | *.webex.com | expected to work - not live-tested |
| Jitsi Meet | meet.jit.si | expected to work - not live-tested |
| Whereby | *.whereby.com | expected to work - not live-tested |
| WhatsApp Web calls | web.whatsapp.com | expected to work - not live-tested; web calling is a gradual WhatsApp rollout, so your account may not have it yet |

"Expected to work" = these sites all take the camera via getUserMedia in page
context, which is what the extension wraps. The effect pipeline itself is
tested offline end-to-end (see "Notes / limits"). Only load-test a site
before relying on it in a real call.

## Install (Firefox or Zen, Linux)

Temporary install (survives until browser restart):

1. Unzip the extension somewhere permanent, e.g.:
   ```fish
   mkdir -p ~/extensions
   unzip ~/Downloads/snap-vanish.zip -d ~/extensions/snap-vanish
   ```
2. Open `about:debugging#/runtime/this-firefox` in the address bar.
3. Click **Load Temporary Add-on...**
4. Pick any file inside `~/extensions/snap-vanish` (e.g. `manifest.json`).
5. Open a supported call site (e.g. `https://zoom.us` -> "Join from your
   browser", `https://meet.google.com`, `https://meet.proton.me`).
6. Click the Snap Vanish toolbar icon -> tick **Enable on <site>** (one time
   per site). Until you do, the camera passes through completely untouched.
7. Join the call, allow camera + mic.

## Updating

```fish
cd ~/extensions/snap-vanish
git pull
```
Then in the browser: `about:debugging#/runtime/this-firefox` -> Snap Vanish ->
**Reload**.

## Use

- **Snap your fingers** -> you disintegrate into dust.
- **Snap again** -> you reassemble.
- For a clean vanish while you stay seated: click the toolbar popup ->
  **Capture clean background** while you are OUT of frame, then step back in.
  Without it, the hole you leave is filled with an inpainted guess (a smooth
  smudge - the camera still sees you, so true background is unknowable).
  If you vanish and then step away, the live room fills in by itself.
- Backup toggle: `Ctrl+Shift+S`, or the Snap Vanish toolbar popup button.
- The extension asks for mic access so it can hear the snap even when Zoom
  has you muted. Snap detection is transient-based (rejects speech and beeps).

## How it works

- A page-context script wraps `navigator.mediaDevices.getUserMedia`; when Zoom
  asks for the camera, frames go through a WebGL2 pipeline and Zoom receives
  the processed `canvas.captureStream()` track instead.
- Person segmentation runs in-page with BodyPix (bundled, no network) so only
  you dissolve. The hole you leave is filled with a pull-push pyramid inpaint
  of the surrounding background.
- The dissolve is a GPU point-sprite particle system: staggered per-particle
  delays, outward scatter, upward drift, exact reverse on reassembly.
- Snap detection: spectral flux onset in the 1.8-8 kHz band with a fast-decay
  check and a refractory period (see `snap-detector.js`).

## Files

- `manifest.json` - MV3 manifest (Firefox 128+ / Zen)
- `bridge.js` - isolated content script (popup/keyboard bridge)
- `inject.js` - page-context pipeline (gUM wrap, WebGL2 render, particles)
- `snap-detector.js` - finger-snap onset detector
- `tf.min.js`, `body-pix.min.js`, `model-stride16.json`,
  `group1-shard1of1.bin` - bundled person segmentation model
- `popup.html`, `popup.js`, `icon.svg` - toolbar popup

## Notes / limits

- **Prototype, tested offline.** Verified in Chrome-for-Testing and Firefox
  ESR with a synthetic camera feed (real BodyPix segmentation, real
  calibration, real vanish/reassemble). The live Zoom web client and Zen
  Browser specifically have NOT been tested yet - treat first real use as a
  test run.
- **Every detected person vanishes.** The effect removes all people the
  segmenter sees - if a colleague walks into frame, they dissolve too. It
  does not identify you specifically.
- For best results sit close (head-and-shoulders framing) with decent,
  even lighting. Small, distant, or low-contrast people can be partially
  missed by the segmenter, leaving fragments.
- Use **Capture clean background** (out of frame) before vanishing for a
  clean result. Without it, faint seams/smudge can remain where you sat.
- Temporary add-ons unload when the browser restarts. Reload via
  `about:debugging` after each restart, or get it signed (AMO) for permanent
  install.
- Zoom's own noise suppression does not affect snap detection (separate mic
  capture with EC/NS disabled).
- If WebGL2 is unavailable the camera passes through untouched.
