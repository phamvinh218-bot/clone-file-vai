import type { Pt } from "@/domain/geometry/path";

function cubicAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t;
  return {
    x: u ** 3 * p0.x + 3 * u ** 2 * t * p1.x + 3 * u * t ** 2 * p2.x + t ** 3 * p3.x,
    y: u ** 3 * p0.y + 3 * u ** 2 * t * p1.y + 3 * u * t ** 2 * p2.y + t ** 3 * p3.y,
  };
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

export function cubicExtrema(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt[] {
  const points = [p0, p3];
  for (const axis of ["x", "y"] as const) {
    const c0 = p0[axis];
    const c1 = p1[axis];
    const c2 = p2[axis];
    const c3 = p3[axis];
    const a = -c0 + 3 * c1 - 3 * c2 + c3;
    const b = 3 * c0 - 6 * c1 + 3 * c2;
    const c = -3 * c0 + 3 * c1;
    for (const t of quadraticRoots(3 * a, 2 * b, c)) {
      if (t > 0 && t < 1) points.push(cubicAt(p0, p1, p2, p3, t));
    }
  }
  return points;
}
