#!/usr/bin/env node
// Generates low-poly SVG product art into public/images/products/.
// Usage: node scripts/generate-product-art.mjs
//
// Design rules:
// - Everything is flat-shaded polygon facets — no gradients, no filters, no
//   text. Cheap for the Pi 4 to rasterise once per card and tiny on disk.
// - Brand marks are abstracted to coloured shapes (the cola mark is a red
//   ribbon, not a logo).
// - Output is deterministic (seeded PRNG) so regeneration diffs cleanly.

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = join(import.meta.dirname, "..", "public", "images", "products");
const W = 400;
const H = 280;

// ── Small helpers ─────────────────────────────────────────────

// mulberry32 — deterministic per-image jitter.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const v = hex.replace("#", "");
  return [0, 2, 4].map(i => Number.parseInt(v.slice(i, i + 2), 16));
}

function rgbToHex([r, g, b]) {
  const c = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

// factor > 1 lightens, < 1 darkens.
function shade(hex, factor) {
  return rgbToHex(hexToRgb(hex).map(v => v * factor));
}

function poly(points, fill) {
  const pts = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return `<polygon points="${pts}" fill="${fill}"/>`;
}

const LIGHT = normalize([-0.45, -0.55, 0.7]); // top-left key light

function normalize(v) {
  const len = Math.hypot(...v);
  return v.map(x => x / len);
}

function lambert(normal, ambient = 0.35, gain = 0.85) {
  const d = Math.max(0, normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]);
  return ambient + gain * d;
}

// ── Scene chrome ──────────────────────────────────────────────

// Dark backdrop with a few barely-lighter facet shards so cards read as
// "rendered object", not flat icon. Matches the kiosk card background.
function backdrop(rand) {
  const parts = [`<rect width="${W}" height="${H}" fill="#001400"/>`];
  for (let i = 0; i < 6; i++) {
    const cx = rand() * W;
    const cy = rand() * H;
    const r = 60 + rand() * 110;
    const a0 = rand() * Math.PI * 2;
    const pts = [0, 1, 2].map(k => {
      const a = a0 + k * (1.6 + rand() * 1.2);
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    });
    parts.push(poly(pts, shade("#0a3010", 0.55 + rand() * 0.5)));
  }
  return parts.join("");
}

function groundShadow(cx, bottomY, rx) {
  // Squashed hexagon under the object.
  const ry = rx * 0.18;
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, bottomY + Math.sin(a) * ry]);
  }
  return poly(pts, "#000a00");
}

// ── Faceted primitives ────────────────────────────────────────

// Vertical facet strips faking a cylinder. bands: [{from, to, color}] as
// fractions of height, top-down. Returns { svg, surface } where surface(u, v)
// maps u∈[-1,1] (across) v∈[0,1] (down) to a point on the can face.
function facetCan(rand, { cx, topY, height, radius, taper = 0.94, bands, strips = 8 }) {
  const parts = [];
  const bottomY = topY + height;
  const xAt = (t, v) => {
    // t ∈ [0,1] across the strip grid, v ∈ [0,1] down the can.
    const r = radius * (1 - (1 - taper) * (1 - v)); // narrower at top
    const theta = -Math.PI / 2 + t * Math.PI;
    return cx + Math.sin(theta) * r;
  };
  for (const band of bands) {
    const y0 = topY + band.from * height;
    const y1 = topY + band.to * height;
    for (let i = 0; i < strips; i++) {
      const t0 = i / strips;
      const t1 = (i + 1) / strips;
      const thetaMid = -Math.PI / 2 + ((t0 + t1) / 2) * Math.PI;
      const normal = [Math.sin(thetaMid), 0, Math.cos(thetaMid)];
      const jitter = 0.94 + rand() * 0.12;
      let fill = shade(band.color, lambert(normal) * jitter);
      // Rim light on the outermost strips so dark cans keep a silhouette
      // against the dark card background.
      if (i === 0 || i === strips - 1) {
        fill = rgbToHex(hexToRgb(fill).map(v => v + 38));
      }
      parts.push(poly([
        [xAt(t0, band.from), y0],
        [xAt(t1, band.from), y0],
        [xAt(t1, band.to), y1],
        [xAt(t0, band.to), y1]
      ], fill));
    }
  }
  // Lid: squashed octagon + pull tab.
  const lidR = radius * taper;
  const lidRy = lidR * 0.28;
  const lidPts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    lidPts.push([cx + Math.cos(a) * lidR, topY + Math.sin(a) * lidRy]);
  }
  parts.push(poly(lidPts, "#b8bdc4"));
  const inPts = lidPts.map(([x, y]) => [cx + (x - cx) * 0.72, topY + (y - topY) * 0.72]);
  parts.push(poly(inPts, "#8d939b"));
  parts.push(poly([
    [cx - 4, topY - 2], [cx + 10, topY - 1], [cx + 8, topY + 4], [cx - 6, topY + 3]
  ], "#d7dbe0"));
  return {
    svg: parts.join(""),
    surface: (u, v) => [xAt((u + 1) / 2, v), topY + v * height],
    bottomY
  };
}

