(() => {
"use strict";

/* ============================== utils ============================== */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const hash1 = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };
const mixColor = (c1, c2, t) => [
  Math.round(lerp(c1[0], c2[0], t)),
  Math.round(lerp(c1[1], c2[1], t)),
  Math.round(lerp(c1[2], c2[2], t)),
];
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

const STORE_KEY = "reefRunner.save.v1";
function loadSave() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) throw 0;
    const d = JSON.parse(raw);
    return {
      bestScore: d.bestScore || 0,
      bestDistance: d.bestDistance || 0,
      bestMultiplier: d.bestMultiplier || 1,
      totalVoyages: d.totalVoyages || 0,
      totalPassengers: d.totalPassengers || 0,
    };
  } catch {
    return { bestScore: 0, bestDistance: 0, bestMultiplier: 1, totalVoyages: 0, totalPassengers: 0 };
  }
}
function saveSave(s) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

/* ============================== canvas / dpr ============================== */
const canvas = document.getElementById("scene");
const ctx = canvas.getContext("2d");
let W = 0, H = 0, DPR = 1;
function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 2.5);
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.round(W * DPR);
  canvas.height = Math.round(H * DPR);
  canvas.style.width = W + "px";
  canvas.style.height = H + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
window.addEventListener("resize", resize);
resize();

/* ============================== world / terrain ============================== */
const SEG_LEN = 230;
const SAFE_START = 620;
const DIFFICULTY_DISTANCE = 7000;

function progress() { return clamp(scrollX / DIFFICULTY_DISTANCE, 0, 1); }
function speedAt() { return lerp(235, 440, progress()) * (boostTimer > 0 ? 1.22 : 1); }
function maxHalfFrac() { return lerp(0.36, 0.27, progress()); }
function minHalfFrac() { return lerp(0.23, 0.16, progress()); }
function narrowAmpFrac() { return lerp(0.07, 0.12, progress()); }

function centerAt(wx) {
  return H * 0.5
    + Math.sin(wx * 0.00135) * H * 0.105
    + Math.sin(wx * 0.00061 + 1.7) * H * 0.055
    + Math.sin(wx * 0.0027 + 4.4) * H * 0.025;
}
function halfWidthAt(wx) {
  const base = H * maxHalfFrac();
  const floor = H * minHalfFrac();
  const narrowWave = Math.max(0, Math.sin(wx * 0.00205 + 0.6)) ** 5;
  const amp = H * narrowAmpFrac();
  return Math.max(floor, base - narrowWave * amp);
}

const segments = new Map();
function getSegment(i) {
  let seg = segments.get(i);
  if (seg) return seg;
  const wx = i * SEG_LEN + SEG_LEN * 0.5 + (hash1(i * 3.13) - 0.5) * SEG_LEN * 0.55;
  if (wx < SAFE_START) { seg = { type: null, id: i }; segments.set(i, seg); return seg; }
  const h = hash1(i * 0.9137 + 7.7);
  const stormBias = weather.current === "storm" ? 0.11 : 0;
  let type;
  if (h < 0.24 - stormBias) type = null;
  else if (h < 0.42) type = "rock";
  else if (h < 0.53 + stormBias * 0.7) type = "whirlpool";
  else if (h < 0.79) type = "buoy";
  else if (h < 0.90) type = "boost";
  else type = "shield";
  const half = halfWidthAt(wx);
  const cy = centerAt(wx);
  const off = (hash1(i * 5.71 + 1.2) - 0.5) * half * 1.15;
  seg = { type, wx, cy, half, off, collected: false, id: i };
  segments.set(i, seg);
  return seg;
}
function pruneSegments(iStart) {
  for (const key of segments.keys()) if (key < iStart - 40) segments.delete(key);
}

/* ============================== weather ============================== */
const WEATHER_ORDER = ["clear", "cloudy", "storm", "cloudy"];
const weather = {
  idx: 0,
  current: "clear",
  timer: 0,
  duration: 14,
  transition: 1, // 0..1, blends previous->current
  prev: "clear",
};
function weatherDurationFor(kind) {
  if (kind === "clear") return lerp(11, 17, Math.random());
  if (kind === "cloudy") return lerp(8, 13, Math.random());
  return lerp(6, 10, Math.random());
}
function advanceWeather() {
  weather.prev = weather.current;
  weather.idx = (weather.idx + 1) % WEATHER_ORDER.length;
  weather.current = WEATHER_ORDER[weather.idx];
  weather.duration = weatherDurationFor(weather.current);
  weather.timer = 0;
  weather.transition = 0;
}
function updateWeather(dt) {
  weather.timer += dt;
  weather.transition = clamp(weather.transition + dt / 2.4, 0, 1);
  if (weather.timer >= weather.duration) advanceWeather();
}
function weatherBlend() {
  return { from: weather.prev, to: weather.current, t: weather.transition };
}

/* ============================== sky / day cycle ============================== */
const DAY_KEYFRAMES = [
  { t: 0.00, top: [58, 130, 168], bot: [173, 219, 214], sun: [255, 244, 214], glow: 0.25 },
  { t: 0.22, top: [63, 150, 189], bot: [190, 232, 214], sun: [255, 250, 220], glow: 0.18 },
  { t: 0.45, top: [246, 170, 99], bot: [255, 214, 150], sun: [255, 205, 120], glow: 0.55 },
  { t: 0.58, top: [230, 110, 90], bot: [255, 170, 120], sun: [255, 150, 90], glow: 0.75 },
  { t: 0.72, top: [86, 63, 110], bot: [220, 120, 110], sun: [255, 130, 110], glow: 0.6 },
  { t: 0.86, top: [20, 24, 56], bot: [70, 55, 95], sun: [190, 170, 220], glow: 0.3 },
  { t: 1.00, top: [58, 130, 168], bot: [173, 219, 214], sun: [255, 244, 214], glow: 0.25 },
];
const DAY_DURATION = 165;
function skyAt(t) {
  for (let i = 0; i < DAY_KEYFRAMES.length - 1; i++) {
    const a = DAY_KEYFRAMES[i], b = DAY_KEYFRAMES[i + 1];
    if (t >= a.t && t <= b.t) {
      const lt = (t - a.t) / (b.t - a.t);
      return {
        top: mixColor(a.top, b.top, lt),
        bot: mixColor(a.bot, b.bot, lt),
        sun: mixColor(a.sun, b.sun, lt),
        glow: lerp(a.glow, b.glow, lt),
      };
    }
  }
  return DAY_KEYFRAMES[0];
}

