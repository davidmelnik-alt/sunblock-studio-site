/* ════════════════════════════════════════════════════════════
   SUNBLOCK STUDIO — SOLAR CINEMA ENGINE
   Two fixed canvases render one continuous generative film.
   Scroll position is the playhead. Zero dependencies.
   ════════════════════════════════════════════════════════════ */

(() => {
"use strict";

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp  = (a, b, t) => a + (b - a) * t;
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
// bell(p): 0→1→0 across a progress range
const bell = (p, inEnd = .25, outStart = .75) =>
  smooth(p / inEnd) * (1 - smooth((p - outStart) / (1 - outStart)));

/* ── scroll state (eased playhead) ─────────────────────────── */
let scrollY = window.scrollY, eased = scrollY;
let vw = innerWidth, vh = innerHeight;
addEventListener("scroll", () => { scrollY = window.scrollY; }, { passive: true });

/* ── scene registry: progress 0..1 through each pinned scene ── */
const scenes = {};
document.querySelectorAll("[data-scene]").forEach(el => {
  scenes[el.dataset.scene] = { el, p: 0, vis: 0 };
});
function measure() {
  vw = innerWidth; vh = innerHeight;
  for (const k in scenes) {
    const s = scenes[k], r = s.el.getBoundingClientRect();
    s.top = r.top + window.scrollY;
    s.h = s.el.offsetHeight;
  }
}
function updateProgress() {
  for (const k in scenes) {
    const s = scenes[k];
    const span = Math.max(1, s.h - vh);
    s.p = clamp((eased - s.top) / span, 0, 1);                       // pin progress
    s.vis = clamp((eased + vh - s.top) / (s.h + vh), 0, 1);          // viewport visibility
    s.on = eased + vh > s.top && eased < s.top + s.h;
  }
}

/* ════════════════════════════════════════════════════════════
   LAYER 1 — WebGL : the sun, nebula, stars
   ════════════════════════════════════════════════════════════ */
const glCanvas = document.getElementById("gl");
let gl = null, prog = null, uni = {};

const VERT = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;
const FRAG = `
precision highp float;
uniform vec2  uRes;
uniform float uTime;
uniform vec2  uSunPos;   // centered coords, y up
uniform float uSunR;
uniform float uBreak;    // 0 calm → 1 disintegrating corona
uniform float uHue;      // 0 solar gold → 1 electric aqua
uniform float uNebula;
uniform float uDim;      // master brightness

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){
  float v = 0., a = .5;
  for (int i = 0; i < 5; i++){ v += a * noise(p); p = p * 2.03 + 17.1; a *= .5; }
  return v;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - .5 * uRes) / uRes.y;
  float t = uTime;

  // deep space base
  vec3 col = vec3(.016, .010, .026);
  col += vec3(.03, .012, .05) * (1. - length(uv) * .9);

  // nebula drift
  float neb = fbm(uv * 1.9 + vec2(t * .016, -t * .011));
  neb = pow(neb, 2.2);
  vec3 nebWarm = vec3(.30, .10, .05);
  vec3 nebCool = vec3(.02, .22, .26);
  col += mix(nebWarm, nebCool, uHue) * neb * uNebula;

  // star field (two parallax layers)
  for (int l = 0; l < 2; l++){
    float fl = float(l);
    vec2 sp = uv * (14. + fl * 9.) + vec2(fl * 7.3, uTime * .004 * (fl + 1.));
    vec2 cell = floor(sp);
    float h = hash(cell);
    if (h > .92){
      vec2 c = fract(sp) - .5;
      float star = exp(-dot(c, c) * 320.);
      float tw = .55 + .45 * sin(t * (1. + h * 3.) + h * 40.);
      col += vec3(.9, .85, .8) * star * tw * .3;
    }
  }

  // ─ the sun ─
  vec2 p = uv - uSunPos;
  float d = length(p);
  float ang = atan(p.y, p.x);

  // boiling limb — wobbles harder as uBreak rises
  float wob = fbm(vec2(ang * 2.4 + 9., t * .22)) - .5;
  float r = uSunR * (1. + wob * (.05 + uBreak * .14));
  float rr = max(r, .04); // falloff reference

  vec3 coreWarm = vec3(1.0, .92, .72);
  vec3 bodyWarm = vec3(1.0, .58, .22);
  vec3 coreCool = vec3(.82, 1.0, .97);
  vec3 bodyCool = vec3(.12, .85, .80);
  vec3 core = mix(coreWarm, coreCool, uHue);
  vec3 body = mix(bodyWarm, bodyCool, uHue);

  // outer glow / corona — falloff scaled to the sun's size
  float out_ = max(d - r, 0.);
  float glow = exp(-out_ / (rr * .45));
  float flame = fbm(vec2(ang * 3., t * .35 + d * 3.)) * exp(-out_ / (rr * (.22 + uBreak * .5)));
  col += body * glow * .55;
  col += mix(body, core, .5) * flame * (.5 + uBreak * .8);

  // disc: bright surface, limb darkening, granulation; fine fissures as it breaks
  float disc = smoothstep(r, r - .008, d);
  if (disc > 0.){
    vec2 q = p / rr; // local sun coords, size-independent detail
    float gran = fbm(q * 3.2 + t * .12);
    vec3 surf = mix(body, core, smoothstep(1., 0., d / rr) * .8 + gran * .3);
    float crack = 1. - uBreak * .28 * smoothstep(.5, .64, fbm(q * 6.5 + t * .07));
    col = mix(col, surf * crack + core * .08, disc);
  }

  // vignette + master dim
  col *= 1. - dot(uv, uv) * .55;
  col *= uDim;

  // gentle tone map
  col = col / (1. + col * .35);
  gl_FragColor = vec4(col, 1.);
}`;

function initGL() {
  gl = glCanvas.getContext("webgl", { antialias: false, alpha: false });
  if (!gl) return;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.error(gl.getShaderInfoLog(s)); return null; }
    return s;
  };
  const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) { gl = null; return; }
  prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  ["uRes","uTime","uSunPos","uSunR","uBreak","uHue","uNebula","uDim"]
    .forEach(n => uni[n] = gl.getUniformLocation(prog, n));
}