// Disco-ball facet sphere for BuzzBallz.
function facetBall(rand, { cx, cy, r, color, rings = 5, sectors = 8 }) {
  const parts = [];
  const phiAt = i => (i / rings) * Math.PI;           // polar, from top
  const thetaAt = j => -Math.PI / 2 + (j / sectors) * Math.PI; // visible hemisphere
  const point = (phi, theta) => [
    cx + r * Math.sin(phi) * Math.sin(theta),
    cy - r * Math.cos(phi)
  ];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < sectors; j++) {
      const phi0 = phiAt(i), phi1 = phiAt(i + 1);
      const th0 = thetaAt(j), th1 = thetaAt(j + 1);
      const phiM = (phi0 + phi1) / 2, thM = (th0 + th1) / 2;
      const normal = [Math.sin(phiM) * Math.sin(thM), -Math.cos(phiM), Math.sin(phiM) * Math.cos(thM)];
      const jitter = 0.92 + rand() * 0.16;
      const fill = shade(color, lambert(normal, 0.3, 0.95) * jitter);
      const quad = [point(phi0, th0), point(phi0, th1), point(phi1, th1), point(phi1, th0)];
      parts.push(poly(quad, fill));
    }
  }
  // Flat foil lid on top.
  const lidR = r * Math.sin(phiAt(1)) * 0.95;
  const lidY = cy - r * Math.cos(phiAt(1));
  const lidPts = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    lidPts.push([cx + Math.cos(a) * lidR, lidY - 6 + Math.sin(a) * lidR * 0.3]);
  }
  parts.push(poly(lidPts, "#c9ced4"));
  return { svg: parts.join(""), bottomY: cy + r };
}

