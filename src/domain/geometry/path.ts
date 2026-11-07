import { apply, type Matrix } from "@/domain/geometry/matrix";

export type Pt = { x: number; y: number };
export type Subpath = { points: Pt[]; closed: boolean };

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y,
  };
}

function cubicExtrema(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt[] {
  const points = [p0, p3];
  for (const axis of ["x", "y"] as const) {
    const c0 = p0[axis];
    const c1 = p1[axis];
    const c2 = p2[axis];
    const c3 = p3[axis];
    const a = -c0 + 3 * c1 - 3 * c2 + c3;
    const b = 3 * c0 - 6 * c1 + 3 * c2;
    const c = -3 * c0 + 3 * c1;
    const roots = quadraticRoots(3 * a, 2 * b, c);
    for (const t of roots) {
      if (t > 0 && t < 1) points.push(cubicAt(p0, p1, p2, p3, t));
    }
  }
  for (const t of [0.25, 0.5, 0.75]) points.push(cubicAt(p0, p1, p2, p3, t));
  return points;
}

function quadraticRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) < 1e-12) return [];
    return [-c / b];
  }
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const root = Math.sqrt(disc);
  return [(-b + root) / (2 * a), (-b - root) / (2 * a)];
}

function angleBetween(u: Pt, v: Pt): number {
  const dot = u.x * v.x + u.y * v.y;
  const det = u.x * v.y - u.y * v.x;
  return Math.atan2(det, dot);
}

/** Endpoint-parameterized elliptical arc, following the SVG spec. Returns points on the arc. */
export function arcPoints(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  phiDeg: number,
  large: boolean,
  sweep: boolean,
  x2: number,
  y2: number,
): Pt[] {
  if (Math.hypot(x2 - x1, y2 - y1) < 1e-9) return [{ x: x1, y: y1 }];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx < 1e-9 || ry < 1e-9) return [{ x: x1, y: y1 }, { x: x2, y: y2 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const scale = Math.sqrt(lam);
    rx *= scale;
    ry *= scale;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = Math.sqrt(Math.max(0, num / den)) * (large === sweep ? -1 : 1);
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * ((-ry * x1p) / rx);
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const start = angleBetween({ x: 1, y: 0 }, { x: (x1p - cxp) / rx, y: (y1p - cyp) / ry });
  let delta = angleBetween(
    { x: (x1p - cxp) / rx, y: (y1p - cyp) / ry },
    { x: (-x1p - cxp) / rx, y: (-y1p - cyp) / ry },
  );
  if (!sweep && delta > 0) delta -= Math.PI * 2;
  if (sweep && delta < 0) delta += Math.PI * 2;
  const steps = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 24)));
  const points: Pt[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const theta = start + (delta * i) / steps;
    const ex = rx * Math.cos(theta);
    const ey = ry * Math.sin(theta);
    points.push({ x: cx + cos * ex - sin * ey, y: cy + sin * ex + cos * ey });
  }
  // Include exact ellipse extrema that fall inside the sweep so the bbox cannot undershoot a sample.
  const candidates = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  for (const base of candidates) {
    const theta = base;
    let rel = theta - start;
    if (delta >= 0) {
      while (rel < 0) rel += Math.PI * 2;
      while (rel > Math.PI * 2) rel -= Math.PI * 2;
      if (rel <= delta + 1e-6) {
        const ex = rx * Math.cos(theta);
        const ey = ry * Math.sin(theta);
        points.push({ x: cx + cos * ex - sin * ey, y: cy + sin * ex + cos * ey });
      }
    } else {
      while (rel > 0) rel -= Math.PI * 2;
      while (rel < -Math.PI * 2) rel += Math.PI * 2;
      if (rel >= delta - 1e-6) {
        const ex = rx * Math.cos(theta);
        const ey = ry * Math.sin(theta);
        points.push({ x: cx + cos * ex - sin * ey, y: cy + sin * ex + cos * ey });
      }
    }
  }
  return points;
}

type Cursor = { x: number; y: number; sx: number; sy: number; prev?: { cmd: string; c: Pt } };

