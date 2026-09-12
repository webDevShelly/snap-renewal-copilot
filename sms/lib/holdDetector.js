// Decides when a human has come on the line, from the raw audio of the office leg.
//
// The signal is the transition, not the voice itself: hold music and IVR prompts
// play continuously, and when a caseworker picks up the music cuts to a brief
// silence before they speak. So we arm on a silence gap longer than music
// produces, then fire on sustained speech after that gap.
//
// Energy alone cannot tell an IVR prompt from a person, so `minCallMs` skips the
// opening stretch where menus play. For anything load-bearing, pair this with
// `confirmHuman()` on the session (see routes/voice.js) or an ASR check.
//
// Audio arrives as 16-bit signed little-endian mono PCM.
const DEFAULTS = {
  sampleRate: 16000,
  frameMs: 20,
  silenceRms: 500,     // below this, a frame counts as quiet
  speechRms: 1200,     // above this, a frame counts as voiced
  armSilenceMs: 1500,  // quiet stretch that arms the detector
  speechMs: 700,       // voiced audio after arming that declares a human
  minCallMs: 10000     // ignore this opening window, where IVR menus play
};

class HoldDetector {
  constructor(options = {}) {
    this.options = { ...DEFAULTS, ...options };
    this.armed = false;
    this.quietMs = 0;
    this.voicedMs = 0;
    this.elapsedMs = 0;
    this.decided = false;
  }

  static rms(frame) {
    if (!frame.length) return 0;
    let sum = 0;
    let count = 0;
    for (let index = 0; index + 1 < frame.length; index += 2) {
      const sample = frame.readInt16LE(index);
      sum += sample * sample;
      count += 1;
    }
    return count ? Math.sqrt(sum / count) : 0;
  }

  /** Feed a chunk of PCM. Returns true once, when a human is detected. */
  push(chunk) {
    if (this.decided) return false;
    const { frameMs, sampleRate, silenceRms, speechRms, armSilenceMs, speechMs, minCallMs } = this.options;
    const bytesPerFrame = Math.round((sampleRate * frameMs) / 1000) * 2;

    for (let offset = 0; offset + bytesPerFrame <= chunk.length; offset += bytesPerFrame) {
      const level = HoldDetector.rms(chunk.subarray(offset, offset + bytesPerFrame));
      this.elapsedMs += frameMs;
      if (this.elapsedMs < minCallMs) continue;

      if (level < silenceRms) {
        this.quietMs += frameMs;
        this.voicedMs = 0;
        if (this.quietMs >= armSilenceMs) this.armed = true;
      } else {
        this.quietMs = 0;
        if (level >= speechRms) {
          this.voicedMs += frameMs;
          if (this.armed && this.voicedMs >= speechMs) {
            this.decided = true;
            return true;
          }
        } else {
          this.voicedMs = 0;
        }
      }
    }
    return false;
  }
}

module.exports = { HoldDetector, DEFAULTS };