function svgDoc(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${inner}</svg>\n`;
}

// ── Brand-mark abstractions ───────────────────────────────────

// Red cola ribbon — a clean zigzag wave band, deliberately not a logo.
// Top edge zigzags, bottom edge is the same zigzag offset down.
function colaRibbon(cx, y, w, color = "#d8232a", thickness = 11) {
  const n = 4;
  const zig = i => (i % 2 ? -6 : 6);
  const top = [];
  for (let i = 0; i <= n; i++) top.push([cx - w / 2 + (i / n) * w, y + zig(i)]);
  const bottom = top.map(([x, yy]) => [x, yy + thickness]).reverse();
  return poly([...top, ...bottom], color);
}

// Framed rectangle label (the JD cartouche, abstracted).
function framedLabel(cx, cy, w, h, frame, inner) {
  return [
    poly([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], frame),
    poly([[cx - w / 2 + 5, cy - h / 2 + 5], [cx + w / 2 - 5, cy - h / 2 + 5], [cx + w / 2 - 5, cy + h / 2 - 5], [cx - w / 2 + 5, cy + h / 2 - 5]], inner)
  ].join("");
}

function diamond(cx, cy, r, fill) {
  return poly([[cx, cy - r], [cx + r * 0.7, cy], [cx, cy + r], [cx - r * 0.7, cy]], fill);
}

// Octagonal ring built from 8 trapezoid segments — no evenodd seams,
// stays on-style (a ring of facets, not a smooth circle).
function ringOct(cx, cy, rOuter, thickness, fill) {
  const pt = (r, i) => {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
  };
  const segs = [];
  for (let i = 0; i < 8; i++) {
    const j = (i + 1) % 8;
    segs.push(poly([pt(rOuter, i), pt(rOuter, j), pt(rOuter - thickness, j), pt(rOuter - thickness, i)], fill));
  }
  return segs.join("");
}

// ── Product art ───────────────────────────────────────────────

const CAN = { cx: W / 2, topY: 48, height: 190, radius: 62 };      // 330ml
const SLIM = { cx: W / 2, topY: 40, height: 200, radius: 46 };     // 250ml slim
const WINE = { cx: W / 2, topY: 52, height: 180, radius: 52 };     // 187/200ml stubby

function jdCola(rand) {
  const can = facetCan(rand, { ...CAN, bands: [
    { from: 0, to: 0.06, color: "#3a3a3d" },
    { from: 0.06, to: 0.94, color: "#141414" },
    { from: 0.94, to: 1, color: "#3a3a3d" }
  ]});
  const marks = [
    framedLabel(CAN.cx, 118, 96, 58, "#e8e4d8", "#141414"),
    diamond(CAN.cx, 118, 16, "#e8e4d8"),
    colaRibbon(CAN.cx, 182, 100)
  ].join("");
  return can.svg + marks;
}

function smirnoffCola(rand) {
  const can = facetCan(rand, { ...SLIM, bands: [
    { from: 0, to: 0.3, color: "#c8ccd2" },
    { from: 0.3, to: 0.44, color: "#c8102e" },
    { from: 0.44, to: 1, color: "#c8ccd2" }
  ]});
  const marks = [
    // Eagle badge → red faceted ring with red core, below the band.
    ringOct(SLIM.cx, 158, 26, 8, "#c8102e"),
    diamond(SLIM.cx, 158, 10, "#c8102e"),
    colaRibbon(SLIM.cx, 205, 70, "#4a4f56", 8)
  ].join("");
  return can.svg + marks;
}

function captainPepsi(rand) {
  const can = facetCan(rand, { ...SLIM, bands: [
    { from: 0, to: 0.12, color: "#c9a24b" },
    { from: 0.12, to: 1, color: "#101418" }
  ]});
  // Pepsi orb → red/blue split circle with white tear across.
  const cx = SLIM.cx, cy = 150, r = 28;
  const oct = k => [...Array(8).keys()].map(i => {
    const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
    return [cx + Math.cos(a) * r * k, cy + Math.sin(a) * r * k];
  });
  const top = oct(1).filter(([, y]) => y <= cy + r * 0.4);
  const bottom = oct(1).filter(([, y]) => y >= cy - r * 0.4);
  const marks = [
    poly([...top, [cx + r, cy - 4], [cx - r, cy + 4]], "#d8232a"),
    poly([[cx - r, cy + 4], [cx + r, cy - 4], ...bottom.reverse()], "#1a4ea3"),
    poly([[cx - r, cy + 4], [cx + r, cy - 10], [cx + r, cy - 2], [cx - r, cy + 12]], "#eef1f4"),
    // Gold epaulette bar above the orb.
    poly([[cx - 34, 96], [cx + 34, 96], [cx + 28, 108], [cx - 28, 108]], "#c9a24b")
  ].join("");
  return can.svg + marks;
}

function tanquerayTonic(rand) {
  const can = facetCan(rand, { ...SLIM, bands: [
    { from: 0, to: 0.08, color: "#0d3b23" },
    { from: 0.08, to: 0.7, color: "#155c35" },
    { from: 0.7, to: 0.82, color: "#e8e4d8" },
    { from: 0.82, to: 1, color: "#155c35" }
  ]});
  const marks = [
    // Red wax seal.
    ringOct(SLIM.cx, 128, 22, 7, "#c8102e"),
    diamond(SLIM.cx, 128, 9, "#c8102e"),
    // Fizz — three pale facets rising like bubbles.
    diamond(SLIM.cx - 26, 84, 6, "#bfe3cf"),
    diamond(SLIM.cx + 22, 72, 5, "#bfe3cf"),
    diamond(SLIM.cx + 4, 62, 4, "#bfe3cf")
  ].join("");
  return can.svg + marks;
}

function buzzballz(rand, color, accent) {
  const ball = facetBall(rand, { cx: W / 2, cy: 152, r: 88, color });
  const marks = [diamond(W / 2, 152, 20, "#f2f2ee")];
  if (accent) marks.push(diamond(W / 2 + 36, 118, 13, accent));
  return ball.svg + marks.join("");
}

function niceWine(rand, bandColor) {
  const can = facetCan(rand, { ...WINE, bands: [
    { from: 0, to: 0.52, color: "#eceae2" },
    { from: 0.52, to: 1, color: bandColor }
  ]});
  // "nice" wordmark → chunky dark bar with a dot (abstract lowercase).
  const cx = WINE.cx;
  const marks = [
    poly([[cx - 34, 112], [cx + 22, 112], [cx + 22, 126], [cx - 34, 126]], "#22242a"),
    diamond(cx + 33, 119, 8, "#22242a")
  ].join("");
  return can.svg + marks;
}

function seaChange(rand) {
  const can = facetCan(rand, { ...WINE, bands: [
    { from: 0, to: 0.72, color: "#f0f2f4" },
    { from: 0.72, to: 1, color: "#1e5f8a" }
  ]});
  // Wave bands — two zigzag strips.
  const cx = WINE.cx;
  const wave = (y, color) => {
    const pts = [];
    for (let i = 0; i <= 4; i++) pts.push([cx - 40 + i * 20, y + (i % 2 ? -7 : 7)]);
    for (let i = 4; i >= 0; i--) pts.push([cx - 40 + i * 20, y + (i % 2 ? 5 : 19)]);
    return poly(pts, color);
  };
  const marks = [
    wave(128, "#2d7fb5"),
    wave(150, "#7fb8d9"),
    ringOct(cx, 92, 17, 6, "#1e5f8a") // 0% → blue ring
  ].join("");
  return can.svg + marks;
}

// ── Catalogue ─────────────────────────────────────────────────

const PRODUCTS = [
  ["buzzballz-espresso-martini",     rand => buzzballz(rand, "#37220f", "#e8dcc4")],
  ["buzzballz-passionfruit-martini", rand => buzzballz(rand, "#e39a1e", "#f2d24b")],
  ["buzzballz-lotta-colada",         rand => buzzballz(rand, "#e9e0cc", "#3f8f4f")],
  ["buzzballz-strawberry-rita",      rand => buzzballz(rand, "#d92b45", "#7fb84a")],
  ["buzzballz-tequila-rita",         rand => buzzballz(rand, "#9ccb3b", "#f2f2ee")],
  ["buzzballz-berry-cherry-limeade", rand => buzzballz(rand, "#a92667", "#d92b45")],
  ["buzzballz-chilli-mango",         rand => buzzballz(rand, "#f2811d", "#c8102e")],
  ["buzzballz-choc-tease",           rand => buzzballz(rand, "#6f4a28", "#f0a8bb")],
  ["premix-jd-cola",                 jdCola],
  ["premix-smirnoff-cola",           smirnoffCola],
  ["premix-captain-pepsi",           captainPepsi],
  ["premix-tanqueray-tonic",         tanquerayTonic],
  ["wine-nice-pale-rose",            rand => niceWine(rand, "#f0a8bb")],
  ["wine-nice-sauvignon-blanc",      rand => niceWine(rand, "#ccd076")],
  ["wine-nice-fizz",                 rand => niceWine(rand, "#eac557")],
  ["wine-sea-change-0",              seaChange]
];

await mkdir(OUT, { recursive: true });
for (const [index, [name, draw]] of PRODUCTS.entries()) {
  const rand = rng(0xB00B5 + index * 7919);
  const backdropSvg = backdrop(rand);
  const shadowY = name.startsWith("buzzballz") ? 244 : 246;
  const shadowR = name.startsWith("buzzballz") ? 92 : 70;
  const inner = backdropSvg + groundShadow(W / 2, shadowY, shadowR) + draw(rand);
  const file = join(OUT, `${name}.svg`);
  await writeFile(file, svgDoc(inner));
  console.log(`${name}.svg`);
}
console.log(`Done — ${PRODUCTS.length} images in public/images/products/`);