/* ════════════════════════════════════════════════════════════
   LAYER 2 — 2D canvas : the cybernetic particle network
   Modes: orbit ▸ plexus ▸ lattice ▸ stream — blended by scroll
   ════════════════════════════════════════════════════════════ */
const netCanvas = document.getElementById("net");
const ctx = netCanvas.getContext("2d");
const N = 130;
const parts = [];
let seedI = 1;
const srand = () => { seedI = (seedI * 16807) % 2147483647; return (seedI - 1) / 2147483646; };

for (let i = 0; i < N; i++) {
  parts.push({
    x: srand(), y: srand(),                  // normalized current pos
    sx: srand(), sy: srand(),                // plexus anchor
    a0: srand() * Math.PI * 2,               // orbit phase
    rr: .55 + srand() * 1.1,                 // orbit radius factor
    spd: .12 + srand() * .3,
    lane: srand(), ph: srand() * Math.PI * 2,
    sz: .8 + srand() * 1.6,
  });
}

// wireframe targets — particles assemble into a browser window
// (a website literally being built) during the Factory scene
function browserTarget(i, w, h) {
  const W = Math.min(w * .68, 980), H = Math.min(W * .6, h * .66);
  const x0 = w / 2 - W / 2, y0 = h * .5 - H / 2, bar = H * .15;
  let x, y;
  if (i < 64) {                       // window frame
    const t = (i / 64) * 4, s = Math.floor(t), f = t - s;
    if (s === 0)      { x = x0 + f * W; y = y0; }
    else if (s === 1) { x = x0 + W;     y = y0 + f * H; }
    else if (s === 2) { x = x0 + W - f * W; y = y0 + H; }
    else              { x = x0;         y = y0 + H - f * H; }
  } else if (i < 80) {                // toolbar divider
    x = x0 + ((i - 64) / 15) * W; y = y0 + bar;
  } else if (i < 83) {                // traffic lights
    x = x0 + W * .05 + (i - 80) * W * .035; y = y0 + bar * .5;
  } else if (i < 97) {                // hero headline line
    x = x0 + W * .1 + ((i - 83) / 13) * W * .56; y = y0 + bar + H * .2;
  } else if (i < 111) {               // body copy line
    x = x0 + W * .1 + ((i - 97) / 13) * W * .8; y = y0 + bar + H * .42;
  } else if (i < 123) {               // second copy line
    x = x0 + W * .1 + ((i - 111) / 11) * W * .68; y = y0 + bar + H * .56;
  } else {                            // CTA button block
    x = x0 + W * .1 + ((i - 123) / (N - 124)) * W * .26; y = y0 + bar + H * .76;
  }
  return { x: x / w, y: y / h, seg: i < 64 ? Math.floor((i / 64) * 4) : 10 + (i < 80 ? 1 : i < 83 ? 2 : i < 97 ? 3 : i < 111 ? 4 : i < 123 ? 5 : 6) };
}

