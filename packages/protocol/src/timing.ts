/** Audio frames between two rows. Usually fractional; callers anchor to avoid drift. */
export function framesPerRow(sampleRate: number, bpm: number, rowsPerBeat: number): number {
  return (sampleRate * 60) / (bpm * rowsPerBeat);
}

export function secondsPerRow(bpm: number, rowsPerBeat: number): number {
  return 60 / (bpm * rowsPerBeat);
}
