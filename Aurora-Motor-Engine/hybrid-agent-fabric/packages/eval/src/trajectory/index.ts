/**
 * Trajectory System
 * Records, replays, and analyzes Aurora's execution trajectories.
 * This is the backbone of the eval system — every task run produces
 * a trajectory that can be replayed, compared, and analyzed.
 */

export { TrajectoryRecorder } from "./trajectory-recorder.js";
export { TrajectoryAnalyzer } from "./trajectory-analyzer.js";
export { TrajectoryStore } from "./trajectory-store.js";
export { TrajectoryComparator } from "./trajectory-comparator.js";
export type {
  TrajectoryEvent,
  Trajectory,
  TrajectoryAnalysis,
  TrajectoryComparison,
  TrajectoryPattern,
} from "./types.js";