function drawNet(time, V) {
  ctx.clearRect(0, 0, vw, vh);
  const { wOrbit, wPlexus, wLattice, wStream, netAlpha, hue, sunPx } = V;
  if (netAlpha <= .01) return;

  const warm = [255, 178, 77], cool = [48, 215, 207];
  const cr = Math.round(lerp(warm[0], cool[0], hue));
  const cg = Math.round(lerp(warm[1], cool[1], hue));
  const cb = Math.round(lerp(warm[2], cool[2], hue));

  const px = [], py = [];
  for (let i = 0; i < N; i++) {
    const p = parts[i];
    // mode targets (normalized space)
    const oa = p.a0 + time * p.spd * .25;
    const orbR = (sunPx.r / vh) * p.rr * 2.2 + .02;
    const ox = sunPx.x / vw + Math.cos(oa) * orbR * (vh / vw);
    const oy = sunPx.y / vh + Math.sin(oa) * orbR;

    const plx = p.sx + Math.sin(time * .25 + p.ph) * .015;
    const ply = p.sy + Math.cos(time * .21 + p.ph * 1.7) * .015;

    const lt = browserTarget(i, vw, vh);
    const ltx = lt.x + Math.sin(time * .6 + i) * .0015;
    const lty = lt.y + Math.cos(time * .5 + i * 1.3) * .0015;

    const stx = ((p.lane * 1.4 + time * .045 * (0.6 + p.spd)) % 1.2) - .1;
    const sty = .18 + p.sy * .64 + Math.sin(stx * 9 + p.ph) * .04;

    const tw = wOrbit + wPlexus + wLattice + wStream || 1;
    const tx = (ox * wOrbit + plx * wPlexus + ltx * wLattice + stx * wStream) / tw;
    const ty = (oy * wOrbit + ply * wPlexus + lty * wLattice + sty * wStream) / tw;

    // streams need hard positioning (wrap); wireframe snaps crisp; others ease.
    // after a scrollbar yank (big jump) converge hard so scenes form instantly
    let k = wStream / tw > .6 ? .35 : wLattice / tw > .5 ? .13 : .07;
    if (V.snap) k = Math.max(k, .45);
    p.x = lerp(p.x, tx, k);
    p.y = lerp(p.y, ty, k);
    px[i] = p.x * vw; py[i] = p.y * vh;
  }

  // connectors
  const linkW = Math.max(wPlexus, wLattice);
  if (linkW > .02) {
    const maxD = lerp(0, Math.min(vw, vh) * .14, linkW);
    const bw = Math.min(vw * .68, 980);            // wireframe link reach
    ctx.lineWidth = 1;
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const dx = px[i] - px[j], dy = py[i] - py[j];
        const d2 = dx * dx + dy * dy;
        const md = wLattice > .3 ? (bw * .075) * (bw * .075) : maxD * maxD;
        if (d2 < md) {
          const a = (1 - d2 / md) * (.34 + .35 * wLattice) * linkW * netAlpha;
          if (a > .01) {
            ctx.strokeStyle = `rgba(${cr},${cg},${cb},${a})`;
            ctx.beginPath(); ctx.moveTo(px[i], py[i]); ctx.lineTo(px[j], py[j]); ctx.stroke();
          }
        }
      }
    }
  }

  // nodes
  for (let i = 0; i < N; i++) {
    const p = parts[i];
    const tw = .55 + .45 * Math.sin(time * 1.4 + p.ph * 5);
    const a = netAlpha * (.5 + .5 * tw);
    const s = p.sz * (1 + wStream * .4);
    ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
    ctx.beginPath(); ctx.arc(px[i], py[i], s, 0, 7); ctx.fill();
    if (p.sz > 2) { // a few glowing heroes
      ctx.fillStyle = `rgba(${cr},${cg},${cb},${a * .12})`;
      ctx.beginPath(); ctx.arc(px[i], py[i], s * 4, 0, 7); ctx.fill();
    }
  }
}

