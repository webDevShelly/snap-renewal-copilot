const test = require('node:test');
const assert = require('node:assert');
const { HoldDetector } = require('../lib/holdDetector');

const SAMPLE_RATE = 16000;

function pcm(milliseconds, amplitude) {
  const samples = Math.round((SAMPLE_RATE * milliseconds) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    // Alternate sign so the waveform has energy rather than a DC offset.
    buffer.writeInt16LE(index % 2 === 0 ? amplitude : -amplitude, index * 2);
  }
  return buffer;
}

const MUSIC = 6000;
const VOICE = 6000;
const QUIET = 50;

function feed(detector, segments) {
  for (const [milliseconds, amplitude] of segments) {
    if (detector.push(pcm(milliseconds, amplitude))) return true;
  }
  return false;
}

test('does not fire on continuous hold music', () => {
  const detector = new HoldDetector();
  assert.equal(feed(detector, [[60000, MUSIC]]), false);
});

test('does not fire during the opening IVR window', () => {
  const detector = new HoldDetector();
  // A menu prompt, a gap, then more prompting, all inside minCallMs.
  assert.equal(feed(detector, [[3000, VOICE], [2000, QUIET], [3000, VOICE]]), false);
});

test('fires when music stops and a person speaks', () => {
  const detector = new HoldDetector();
  const fired = feed(detector, [[30000, MUSIC], [2000, QUIET], [1000, VOICE]]);
  assert.equal(fired, true);
});

test('does not fire on a short gap between songs', () => {
  const detector = new HoldDetector();
  assert.equal(feed(detector, [[20000, MUSIC], [400, QUIET], [5000, MUSIC]]), false);
});

test('fires only once', () => {
  const detector = new HoldDetector();
  assert.equal(feed(detector, [[30000, MUSIC], [2000, QUIET], [1000, VOICE]]), true);
  assert.equal(detector.push(pcm(1000, VOICE)), false);
});
