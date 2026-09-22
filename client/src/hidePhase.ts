import { HIDER_OVERTIME_SEC } from './maps';

/** Hiding-clock stages (spec: pin freezes at timer end, 10s overtime, then skip). */
export type HidePhase = 'active' | 'overtime' | 'closed';

/** Stage of the hiding clock at nowMs given a server-issued deadline. */
export function hidePhaseAt(
  nowMs: number,
  deadlineMs: number,
  overtimeSec = HIDER_OVERTIME_SEC,
): HidePhase {
  if (nowMs < deadlineMs) return 'active';
  if (nowMs < deadlineMs + overtimeSec * 1000) return 'overtime';
  return 'closed';
}

/** Whole seconds left in the current stage (0 when closed). */
export function hideRemainingSec(
  nowMs: number,
  deadlineMs: number,
  overtimeSec = HIDER_OVERTIME_SEC,
): number {
  const phase = hidePhaseAt(nowMs, deadlineMs, overtimeSec);
  if (phase === 'active') return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  if (phase === 'overtime') {
    return Math.max(0, Math.ceil((deadlineMs + overtimeSec * 1000 - nowMs) / 1000));
  }
  return 0;
}

/** Round pins for anonymized teammate display (mirrors server anonymizedPins). */
export function anonymizePin(lat: number, lng: number): { lat: number; lng: number } {
  return { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000 };
}