/* ════════════════════════════════════════════════════════════
   THE SCRIPT — scroll → visual state keyframes
   ════════════════════════════════════════════════════════════ */
function computeVisual() {
  const S = scenes;
  // defaults
  const V = {
    sun: { x: 0, y: .02, r: .30 },   // shader space: centered, y up
    brk: 0, hue: 0, nebula: .5, dim: 1,
    wOrbit: 0, wPlexus: 0, wLattice: 0, wStream: 0, netAlpha: 0,
  };

  const hero = S.hero, sig = S.signal, fac = S.factory, days = S.days,
        team = S.team, nums = S.numbers, pri = S.pricing, out = S.outro;

  // — HERO: huge calm sun, faint orbiting embers
  if (hero) {
    const p = hero.p;
    V.sun.r = lerp(.30, .24, p);
    V.sun.y = lerp(-.02, .10, p);
    V.brk = p * .35;
    V.wOrbit = 1; V.netAlpha = lerp(.35, .6, p);
  }
  // — SIGNAL: sun shrinks & shatters; plexus network blooms
  if (sig && sig.on) {
    const p = sig.p;
    V.sun.r = lerp(.24, .085, smooth(p * 1.4));
    V.sun.y = lerp(.10, .30, p);
    V.sun.x = lerp(0, .32, smooth(p));
    V.brk = lerp(.35, 1, smooth(p * 2));
    V.nebula = lerp(.5, .85, p);
    V.wOrbit = 1 - smooth(p * 2.2);
    V.wPlexus = smooth(p * 1.8);
    V.netAlpha = lerp(.6, 1, p);
  }
  // — FACTORY: the network assembles into a browser wireframe
  if (fac && fac.on) {
    const p = fac.p;
    V.sun.r = .085; V.sun.x = .32; V.sun.y = .30; V.brk = lerp(1, .3, p);
    V.wOrbit = 0;
    V.wPlexus = 1 - smooth(p * 2.4);
    V.wLattice = smooth(p * 2);
    V.netAlpha = .8;
    V.nebula = .55;
  }
  // — DAYS: lattice dissolves into flowing data streams, hue → aqua
  if (days && days.on) {
    const p = days.p;
    V.hue = bell(p, .2, .85) * .85;
    V.sun.r = lerp(.085, .05, smooth(p * 3));
    V.sun.x = .32; V.sun.y = .34; V.brk = .25;
    V.wOrbit = 0;
    V.wLattice = 1 - smooth(p * 3);
    V.wStream = smooth(p * 2.5) * (1 - smooth((p - .88) / .12));
    V.netAlpha = .85;
    V.nebula = .8;
  }
  // — TEAM: calm cosmos, sparse drift
  if (team && team.on) {
    const v = team.vis;
    V.wOrbit = 0; V.wPlexus = .5; V.netAlpha = .4;
    V.nebula = lerp(.8, .6, v);
    V.sun.r = .05; V.sun.x = lerp(.32, -.38, smooth(v)); V.sun.y = .36;
    V.hue = lerp(V.hue, .25, smooth(v));
  }
  // — NUMBERS: warmth returns
  if (nums && nums.on) {
    const p = nums.p;
    V.hue = lerp(.25, 0, smooth(p));
    V.sun.r = lerp(.05, .1, p); V.sun.x = -.38; V.sun.y = .32;
    V.wOrbit = 0; V.wPlexus = .5; V.netAlpha = .45; V.brk = .2;
  }
  if (pri && pri.on) {
    V.sun.r = .1; V.sun.x = -.38; V.sun.y = .32;
    V.wOrbit = 0; V.wPlexus = .4; V.netAlpha = .35; V.hue = 0;
  }
  // — OUTRO: sunrise. The star returns, vast, below the horizon.
  if (out && out.on) {
    const p = out.p;
    const t = smooth(p);
    V.sun.x = lerp(-.38, 0, t);
    V.sun.y = lerp(-.9, -.42, t);
    V.sun.r = lerp(.2, .58, t);
    V.brk = .12; V.hue = 0;
    V.nebula = lerp(.6, .35, t);
    V.wOrbit = t; V.wPlexus = 1 - t; V.netAlpha = .5;
  }

  // sun position in pixels for the particle layer
  V.sunPx = {
    x: vw / 2 + V.sun.x * vh,
    y: vh / 2 - V.sun.y * vh,
    r: V.sun.r * vh,
  };
  return V;
}

