// Mirror of the Railway renderer's duration allocation (reelStoryboard.allocateDurations).
// Keep in sync: reveal scenes need >= REVEAL_MIN seconds, other scenes >= SCENE_MIN.
const SCENE_MIN = 2.5, REVEAL_MIN = 3.0;
const PRESETS = ["classic_reveal", "luxury_drift", "cinematic_reveal"];
function allocateDurations(lengthSec, reveals) {
  const n = reveals.length;
  let d = reveals.map((r) => (r ? Math.max(lengthSec / n, REVEAL_MIN) : lengthSec / n));
  let over = d.reduce((a, b) => a + b, 0) - lengthSec;
  for (let pass = 0; pass < 6 && over > 1e-9; pass++) {
    const room = d.map((x, i) => (reveals[i] ? 0 : Math.max(0, x - SCENE_MIN)));
    const tot = room.reduce((a, b) => a + b, 0);
    if (tot <= 1e-9) break;
    const cut = Math.min(over, tot);
    d = d.map((x, i) => x - (cut * room[i]) / tot);
    over -= cut;
  }
  return over > 1e-6 ? null : d;
}
module.exports = { allocateDurations, SCENE_MIN, REVEAL_MIN, PRESETS };
