// Types for the vendored thinking-orbs engine (MIT, Jakub Antalik). Only what
// the site calls.
export interface OrbPreset {
  mode: string;
  speed: number;
  opts: Record<string, unknown>;
}
export type OrbDraw = (
  ctx: CanvasRenderingContext2D,
  size: number,
  t: number,
  dark: boolean,
  opts: Record<string, unknown>,
) => void;
declare const ThinkingOrbsEngine: {
  resolvePreset(state: string, size: 20 | 64): OrbPreset;
  MODE_DRAWS: Record<string, OrbDraw>;
};
export default ThinkingOrbsEngine;