/* ════════════════════════════════════════════════════════════
   DOM CHOREOGRAPHY
   ════════════════════════════════════════════════════════════ */
const heroInner = document.querySelector(".hero-inner");
const scrollCue = document.querySelector(".scroll-cue");
const beats = [...document.querySelectorAll(".beat")];
const feats = [...document.querySelectorAll(".factory-feats li")];
const daysTrack = document.getElementById("daysTrack");
const daysFill = document.getElementById("daysMeterFill");
const dayNum = document.getElementById("dayNum");
const termBody = document.getElementById("termBody");
const counters = [...document.querySelectorAll("[data-count]")];
const outroInner = document.querySelector(".outro-inner");

/* terminal script — scrub-typed by scroll */
const TERM_LINES = [
  ['t-cmd', '$ sunblock factory --new "your-business"'],
  ['t-dim', ''],
  ['',      '  ▸ scanning your business online ........ <ok>done</ok>'],
  ['',      '  ▸ pulling photos, reviews, brand ....... <ok>done</ok>'],
  ['',      '  ▸ assembling pages'],
  ['t-dim', '      home · services · gallery'],
  ['t-dim', '      reviews · contact .................. <ok>done</ok>'],
  ['',      '  ▸ tuning for phones &amp; speed ............ <ok>done</ok>'],
  ['',      '  ▸ deploying preview .................... <key>live</key>'],
  ['',      '  ▸ handing off to the studio team ....... <ok>on it</ok>'],
  ['t-dim', '      design pass · words pass · final eye'],
  ['t-dim', ''],
  ['t-key', '  → first draft: day 3.  launch: day 7. ☀'],
];
const TERM_PLAIN = TERM_LINES.map(l => l[1].replace(/<\/?\w+>/g, ""));
const TERM_TOTAL = TERM_PLAIN.reduce((s, l) => s + l.length + 1, 0);

function renderTerminal(chars) {
  let left = chars, html = "";
  for (let i = 0; i < TERM_LINES.length; i++) {
    if (left <= 0) break;
    const plain = TERM_PLAIN[i];
    const take = Math.min(plain.length, left);
    left -= take + 1;
    let text = plain.slice(0, take);
    if (take === plain.length) {
      // full line: apply inline tags
      text = TERM_LINES[i][1]
        .replace(/<ok>/g, '<span class="t-ok">').replace(/<\/ok>/g, "</span>")
        .replace(/<key>/g, '<span class="t-key">').replace(/<\/key>/g, "</span>");
    }
    const cls = TERM_LINES[i][0];
    html += cls ? `<span class="${cls}">${text}</span>\n` : text + "\n";
  }
  termBody.innerHTML = html + '<span class="t-cursor"></span>';
}

