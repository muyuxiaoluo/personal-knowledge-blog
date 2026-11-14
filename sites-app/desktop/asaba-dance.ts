export type AsabaDancePose = {
  body: readonly [number, number, number, number];
  head: readonly [number, number];
  hands: readonly [number, number, number, number];
  steps: readonly [number, number, number, number];
  skirt: readonly [number, number];
};
const rest: AsabaDancePose = { body: [1, 0, 0, 0], head: [1, 0], hands: [0, 0, 0, 0], steps: [0, 0, 0, 0], skirt: [0, 0] };
const smooth = (value: number) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

/** A short step-touch phrase. Rotations preserve the original head's scale. */
export function asabaDancePose(progress?: number): AsabaDancePose {
  if (progress === undefined || progress <= 0 || progress >= 1) return rest;
  const envelope = smooth(progress / .12) * smooth((1 - progress) / .15);
  const phase = progress * Math.PI * 8;
  const beat = Math.sin(phase);
  const bodyAngle = beat * .035 * envelope;
  const headAngle = -beat * .012 * envelope;
  const left = Math.max(0, beat) * envelope;
  const right = Math.max(0, -beat) * envelope;
  return {
    body: [Math.cos(bodyAngle), Math.sin(bodyAngle), beat * 5 * envelope, (1 - Math.cos(phase * 2)) * .7 * envelope],
    head: [Math.cos(headAngle), Math.sin(headAngle)],
    hands: [-beat * 6 * envelope, Math.sin(phase + .6) * 4 * envelope,
      beat * 6 * envelope, Math.sin(phase - .6) * 4 * envelope],
    steps: [-left * 2.2, -left * 4, right * 2.2, -right * 4],
    skirt: [Math.sin(phase - .45) * 4.2 * envelope, Math.sin(phase * 2) * 1.8 * envelope],
  };
}

