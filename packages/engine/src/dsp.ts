// The Web Audio-free half of the engine: synth, sequencer and offline render.
// Runs anywhere, including Node, which is how tests prove what players hear.
export { ChipSynth, noiseClockHz, stepLfsr } from './synth';
export { Sequencer, type QueuedOp, type RowEvent, type Timing } from './sequencer';
export { renderSong, type RenderOptions } from './render';