let trackW = 0;
function measureDOM() {
  trackW = daysTrack.scrollWidth - vw;
}

let lastTermChars = -1, lastDay = "";
function choreograph(V) {
  // hero text drifts up & fades as the film takes over
  if (scenes.hero) {
    const p = scenes.hero.p;
    heroInner.style.transform = `translateY(${-p * 16}vh) scale(${1 - p * .08})`;
    heroInner.style.opacity = 1 - smooth(p * 1.6);
    scrollCue.style.opacity = 1 - smooth(p * 4);
  }
  // signal beats crossfade in thirds
  if (scenes.signal) {
    const p = scenes.signal.p;
    beats.forEach((b, i) => {
      const c = (i + .5) / 3;
      const d = Math.abs(p - c) * 3;
      const o = clamp(1.15 - d * 2.3, 0, 1);
      b.style.opacity = o;
      b.style.transform = `translateY(${(p - c) * -120}px) scale(${.96 + o * .04})`;
    });
  }
  // factory: terminal scrub-typing + feature steps
  if (scenes.factory && scenes.factory.on) {
    const p = scenes.factory.p;
    const chars = Math.floor(smooth(clamp(p * 1.25, 0, 1)) * TERM_TOTAL);
    if (chars !== lastTermChars) { renderTerminal(chars); lastTermChars = chars; }
    feats.forEach((f, i) => f.classList.toggle("is-on", p > .22 + i * .2));
  }
  // seven days: horizontal scrub
  if (scenes.days) {
    const p = scenes.days.p;
    daysTrack.style.transform = `translateX(${-smooth(p) * trackW}px)`;
    daysFill.style.width = (p * 100).toFixed(2) + "%";
    const d = String(clamp(Math.ceil(p * 7), 1, 7)).padStart(2, "0");
    if (d !== lastDay) { dayNum.textContent = d; lastDay = d; }
  }
  // numbers: counters scrub with progress
  if (scenes.numbers && scenes.numbers.on) {
    const p = smooth(clamp(scenes.numbers.p * 1.6, 0, 1));
    counters.forEach(c => {
      c.textContent = Math.round(+c.dataset.count * p);
    });
  }
  // outro rise
  if (scenes.outro && scenes.outro.on) {
    const p = scenes.outro.p;
    outroInner.style.transform = `translateY(${(1 - smooth(p * 1.4)) * 60}px)`;
    outroInner.style.opacity = smooth(p * 2);
  }
}

/* ── reveal-on-view (hero sub, work cards) ─────────────────── */
const io = new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
}), { threshold: .15 });
document.querySelectorAll(".reveal").forEach(el => io.observe(el));
// stagger team pass cards
document.querySelectorAll(".pass-card").forEach((el, i) =>
  el.style.transitionDelay = i * 120 + "ms");

/* ── tilt cards ────────────────────────────────────────────── */
if (matchMedia("(pointer:fine)").matches) {
  document.querySelectorAll("[data-tilt]").forEach(card => {
    card.addEventListener("mousemove", e => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - .5;
      const y = (e.clientY - r.top) / r.height - .5;
      card.style.transform = `perspective(900px) rotateY(${x * 7}deg) rotateX(${-y * 7}deg) translateY(-6px)`;
    });
    card.addEventListener("mouseleave", () => { card.style.transform = ""; });
  });
}

