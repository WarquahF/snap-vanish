# Snap Vanish - Thanos dust for Zoom

Snap your fingers in a Zoom meeting and you dissolve into dust, live on camera.
Snap again and the dust flies back and you reassemble. Only you vanish - your
background stays.

Works on the **Zoom web client** (join from browser) in **Firefox / Zen Browser**.
It cannot touch the Zoom desktop app's camera - join the meeting from the
"Join from your browser" link instead.

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
5. Join a Zoom meeting from the browser (`https://zoom.us/j/...` -> "Join from
   your browser"), allow camera + mic.

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

- Temporary add-ons unload when the browser restarts. Reload via
  `about:debugging` after each restart, or get it signed (AMO) for permanent
  install.
- Zoom's own noise suppression does not affect snap detection (separate mic
  capture with EC/NS disabled).
- If WebGL2 is unavailable the camera passes through untouched.