export function parseSvgPath(d: string, matrix: Matrix): Subpath[] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g) ?? [];
  let i = 0;
  const subs: Subpath[] = [];
  let current: Subpath | null = null;
  const cursor: Cursor = { x: 0, y: 0, sx: 0, sy: 0 };
  const read = () => Number(tokens[i++]);
  const hasNum = () => i < tokens.length && !/^[a-zA-Z]$/.test(tokens[i]);

  function ensure() {
    if (!current) {
      current = { points: [], closed: false };
      subs.push(current);
    }
    return current;
  }
  function add(pt: Pt) {
    const [x, y] = apply(matrix, pt.x, pt.y);
    ensure().points.push({ x, y });
    cursor.x = pt.x;
    cursor.y = pt.y;
  }
  function lineTo(x: number, y: number) {
    add({ x, y });
  }

  let cmd = "";
  while (i < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[i])) cmd = tokens[i++];
    if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const op = cmd.toUpperCase();
    if (op === "M") {
      const x = read() + (rel ? cursor.x : 0);
      const y = read() + (rel ? cursor.y : 0);
      current = { points: [], closed: false };
      subs.push(current);
      add({ x, y });
      cursor.sx = x;
      cursor.sy = y;
      cmd = rel ? "l" : "L";
      cursor.prev = { cmd: "M", c: { x, y } };
      continue;
    }
    if (op === "Z") {
      if (current && current.points.length) current.closed = true;
      lineTo(cursor.sx, cursor.sy);
      cursor.prev = { cmd: "Z", c: { x: cursor.sx, y: cursor.sy } };
      current = null;
      continue;
    }
    if (op === "L") {
      const x = read() + (rel ? cursor.x : 0);
      const y = read() + (rel ? cursor.y : 0);
      lineTo(x, y);
      cursor.prev = { cmd: "L", c: { x, y } };
      continue;
    }
    if (op === "H") {
      const x = read() + (rel ? cursor.x : 0);
      lineTo(x, cursor.y);
      cursor.prev = { cmd: "L", c: { x, y: cursor.y } };
      continue;
    }
    if (op === "V") {
      const y = read() + (rel ? cursor.y : 0);
      lineTo(cursor.x, y);
      cursor.prev = { cmd: "L", c: { x: cursor.x, y } };
      continue;
    }
    if (op === "C") {
      const c1 = { x: read() + (rel ? cursor.x : 0), y: read() + (rel ? cursor.y : 0) };
      const c2 = { x: read() + (rel ? cursor.x : 0), y: read() + (rel ? cursor.y : 0) };
      const end = { x: read() + (rel ? cursor.x : 0), y: read() + (rel ? cursor.y : 0) };
      const start = { x: cursor.x, y: cursor.y };
      for (const pt of cubicExtrema(start, c1, c2, end)) add(pt);
      cursor.x = end.x;
      cursor.y = end.y;
      cursor.prev = { cmd: "C", c: c2 };
      continue;
    }
    if (op === "S") {
      const c2 = { x: read() + (rel ? cursor.x : 0), y: read() + (rel ? cursor.y : 0) };
      const end = { x: read() + (rel ? cursor.x : 0), y: read() + (rel ? cursor.y : 0) };
      const start = { x: cursor.x, y: cursor.y };
      const prev = cursor.prev?.cmd === "C" ? cursor.prev.c : start;
      const c1 = { x: 2 * start.x - prev.x, y: 2 * start.y - prev.y };
      for (const pt of cubicExtrema(start, c1, c2, end)) add(pt);
      cursor.x = end.x;
      cursor.y = end.y;
      cursor.prev = { cmd: "C", c: c2 };
      continue;
    }
    if (op === "Q") {
      const c = { x: read() + (rel ? cursor.x : 0), y: read() + (rel ? cursor.y : 0) };
      const end = { x: read() + (rel ? cursor.x : 0), y: read() + (rel ? cursor.y : 0) };
      const start = { x: cursor.x, y: cursor.y };
      const c1 = { x: start.x + (2 / 3) * (c.x - start.x), y: start.y + (2 / 3) * (c.y - start.y) };
      const c2 = { x: end.x + (2 / 3) * (c.x - end.x), y: end.y + (2 / 3) * (c.y - end.y) };
      for (const pt of cubicExtrema(start, c1, c2, end)) add(pt);
      cursor.x = end.x;
      cursor.y = end.y;
      cursor.prev = { cmd: "Q", c };
      continue;
    }
    if (op === "A") {
      const rx = read();
      const ry = read();
      const phi = read();
      const large = read() !== 0;
      const sweep = read() !== 0;
      const end = { x: read() + (rel ? cursor.x : 0), y: read() + (rel ? cursor.y : 0) };
      for (const pt of arcPoints(cursor.x, cursor.y, rx, ry, phi, large, sweep, end.x, end.y)) add(pt);
      cursor.x = end.x;
      cursor.y = end.y;
      cursor.prev = { cmd: "A", c: end };
      continue;
    }
    if (!hasNum()) break;
  }
  return subs.filter((sub) => sub.points.length > 0);
}

export function pointInPolygon(pt: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersect = a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y + 0.0) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}
