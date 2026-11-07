export type Matrix = [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Column-vector product. `multiply(outer, inner)` applies inner first. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

function translate(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

function rotate(angleDeg: number, cx = 0, cy = 0): Matrix {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const rot: Matrix = [cos, sin, -sin, cos, 0, 0];
  if (!cx && !cy) return rot;
  return multiply(multiply(translate(cx, cy), rot), translate(-cx, -cy));
}

function fromName(name: string, nums: number[]): Matrix {
  if (nums.some((n) => !Number.isFinite(n))) return IDENTITY;
  switch (name) {
    case "translate":
      return translate(nums[0] ?? 0, nums[1] ?? 0);
    case "scale":
      return [nums[0] ?? 1, 0, 0, nums[1] ?? nums[0] ?? 1, 0, 0];
    case "rotate":
      return rotate(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0);
    case "skewX":
      return [1, 0, Math.tan(((nums[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
    case "skewY":
      return [1, Math.tan(((nums[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
    case "matrix":
      if (nums.length < 6) return IDENTITY;
      return [nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]];
    default:
      return IDENTITY;
  }
}

/** SVG transform lists apply right to left. */
export function parseTransformList(input: string | undefined): Matrix {
  if (!input) return IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  const ops: Matrix[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(input))) {
    const nums = match[2]
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    ops.push(fromName(match[1], nums));
  }
  let out: Matrix = IDENTITY;
  for (let i = ops.length - 1; i >= 0; i -= 1) out = multiply(ops[i], out);
  return out;
}
