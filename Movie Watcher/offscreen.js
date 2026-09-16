/* Plays a short alert tone. Synthesised, so there is no audio file to ship. */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "marquee-chime") chime();
});

function chime() {
  const ctx = new (self.AudioContext || self.webkitAudioContext)();
  const now = ctx.currentTime;
  // Three rising notes, roughly a cinema bell.
  [660, 880, 1320].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    const t = now + i * 0.16;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.28, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.6);
  });
  setTimeout(() => ctx.close().catch(() => {}), 1600);
}
