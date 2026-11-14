/* SnapDetector: finger-snap onset detection from an AnalyserNode.
 * A snap is a short (2-20ms) broadband transient: a strong spectral flux
 * spike in the 1.8-8 kHz band that DECAYS back to baseline within ~140ms.
 * Sustained tones (beeps, notification pings) and continuous speech fail the
 * decay check and are rejected.
 *
 * UMD-ish: usable as a page-global (SnapDetector) and from node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnapDetector = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  class SnapDetector {
    constructor(opts) {
      opts = opts || {};
      this.sampleRate = opts.sampleRate || 48000;
      this.fftSize = opts.fftSize || 1024;
      this.lowHz = opts.lowHz || 1800;
      this.highHz = opts.highHz || 8000;
      this.fluxRatio = opts.fluxRatio || 2.6;
      this.fluxFloor = opts.fluxFloor != null ? opts.fluxFloor : 26;
      this.energyFloor = opts.energyFloor != null ? opts.energyFloor : 30;
      this.decayMs = opts.decayMs || 140;
      this.decayRatio = opts.decayRatio || 0.45;
      this.refractoryMs = opts.refractoryMs || 1400;
      this.onSnap = opts.onSnap || function () {};
      this._prev = null;
      this._baseline = 0;
      this._baselineInit = false;
      this._lastSnap = 0;
      this._pending = null; // {t, energy}
      this.snaps = 0;
    }

    process(freqBytes, nowMs) {
      const binHz = this.sampleRate / this.fftSize;
      const lo = Math.max(1, Math.floor(this.lowHz / binHz));
      const hi = Math.min(freqBytes.length - 1, Math.ceil(this.highHz / binHz));

      let flux = 0;
      let bandEnergy = 0;
      const n = hi - lo + 1;
      if (this._prev) {
        for (let i = lo; i <= hi; i++) {
          const d = freqBytes[i] - this._prev[i];
          if (d > 0) flux += d;
          bandEnergy += freqBytes[i];
        }
      }
      if (!this._prev) this._prev = new Uint8Array(freqBytes);
      else this._prev.set(freqBytes);
      flux /= n;
      bandEnergy /= n;

      if (!this._baselineInit) {
        this._baseline = flux;
        this._baselineInit = true;
        return false;
      }
      this._baseline = this._baseline * 0.92 + flux * 0.08;

      const now = nowMs != null ? nowMs : Date.now();

      // confirmation phase: spike must decay quickly (short transient)
      if (this._pending) {
        if (now - this._pending.t > this.decayMs) {
          this._pending = null; // sustained sound, not a snap
        } else if (bandEnergy < Math.max(this.energyFloor * 0.6, this._pending.energy * this.decayRatio)) {
          this._pending = null;
          if (now - this._lastSnap > this.refractoryMs) {
            this._lastSnap = now;
            this.snaps++;
            this.onSnap({ flux: flux, baseline: this._baseline, bandEnergy: bandEnergy });
            return true;
          }
          return false;
        }
      }

      // spike phase
      if (flux > this.fluxFloor &&
          flux > Math.max(this.fluxFloor, this._baseline * this.fluxRatio) &&
          bandEnergy > this.energyFloor) {
        this._pending = { t: now, energy: bandEnergy };
      }
      return false;
    }
  }

  return SnapDetector;
});