/* ============================== particles ============================== */
let particles = [];
function emit(p) { particles.push(Object.assign({ x: 0, y: 0, vx: 0, vy: 0, life: 1, maxLife: 1, size: 3, color: [255, 255, 255], grav: 0, fade: true, shape: "circle" }, p)); }
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += p.grav * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0 || p.x < -60 || p.x > W + 60 || p.y > H + 60) particles.splice(i, 1);
  }
}
function drawParticles() {
  for (const p of particles) {
    const a = p.fade ? clamp(p.life / p.maxLife, 0, 1) : 1;
    ctx.globalAlpha = a;
    ctx.fillStyle = rgb(p.color, 1);
    if (p.shape === "circle") {
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill();
    } else if (p.shape === "rect") {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot || 0);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
      ctx.restore();
    } else if (p.shape === "drop") {
      ctx.fillRect(p.x, p.y, 1.6, p.size);
    }
  }
  ctx.globalAlpha = 1;
}
function emitWake(x, y) {
  for (let i = 0; i < (boostTimer > 0 ? 4 : 2); i++) {
    const side = i % 2 ? 1 : -1;
    emit({ x: x - Math.random() * 8, y: y + side * (5 + Math.random() * 5), vx: -speedAt() * (0.42 + Math.random() * 0.16), vy: side * (8 + Math.random() * 18), life: 0.75, maxLife: 0.75, size: 2 + Math.random() * 3.6, color: boostTimer > 0 ? [255, 230, 150] : [238, 255, 246], grav: 0 });
  }
}
function emitSplash(x, y, color, count) {
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 40 + Math.random() * 90;
    emit({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 30, life: 0.5 + Math.random() * 0.4, maxLife: 0.9, size: 2 + Math.random() * 3, color, grav: 220 });
  }
}
function emitDebris(x, y) {
  for (let i = 0; i < 22; i++) {
    const ang = Math.random() * Math.PI * 2;
    const sp = 60 + Math.random() * 160;
    emit({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 60, life: 0.7 + Math.random() * 0.6, maxLife: 1.3, size: 3 + Math.random() * 4, color: Math.random() > 0.5 ? [120, 78, 42] : [245, 240, 230], grav: 340, shape: Math.random() > 0.5 ? "rect" : "circle", rot: Math.random() * 7 });
  }
}

/* ============================== birds & clouds ============================== */
let birds = [];
let birdTimer = 2;
function updateBirds(dt) {
  birdTimer -= dt;
  if (birdTimer <= 0) {
    birdTimer = 4 + Math.random() * 7;
    const dir = Math.random() > 0.5 ? 1 : -1;
    birds.push({ x: dir > 0 ? -30 : W + 30, y: H * (0.08 + Math.random() * 0.22), vx: dir * (40 + Math.random() * 30), t: Math.random() * 10, scale: 0.7 + Math.random() * 0.6 });
  }
  for (let i = birds.length - 1; i >= 0; i--) {
    const b = birds[i];
    b.x += b.vx * dt; b.t += dt * 6;
    if (b.x < -50 || b.x > W + 50) birds.splice(i, 1);
  }
}
function drawBirds() {
  ctx.strokeStyle = "rgba(30,30,40,0.55)";
  ctx.lineWidth = 2;
  for (const b of birds) {
    const flap = Math.sin(b.t) * 5 * b.scale;
    ctx.beginPath();
    ctx.moveTo(b.x - 7 * b.scale, b.y - flap);
    ctx.quadraticCurveTo(b.x, b.y + flap, b.x + 7 * b.scale, b.y - flap);
    ctx.stroke();
  }
}