/* ── magnetic buttons + custom cursor ──────────────────────── */
const cursor = document.querySelector(".cursor");
let mx = vw / 2, my = vh / 2, cx = mx, cy = my;
if (matchMedia("(pointer:fine)").matches) {
  addEventListener("mousemove", e => { mx = e.clientX; my = e.clientY; });
  document.querySelectorAll("a,button,.pass-card,.price-card").forEach(el => {
    el.addEventListener("mouseenter", () => cursor.classList.add("is-hot"));
    el.addEventListener("mouseleave", () => cursor.classList.remove("is-hot"));
  });
  document.querySelectorAll(".magnetic").forEach(el => {
    el.addEventListener("mousemove", e => {
      const r = el.getBoundingClientRect();
      el.style.transform = `translate(${(e.clientX - r.left - r.width / 2) * .18}px,${(e.clientY - r.top - r.height / 2) * .25}px)`;
    });
    el.addEventListener("mouseleave", () => { el.style.transform = ""; });
  });
}

/* ── nav: hide on scroll down, show on up ──────────────────── */
const nav = document.getElementById("nav");
let lastSY = 0;
addEventListener("scroll", () => {
  const y = window.scrollY;
  nav.classList.toggle("is-hidden", y > lastSY && y > vh * .8);
  lastSY = y;
}, { passive: true });

/* smooth anchor jumps */
document.querySelectorAll("[data-jump]").forEach(a =>
  a.addEventListener("click", e => {
    const t = document.querySelector(a.getAttribute("href"));
    if (t) { e.preventDefault(); t.scrollIntoView({ behavior: "smooth" }); }
  }));

document.getElementById("yr").textContent = new Date().getFullYear();

/* ════════════════════════════════════════════════════════════
   MAIN LOOP
   ════════════════════════════════════════════════════════════ */
function resize() {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  vw = innerWidth; vh = innerHeight;
  glCanvas.width = vw * (reduced ? 1 : dpr * .75);  // shader at .75 dpr — free perf
  glCanvas.height = vh * (reduced ? 1 : dpr * .75);
  netCanvas.width = vw * dpr; netCanvas.height = vh * dpr;
  netCanvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  if (gl) gl.viewport(0, 0, glCanvas.width, glCanvas.height);
  measure(); measureDOM();
}

const t0 = performance.now();
let lastNow = t0, prevEased = 0, snapLeft = 0;
function frame(now) {
  const time = (now - t0) / 1000;
  const dt = Math.min((now - lastNow) / 1000, 1);
  lastNow = now;
  // frame-rate independent catch-up (≈.09/frame at 60fps)
  eased += (scrollY - eased) * (reduced ? 1 : 1 - Math.pow(0.9965, dt * 1700));
  if (Math.abs(eased - prevEased) > vh * .6) snapLeft = 30;
  else if (snapLeft > 0) snapLeft--;
  prevEased = eased;
  updateProgress();
  const V = computeVisual();
  V.snap = snapLeft > 0;

  if (gl) {
    gl.uniform2f(uni.uRes, glCanvas.width, glCanvas.height);
    gl.uniform1f(uni.uTime, reduced ? 0 : time);
    gl.uniform2f(uni.uSunPos, V.sun.x, V.sun.y);
    gl.uniform1f(uni.uSunR, V.sun.r);
    gl.uniform1f(uni.uBreak, V.brk);
    gl.uniform1f(uni.uHue, V.hue);
    gl.uniform1f(uni.uNebula, V.nebula);
    gl.uniform1f(uni.uDim, V.dim);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  if (!reduced) drawNet(time, V);
  choreograph(V);

  if (matchMedia("(pointer:fine)").matches) {
    cx += (mx - cx) * .2; cy += (my - cy) * .2;
    cursor.style.left = cx + "px"; cursor.style.top = cy + "px";
  }
  requestAnimationFrame(frame);
}

/* ── boot ──────────────────────────────────────────────────── */
initGL();
resize();
addEventListener("resize", resize);
renderTerminal(0);
requestAnimationFrame(frame);

const loader = document.getElementById("loader");
addEventListener("load", () => setTimeout(() => loader.classList.add("is-done"), 600));
setTimeout(() => loader.classList.add("is-done"), 2600); // failsafe

})();