let clouds = [];
function initClouds() {
  clouds = [];
  for (let i = 0; i < 6; i++) {
    clouds.push({ x: Math.random() * W, y: H * (0.05 + Math.random() * 0.28), s: 40 + Math.random() * 70, speed: 8 + Math.random() * 10, depth: 0.4 + Math.random() * 0.6 });
  }
}
function updateClouds(dt) { for (const c of clouds) { c.x -= c.speed * dt * (weather.current === "storm" ? 2.4 : 1); if (c.x < -c.s * 2) c.x = W + c.s * 2; } }
function drawClouds(alpha) {
  for (const c of clouds) {
    ctx.globalAlpha = alpha * c.depth * (weather.current === "storm" ? .28 : .1);
    ctx.fillStyle = "rgba(0,35,42,.9)";
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, c.s, c.s * 0.42, 0, 0, Math.PI * 2);
    ctx.ellipse(c.x + c.s * 0.55, c.y + c.s * 0.08, c.s * 0.65, c.s * 0.34, 0, 0, Math.PI * 2);
    ctx.ellipse(c.x - c.s * 0.5, c.y + c.s * 0.1, c.s * 0.55, c.s * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* ============================== boat ============================== */
const boat = {
  screenX: 0,
  y: 0,
  vy: 0,
  tilt: 0,
  bob: 0,
  alive: true,
};
function resetBoat() {
  boat.screenX = Math.round(W * 0.24);
  boat.y = H * 0.5;
  boat.vy = 0;
  boat.tilt = 0;
  boat.bob = 0;
  boat.alive = true;
}

function drawBoat(t) {
  const wobble = Math.sin(t * 8.1) * 1.2;
  const heel = clamp(boat.tilt, -0.48, 0.48);
  ctx.save();
  ctx.translate(boat.screenX, boat.y + wobble);
  ctx.rotate(heel * 0.55);

  // long top-down shadow and engine wake
  ctx.fillStyle = "rgba(0,24,30,.3)";
  ctx.beginPath(); ctx.ellipse(-2, 4, 35, 14, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(236,255,248,.48)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-23, -7); ctx.lineTo(-70, -19 - Math.sin(t * 8) * 2); ctx.moveTo(-23, 7); ctx.lineTo(-70, 19 + Math.sin(t * 8) * 2); ctx.stroke();

  // jet-ski hull: pointed bow, clipped stern, sculpted side panels
  const hull = ctx.createLinearGradient(-28, -18, 28, 18);
  hull.addColorStop(0, "#8f1418"); hull.addColorStop(.45, "#ff3f2e"); hull.addColorStop(1, "#ff7441");
  ctx.fillStyle = hull;
  ctx.beginPath();
  ctx.moveTo(31, 0); ctx.quadraticCurveTo(19, -18, -14, -17); ctx.lineTo(-29, -10);
  ctx.lineTo(-31, 10); ctx.lineTo(-14, 17); ctx.quadraticCurveTo(19, 18, 31, 0); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = "rgba(255,233,202,.8)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(28, 0); ctx.quadraticCurveTo(10, -5, -25, -8); ctx.stroke();

  ctx.fillStyle = "#062c33";
  ctx.beginPath(); ctx.ellipse(-2, 0, 17, 8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#10191d"; ctx.beginPath(); ctx.ellipse(-7, 0, 11, 6, 0, 0, Math.PI * 2); ctx.fill();

  // rider leaning into the carve
  ctx.fillStyle = "#ffd0a8"; ctx.beginPath(); ctx.arc(5, heel * 10, 5.4, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = "#ffd447"; ctx.beginPath(); ctx.ellipse(-2, heel * 8, 9, 6, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#082c33"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(4, -7); ctx.lineTo(13, -12); ctx.moveTo(4, 7); ctx.lineTo(13, 12); ctx.stroke();

  // windshield and handlebar
  ctx.fillStyle = "rgba(172,244,239,.8)"; ctx.beginPath(); ctx.ellipse(18, 0, 7, 9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#061c22"; ctx.lineWidth = 2.2; ctx.beginPath(); ctx.moveTo(12, -12); ctx.lineTo(12, 12); ctx.stroke();

  if (shieldCharges > 0) {
    ctx.strokeStyle = `rgba(143,244,224,${.5 + Math.sin(t * 7) * .18})`; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(0, 0, 43, 28, 0, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.restore();
}

/* ============================== hazards / collectibles render + collide ============================== */
const boatR = 18, collisionPad = 3;
let comboMultiplier = 1;
let comboTimerSinceLast = 0;

function typeColor(type) {
  switch (type) {
    case "buoy": return [255, 212, 71];
    case "boost": return [255, 77, 53];
    case "shield": return [143, 244, 224];
    default: return [255, 255, 255];
  }
}

function drawEntity(seg, sx, sy, t) {
  const meta = {
    rock: { emoji: "🪨", good: false },
    whirlpool: { emoji: "💣", good: false },
    buoy: { emoji: "🪙", good: true },
    boost: { emoji: "⚡", good: true },
    shield: { emoji: "🛡️", good: true },
  }[seg.type];
  if (!meta) return;

  const bob = Math.sin(t * 4 + seg.id) * 3;
  const pulse = 1 + Math.sin(t * 5 + seg.id) * .055;
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.filter = "none";
  ctx.translate(sx, sy + bob);
  ctx.scale(pulse, pulse);

  const halo = meta.good ? "rgba(10,96,72,.94)" : "rgba(103,25,23,.94)";
  const ring = meta.good ? "rgba(161,255,191,1)" : "rgba(255,91,71,1)";
  ctx.shadowColor = meta.good ? "rgba(96,255,165,.55)" : "rgba(255,62,48,.55)";
  ctx.shadowBlur = 14;
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(0, 0, 31, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = ring;
  ctx.lineWidth = meta.good ? 2 : 3;
  ctx.setLineDash(meta.good ? [] : [5, 4]);
  ctx.beginPath(); ctx.arc(0, 0, 27, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;

  // Color emoji have inconsistent advance boxes across browsers. Center from the
  // painted glyph bounds instead of trusting textAlign, which offset the shield.
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = '40px "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
  const glyphMetrics = ctx.measureText(meta.emoji);
  const glyphLeft = Number.isFinite(glyphMetrics.actualBoundingBoxLeft) ? glyphMetrics.actualBoundingBoxLeft : 0;
  const glyphRight = Number.isFinite(glyphMetrics.actualBoundingBoxRight) ? glyphMetrics.actualBoundingBoxRight : glyphMetrics.width;
  const glyphAscent = Number.isFinite(glyphMetrics.actualBoundingBoxAscent) ? glyphMetrics.actualBoundingBoxAscent : 30;
  const glyphDescent = Number.isFinite(glyphMetrics.actualBoundingBoxDescent) ? glyphMetrics.actualBoundingBoxDescent : 8;
  ctx.fillText(meta.emoji, (glyphLeft - glyphRight) / 2, (glyphAscent - glyphDescent) / 2);
  ctx.restore();
}

/* ============================== game state ============================== */
let scrollX = 0;
let survivedTime = 0;
let score = 0;
let counts = { buoy: 0, boost: 0, shield: 0 };
let save = loadSave();
let state = "start";
let hintShown = false;
let cameraShake = 0;
let lightning = 0;
let boostTimer = 0;
let shieldCharges = 0;
let steerTargetY = 0;
let dragging = false;
let keyboardDir = 0;

const els = {
  hud: document.getElementById("hud"),
  scoreValue: document.getElementById("scoreValue"),
  multBadge: document.getElementById("multBadge"),
  bestValue: document.getElementById("bestValue"),
  hudHint: document.getElementById("hudHint"),
  boostStatus: document.getElementById("boostStatus"),
  shieldStatus: document.getElementById("shieldStatus"),
  comboFlash: document.getElementById("comboFlash"),
  startScreen: document.getElementById("startScreen"),
  pauseScreen: document.getElementById("pauseScreen"),
  gameOverScreen: document.getElementById("gameOverScreen"),
  playBtn: document.getElementById("playBtn"),
  resumeBtn: document.getElementById("resumeBtn"),
  restartFromPauseBtn: document.getElementById("restartFromPauseBtn"),
  quitBtn: document.getElementById("quitBtn"),
  pauseBtn: document.getElementById("pauseBtn"),
  playAgainBtn: document.getElementById("playAgainBtn"),
  shareBtn: document.getElementById("shareBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  copyFeedback: document.getElementById("copyFeedback"),
  bestStrip: document.getElementById("bestStrip"),
  bestScoreStart: document.getElementById("bestScoreStart"),
  bestRunsStart: document.getElementById("bestRunsStart"),
  finalScore: document.getElementById("finalScore"),
  finalDistance: document.getElementById("finalDistance"),
  finalMult: document.getElementById("finalMult"),
  finalPassengers: document.getElementById("finalPassengers"),
  newBestStamp: document.getElementById("newBestStamp"),
  wreckLine: document.getElementById("wreckLine"),
  scoreCardCanvas: document.getElementById("scoreCardCanvas"),
  orientationNote: document.getElementById("orientationNote"),
  dismissOrientation: document.getElementById("dismissOrientation"),
};

function refreshStartBest() {
  if (save.bestScore > 0) {
    els.bestStrip.hidden = false;
    els.bestScoreStart.textContent = Math.floor(save.bestScore).toLocaleString();
    els.bestRunsStart.textContent = save.totalVoyages;
  }
  els.bestValue.textContent = Math.floor(save.bestScore).toLocaleString();
}

function resetRun() {
  scrollX = 0;
  survivedTime = 0;
  score = 0;
  counts = { buoy: 0, boost: 0, shield: 0 };
  comboMultiplier = 1;
  comboTimerSinceLast = 0;
  particles = [];
  segments.clear();
  resetBoat();
  steerTargetY = boat.y;
  dragging = false;
  keyboardDir = 0;
  weather.current = "clear"; weather.idx = 0; weather.timer = 0; weather.duration = weatherDurationFor("clear"); weather.transition = 1; weather.prev = "clear";
  hintShown = false;
  els.hudHint.classList.remove("faded");
  els.scoreValue.textContent = "0";
  els.multBadge.textContent = "×1";
  cameraShake = 0;
  boostTimer = 0;
  shieldCharges = 0;
  els.boostStatus.classList.remove("active");
  els.shieldStatus.classList.remove("active");
}

function setState(next) {
  state = next;
  els.hud.classList.toggle("hidden", state !== "playing" && state !== "paused");
  els.startScreen.classList.toggle("hidden", state !== "start");
  els.pauseScreen.classList.toggle("hidden", state !== "paused");
  els.gameOverScreen.classList.toggle("hidden", state !== "gameover");
}

/* ============================== input ============================== */
function revealSteering() {
  if (!hintShown) { hintShown = true; els.hudHint.classList.add("faded"); }
}
function steerTo(clientY) {
  steerTargetY = clamp(clientY, boatR + 8, H - boatR - 8);
  revealSteering();
}
canvas.addEventListener("pointerdown", (e) => {
  if (state !== "playing") return;
  dragging = true;
  steerTo(e.clientY);
  try { canvas.setPointerCapture(e.pointerId); } catch { /* optional */ }
});
canvas.addEventListener("pointermove", (e) => { if (state === "playing" && dragging) steerTo(e.clientY); });
window.addEventListener("pointerup", () => { dragging = false; });
window.addEventListener("pointercancel", () => { dragging = false; });
window.addEventListener("blur", () => { dragging = false; keyboardDir = 0; });
window.addEventListener("keydown", (e) => {
  if (["ArrowUp", "KeyW"].includes(e.code)) { e.preventDefault(); if (state === "playing") { keyboardDir = -1; revealSteering(); } }
  if (["ArrowDown", "KeyS"].includes(e.code)) { e.preventDefault(); if (state === "playing") { keyboardDir = 1; revealSteering(); } }
  if (e.code === "Escape" || e.code === "KeyP") { if (state === "playing") pauseGame(); else if (state === "paused") resumeGame(); }
});
window.addEventListener("keyup", (e) => { if (["ArrowUp", "KeyW", "ArrowDown", "KeyS"].includes(e.code)) keyboardDir = 0; });
document.addEventListener("visibilitychange", () => { if (document.hidden && state === "playing") pauseGame(); });

function pauseGame() { if (state !== "playing") return; setState("paused"); dragging = false; keyboardDir = 0; }
function resumeGame() { if (state !== "paused") return; setState("playing"); }

els.pauseBtn.addEventListener("click", pauseGame);
els.resumeBtn.addEventListener("click", resumeGame);
els.quitBtn.addEventListener("click", () => { setState("start"); refreshStartBest(); });
els.restartFromPauseBtn.addEventListener("click", startGame);
els.playBtn.addEventListener("click", startGame);
els.playAgainBtn.addEventListener("click", startGame);

function startGame() {
  resetRun();
  setState("playing");
}

/* ============================== collision + scoring update ============================== */
function crash(cx, cy) {
  if (shieldCharges > 0) {
    shieldCharges = 0;
    els.shieldStatus.classList.remove("active");
    cameraShake = 7;
    boat.vy = 0;
    steerTargetY = boat.y;
    emitSplash(cx, cy, [143, 244, 224], 28);
    return;
  }
  boat.alive = false;
  cameraShake = 18;
  emitDebris(cx, cy);
  endRun();
}

function collectPickup(seg, sx, sy) {
  seg.collected = true;
  const color = typeColor(seg.type);
  emitSplash(sx, sy, color, 16);
  let pts = 0;
  if (seg.type === "buoy") { pts = 25; counts.buoy++; bumpCombo(); }
  else if (seg.type === "boost") {
    pts = 15; counts.boost++; boostTimer = Math.min(8, boostTimer + 4.5);
    els.boostStatus.classList.add("active");
  }
  else if (seg.type === "shield") {
    pts = 35; counts.shield++; shieldCharges = 1;
    els.shieldStatus.classList.add("active");
  }
  score += pts * comboMultiplier;
}

function bumpCombo() {
  comboMultiplier = Math.min(9, comboMultiplier + 1);
  comboTimerSinceLast = 0;
  els.comboFlash.textContent = comboMultiplier === 2 ? "RACING LINE" : `×${comboMultiplier} FLOW`;
  els.comboFlash.classList.remove("show"); void els.comboFlash.offsetWidth; els.comboFlash.classList.add("show");
  els.multBadge.classList.remove("pulse"); void els.multBadge.offsetWidth; els.multBadge.classList.add("pulse");
}

function updateGameplay(dt) {
  updateWeather(dt);
  updateClouds(dt);
  updateBirds(dt);

  const speed = speedAt();
  scrollX += speed * dt;
  survivedTime += dt;
  boostTimer = Math.max(0, boostTimer - dt);
  if (boostTimer <= 0) els.boostStatus.classList.remove("active");
  else els.boostStatus.textContent = `BOOST ${boostTimer.toFixed(1)}`;

  lightning = Math.max(0, lightning - dt * 2.2);
  if (weather.current === "storm" && Math.random() < dt * 0.35) lightning = 1;

  // Direct line steering: tap/drag selects a lane; releasing holds that line.
  // Keyboard input applies the same deliberate motion with no gravity or idle drift.
  const lineError = steerTargetY - boat.y;
  const targetVy = keyboardDir !== 0 ? keyboardDir * 255 : (Math.abs(lineError) < 1.5 ? 0 : clamp(lineError * 4.2, -255, 255));
  boat.vy = lerp(boat.vy, targetVy, 1 - Math.exp(-dt * 8));
  boat.y += boat.vy * dt;
  boat.tilt = lerp(boat.tilt, clamp(boat.vy / 420, -0.5, 0.5), 1 - Math.exp(-dt * 7));

  if (Math.random() < dt * 40) emitWake(boat.screenX - 16, boat.y + 8);

  const bx = scrollX + boat.screenX;
  const half = halfWidthAt(bx);
  const cy = centerAt(bx);
  const top = cy - half, bottom = cy + half;

  if (boat.y - boatR + collisionPad < top || boat.y + boatR - collisionPad > bottom) {
    const absorbed = shieldCharges > 0;
    crash(boat.screenX, boat.y);
    if (absorbed) boat.y = clamp(boat.y, top + boatR + 4, bottom - boatR - 4);
    return;
  }
  if (boat.y < boatR + collisionPad) { boat.y = boatR + collisionPad; boat.vy = Math.max(boat.vy, 0); }
  if (boat.y > H - boatR - collisionPad) { boat.y = H - boatR - collisionPad; boat.vy = Math.min(boat.vy, 0); }

  comboTimerSinceLast += dt;
  if (comboTimerSinceLast > 4.2 && comboMultiplier > 1) { comboMultiplier--; comboTimerSinceLast = 0; }

  const iStart = Math.floor((scrollX - 200) / SEG_LEN);
  const iEnd = Math.floor((scrollX + W + 400) / SEG_LEN);
  for (let i = iStart; i <= iEnd; i++) {
    const seg = getSegment(i);
    if (!seg.type || seg.collected) continue;
    const sx = seg.wx - scrollX, sy = seg.cy + seg.off;
    const dx = sx - boat.screenX, dy = sy - boat.y;
    const dist = Math.hypot(dx, dy);
    if (seg.type === "rock") {
      if (dist < boatR + 13) { if (shieldCharges > 0) seg.collected = true; crash(boat.screenX, boat.y); return; }
    } else if (seg.type === "whirlpool") {
      if (dist < boatR + 10) { if (shieldCharges > 0) seg.collected = true; crash(boat.screenX, boat.y); return; }
    } else {
      if (dist < boatR + 14) collectPickup(seg, sx, sy);
    }
  }
  pruneSegments(iStart);

  score += speed * dt * 0.045 * comboMultiplier;
  els.scoreValue.textContent = Math.floor(score).toLocaleString();
  els.multBadge.textContent = `×${comboMultiplier}`;
}

function endRun() {
  const dayT = (survivedTime % DAY_DURATION) / DAY_DURATION;
  const sky = skyAt(dayT);
  const isBest = score > save.bestScore;
  save.bestScore = Math.max(save.bestScore, score);
  save.bestDistance = Math.max(save.bestDistance, scrollX);
  save.bestMultiplier = Math.max(save.bestMultiplier, comboMultiplier);
  save.totalVoyages += 1;
  save.totalPassengers += counts.shield;
  saveSave(save);

  els.finalScore.textContent = Math.floor(score).toLocaleString();
  els.finalDistance.textContent = Math.floor(scrollX / 42).toLocaleString();
  els.finalMult.textContent = `×${comboMultiplier}`;
  els.finalPassengers.textContent = counts.shield;
  els.newBestStamp.hidden = !isBest;
  els.wreckLine.textContent = isBest ? "New lagoon record" : "Run complete";

  drawScoreCard(sky, isBest);
  els.copyFeedback.textContent = "";
  setState("gameover");
}

/* ============================== rendering ============================== */
function drawScene(t, dt) {
  const dayT = (survivedTime % DAY_DURATION) / DAY_DURATION;
  const sky = skyAt(dayT);
  const stormMix = weather.current === "storm" ? weather.transition : (weather.prev === "storm" ? 1 - weather.transition : 0);
  const cloudyMix = (weather.current === "cloudy" ? weather.transition : 0) + (weather.prev === "cloudy" ? 1 - weather.transition : 0);
  const dim = clamp(stormMix * 0.55 + cloudyMix * 0.18, 0, 0.6);

  const top = mixColor(sky.top, [70, 78, 90], dim);
  const bot = mixColor(sky.bot, [110, 118, 128], dim * 0.7);

  ctx.save();
  if (cameraShake > 0.4) {
    ctx.translate((Math.random() - 0.5) * cameraShake, (Math.random() - 0.5) * cameraShake);
    cameraShake *= 0.88;
  } else cameraShake = 0;

  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, rgb(top)); g.addColorStop(1, rgb(bot));
  ctx.fillStyle = g;
  ctx.fillRect(-20, -20, W + 40, H + 40);

  const sunY = H * 0.22 + Math.sin(dayT * Math.PI * 2) * H * 0.02;
  const sunAlpha = clamp(sky.glow * (1 - stormMix * 0.85), 0, 1);
  const sg = ctx.createRadialGradient(W * 0.78, sunY, 4, W * 0.78, sunY, H * 0.5);
  sg.addColorStop(0, rgb(sky.sun, sunAlpha));
  sg.addColorStop(1, rgb(sky.sun, 0));
  ctx.fillStyle = sg;
  ctx.fillRect(-20, -20, W + 40, H + 40);
  ctx.fillStyle = rgb(sky.sun, sunAlpha * 0.9);
  ctx.beginPath(); ctx.arc(W * 0.78, sunY, 26, 0, Math.PI * 2); ctx.fill();

  const nightAmt = clamp(1 - Math.abs(dayT - 0.9) / 0.09, 0, 1);
  if (nightAmt > 0.02) {
    ctx.fillStyle = `rgba(255,255,255,${0.7 * nightAmt})`;
    for (let i = 0; i < 60; i++) {
      const sx = hash1(i * 12.9) * W;
      const sy = hash1(i * 44.7) * H * 0.5;
      const tw = 0.5 + 0.5 * Math.sin(t * 2 + i);
      ctx.globalAlpha = nightAmt * (0.35 + 0.5 * tw);
      ctx.beginPath(); ctx.arc(sx, sy, 1.1 + (i % 3) * 0.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawWaterAndTerrain(t, dim);

  // Overhead life and cloud shadows tie the entire canvas to the top-down camera.
  drawClouds(1 + stormMix);
  drawBirds();

  drawParticles();

  if (weather.current === "storm" || weather.prev === "storm") {
    const rainAlpha = stormMix;
    if (rainAlpha > 0.02) {
      ctx.strokeStyle = `rgba(210,225,230,${0.25 * rainAlpha})`;
      ctx.lineWidth = 1.4;
      const n = Math.floor(70 * rainAlpha);
      for (let i = 0; i < n; i++) {
        const rx = (hash1(i * 91.7 + Math.floor(t * 12)) * (W + 200)) - 100;
        const ry = (hash1(i * 33.1 + Math.floor(t * 12)) * H);
        ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 10, ry + 22); ctx.stroke();
      }
    }
    if (lightning > 0) { ctx.fillStyle = `rgba(255,255,255,${lightning * 0.35})`; ctx.fillRect(-20, -20, W + 40, H + 40); }
  }

  if (boat.alive) drawBoat(t);

  const vg = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.9);
  vg.addColorStop(0, "rgba(0,0,0,0)"); vg.addColorStop(1, `rgba(2,10,14,${0.28 + dim * 0.25})`);
  ctx.fillStyle = vg;
  ctx.fillRect(-20, -20, W + 40, H + 40);

  ctx.restore();
}

function drawWaterAndTerrain(t, dim) {
  const step = 8;

  // deep-water base, richer multi-stop gradient for a sense of depth
  const wTop = mixColor([46, 168, 178], [70, 90, 98], dim);
  const wMid = mixColor([21, 122, 143], [50, 65, 72], dim);
  const wBot = mixColor([5, 46, 60], [12, 22, 30], dim);
  const wg = ctx.createLinearGradient(0, 0, 0, H);
  wg.addColorStop(0, rgb(wTop));
  wg.addColorStop(0.55, rgb(wMid));
  wg.addColorStop(1, rgb(wBot));
  ctx.fillStyle = wg;
  ctx.fillRect(0, 0, W, H);

  // Sun flecks and current lines move at different depths, giving the lagoon parallax.
  ctx.lineCap = "round";
  for (let i = 0; i < 42; i++) {
    const wx = Math.floor(scrollX * .45) + i * 137;
    const x = ((wx - scrollX * .45) % (W + 180)) - 90;
    const y = hash1(i * 5.91 + Math.floor(scrollX / 900)) * H;
    const len = 12 + hash1(i * 9.2) * 38;
    ctx.strokeStyle = rgb(mixColor([225, 255, 239], [170, 190, 196], dim), .09 + hash1(i) * .13);
    ctx.lineWidth = 1 + hash1(i * 2.4) * 1.4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + len * .5, y - 3, x + len, y); ctx.stroke();
  }
  ctx.lineCap = "butt";
  ctx.globalAlpha = 1;

  // build terrain silhouettes
  const topPts = [], botPts = [];
  for (let x = -step; x <= W + step; x += step) {
    const wx = scrollX + x;
    const cy = centerAt(wx), half = halfWidthAt(wx);
    topPts.push([x, cy - half]);
    botPts.push([x, cy + half]);
  }

  drawIslandMass(topPts, -1, t, dim, 0);
  drawIslandMass(botPts, 1, t, dim, H);

  const iStart = Math.floor((scrollX - 200) / SEG_LEN);
  const iEnd = Math.floor((scrollX + W + 400) / SEG_LEN);
  for (let i = iStart; i <= iEnd; i++) {
    const seg = getSegment(i);
    if (!seg.type || seg.collected) continue;
    drawEntity(seg, seg.wx - scrollX, seg.cy + seg.off, t);
  }
}

function fillBand(ctx2, innerPts, outerPts, color) {
  ctx2.fillStyle = color;
  ctx2.beginPath();
  ctx2.moveTo(innerPts[0][0], innerPts[0][1]);
  for (const [x, y] of innerPts) ctx2.lineTo(x, y);
  for (let i = outerPts.length - 1; i >= 0; i--) ctx2.lineTo(outerPts[i][0], outerPts[i][1]);
  ctx2.closePath();
  ctx2.fill();
}

function drawIslandMass(pts, dir, t, dim, screenEdgeY) {
  const step = pts[1][0] - pts[0][0];
  const sandPts = pts.map(([x, y]) => {
    const wx = scrollX + x;
    const cove = Math.max(0, Math.sin(wx * .0048 + (dir < 0 ? .8 : 3.1))) ** 4;
    const beachW = 10 + cove * 34 + hash1(Math.floor(wx / 240) + (dir < 0 ? 10 : 90)) * 5;
    return [x, y + dir * beachW];
  });

  // luminous turquoise shallows make the course edge legible without a hard wall
  const shelfPts = pts.map(([x, y]) => [x, y - dir * 34]);
  fillBand(ctx, shelfPts, pts, rgb(mixColor([73, 222, 196], [95, 119, 121], dim), .34));
  const innerShelfPts = pts.map(([x, y]) => [x, y - dir * 13]);
  fillBand(ctx, innerShelfPts, pts, rgb(mixColor([142, 245, 211], [130, 150, 148], dim), .22));

  // reef shelf glow just beneath the surface, outside the safe channel edge
  ctx.fillStyle = rgb(mixColor([205, 255, 231], [140, 150, 155], dim), 0.3);
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1] - dir * 22);
  for (const [x, y] of pts) ctx.lineTo(x, y - dir * 22);
  for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i][0], pts[i][1] + dir * 4);
  ctx.closePath(); ctx.fill();

  // sand fringe
  fillBand(ctx, pts, sandPts, rgb(mixColor([255, 224, 154], [160, 158, 152], dim)));

  // Sun-warmed stipple makes the wider coves feel like actual beaches.
  for (let i = 2; i < pts.length; i += 6) {
    const [x, waterY] = pts[i]; const sandY = sandPts[i][1];
    if (Math.abs(sandY - waterY) < 18) continue;
    ctx.fillStyle = rgb(mixColor([255, 244, 188], [186, 180, 165], dim), .48);
    for (let k = 0; k < 3; k++) {
      const f = .28 + k * .19; ctx.beginPath(); ctx.arc(x + (k - 1) * 5, lerp(waterY, sandY, f), 1.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  // jungle interior
  const jungle = ctx.createLinearGradient(0, dir < 0 ? 0 : H, 0, dir < 0 ? H * .35 : H * .65);
  jungle.addColorStop(0, rgb(mixColor([15, 75, 53], [55, 65, 61], dim)));
  jungle.addColorStop(1, rgb(mixColor([42, 145, 79], [72, 82, 72], dim)));
  ctx.fillStyle = jungle;
  ctx.beginPath();
  ctx.moveTo(-step, screenEdgeY);
  for (const [x, y] of sandPts) ctx.lineTo(x, y);
  ctx.lineTo(pts[pts.length - 1][0] + step, screenEdgeY);
  ctx.closePath(); ctx.fill();

  // interior shading band for depth
  ctx.fillStyle = rgb(mixColor([36, 94, 46], [55, 62, 55], dim), 0.55);
  const shadowPts = sandPts.map(([x, y]) => [x, y + dir * 20]);
  fillBand(ctx, sandPts, shadowPts, rgb(mixColor([36, 94, 46], [55, 62, 55], dim), 0.5));

  drawFoliage(pts, dir, t, dim);
}

function drawFoliage(pts, dir, t, dim) {
  const reefColor = rgb(mixColor([255, 236, 214], [200, 200, 198], dim), 0.55);
  ctx.fillStyle = reefColor;
  for (let i = 0; i < pts.length; i += 3) {
    const [x, y] = pts[i];
    ctx.beginPath(); ctx.ellipse(x, y - dir * 2, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
  }
  for (let i = 0; i < pts.length; i += 5) {
    const [x, y] = pts[i];
    const h = hash1(Math.floor((scrollX + x) / 40) * 7.13 + (dir < 0 ? 0 : 500));
    if (h > 0.67) drawPalm(x, y + dir * 26, dir, h, dim);
    else if (h > 0.48) drawBush(x, y + dir * 15, dir, h, dim);
  }
  // bright coral patches and sandbar stones break up the repeated shoreline.
  for (let i = 2; i < pts.length; i += 11) {
    const [x,y] = pts[i];
    const seed = hash1(Math.floor((scrollX + x) / 70) * 3.31 + (dir < 0 ? 71 : 191));
    if (seed > .48) {
      ctx.fillStyle = seed > .77 ? rgb(mixColor([255,108,91],[130,125,125],dim),.7) : rgb(mixColor([255,218,102],[150,145,128],dim),.64);
      for(let k=0;k<3;k++){ctx.beginPath();ctx.arc(x+(k-1)*5,y+dir*(6+k%2*3),2.5+k*.5,0,Math.PI*2);ctx.fill();}
    }
  }
}
function drawBush(x, y, dir, h, dim) {
  ctx.fillStyle = rgb(mixColor([70, 150, 76], [76, 88, 78], dim));
  for (let k = 0; k < 3; k++) {
    ctx.beginPath();
    ctx.ellipse(x + (k - 1) * 6, y - Math.abs(k - 1) * 2, 8, 7, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}
function drawPalm(x, y, dir, h, dim) {
  // Top-down canopy: every palm shares the same camera orientation on both shores.
  const size = 11 + h * 5;
  ctx.fillStyle = "rgba(0,35,28,.2)";
  ctx.beginPath(); ctx.ellipse(x + 4, y + 6, size + 3, size * .68, .2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = rgb(mixColor([39, 157, 83], [65, 78, 68], dim));
  for (let k = 0; k < 7; k++) {
    const ang = (k / 7) * Math.PI * 2 + h;
    const cx = x + Math.cos(ang) * size * .48;
    const cy = y + Math.sin(ang) * size * .48;
    ctx.beginPath(); ctx.ellipse(cx, cy, size * .72, 3.6, ang, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = rgb(mixColor([121, 80, 39], [84, 82, 72], dim));
  ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = rgb(mixColor([119, 173, 59], [78, 90, 70], dim));
  ctx.beginPath(); ctx.arc(x - 3, y + 2, 2, 0, Math.PI * 2); ctx.arc(x + 3, y + 1, 2, 0, Math.PI * 2); ctx.fill();
}

/* ============================== score card ============================== */
function drawScoreCard(sky, isBest) {
  const c = els.scoreCardCanvas;
  const cctx = c.getContext("2d");
  const w = c.width, h = c.height;
  const g = cctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, rgb(sky.top)); g.addColorStop(1, rgb(sky.bot));
  cctx.fillStyle = g; cctx.fillRect(0, 0, w, h);

  cctx.fillStyle = rgb(sky.sun, sky.glow);
  cctx.beginPath(); cctx.arc(w * 0.78, h * 0.28, 200, 0, Math.PI * 2); cctx.fill();

  cctx.fillStyle = "rgba(8,40,50,0.55)";
  cctx.beginPath();
  cctx.moveTo(0, h * 0.62);
  for (let x = 0; x <= w; x += 20) cctx.lineTo(x, h * 0.62 + Math.sin(x * 0.02) * 10);
  cctx.lineTo(w, h); cctx.lineTo(0, h); cctx.closePath(); cctx.fill();

  cctx.fillStyle = "rgba(4,20,26,0.42)";
  cctx.fillRect(0, 0, w, h);

  cctx.textAlign = "center";
  cctx.fillStyle = "#f2b632";
  cctx.font = "italic 700 26px Fraunces, serif";
  cctx.fillText("REEF RUNNER", w / 2, 56);

  cctx.fillStyle = "#f5ecdc";
  cctx.font = "900 84px 'JetBrains Mono', monospace";
  cctx.fillText(Math.floor(score).toLocaleString(), w / 2, 160);

  cctx.font = "600 16px 'Bricolage Grotesque', sans-serif";
  cctx.fillStyle = "#d9cdb4";
  cctx.fillText("POINTS", w / 2, 186);

  const statY = 250;
  const stats = [
    [`${Math.floor(scrollX / 42).toLocaleString()}`, "REEF MILES"],
    [`×${comboMultiplier}`, "FLOW"],
    [`${counts.shield}`, "SHELLS"],
  ];
  const colW = w / stats.length;
  stats.forEach((s, i) => {
    const cx = colW * i + colW / 2;
    cctx.font = "700 30px 'JetBrains Mono', monospace";
    cctx.fillStyle = "#f5ecdc";
    cctx.fillText(s[0], cx, statY);
    cctx.font = "600 13px 'Bricolage Grotesque', sans-serif";
    cctx.fillStyle = "#d9cdb4";
    cctx.fillText(s[1], cx, statY + 22);
  });

  if (isBest) {
    cctx.save();
    cctx.translate(w - 76, 70);
    cctx.rotate(0.22);
    cctx.strokeStyle = "#ff6f5e"; cctx.lineWidth = 4;
    cctx.beginPath(); cctx.arc(0, 0, 46, 0, Math.PI * 2); cctx.stroke();
    cctx.fillStyle = "#ff6f5e";
    cctx.font = "italic 700 15px Fraunces, serif";
    cctx.fillText("NEW", 0, -3);
    cctx.fillText("BEST", 0, 14);
    cctx.restore();
  }

  cctx.font = "600 13px 'Bricolage Grotesque', sans-serif";
  cctx.fillStyle = "rgba(245,236,220,0.6)";
  const d = new Date();
  cctx.fillText(`${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} · reefrunner`, w / 2, h - 20);
}

async function shareCard() {
  const c = els.scoreCardCanvas;
  c.toBlob(async (blob) => {
    if (!blob) return;
    const file = new File([blob], "reef-runner-score.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Reef Runner", text: `I scored ${Math.floor(score).toLocaleString()} in Reef Runner!` }); return; } catch { /* cancelled */ return; }
    }
    if (navigator.clipboard && window.ClipboardItem) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        els.copyFeedback.textContent = "Copied to clipboard!";
        return;
      } catch { /* fall through */ }
    }
    downloadCard();
  }, "image/png");
}
function downloadCard() {
  const url = els.scoreCardCanvas.toDataURL("image/png");
  const a = document.createElement("a");
  a.href = url; a.download = "reef-runner-score.png";
  document.body.appendChild(a); a.click(); a.remove();
  els.copyFeedback.textContent = "Saved!";
}
els.shareBtn.addEventListener("click", shareCard);
els.downloadBtn.addEventListener("click", downloadCard);

/* ============================== orientation note ============================== */
(function initOrientationNote() {
  try {
    if (localStorage.getItem("reefRunner.orientationDismissed")) return;
  } catch { /* ignore */ }
  if (window.innerWidth < window.innerHeight && window.innerWidth < 380) {
    els.orientationNote.classList.remove("hidden");
  }
  els.dismissOrientation.addEventListener("click", () => {
    els.orientationNote.classList.add("hidden");
    try { localStorage.setItem("reefRunner.orientationDismissed", "1"); } catch { /* ignore */ }
  });
})();

/* ============================== main loop ============================== */
initClouds();
resetBoat();
refreshStartBest();
setState("start");

let lastT = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - lastT) / 1000);
  lastT = now;
  const t = now / 1000;

  if (state === "playing") {
    updateGameplay(dt);
    updateParticles(dt);
  } else if (state === "start") {
    updateWeather(dt);
    updateClouds(dt);
    updateBirds(dt);
    updateParticles(dt);
  }

  if (state !== "paused" && state !== "gameover") drawScene(t, dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

})();
