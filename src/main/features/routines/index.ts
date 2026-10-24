/** Public surface of the routines feature (G66). Other modules reach it only through this file. */
export {
  createRoutineEngine,
  ROUTINE_SCHEDULER_LIMITS,
  type CompileInput,
  type ResearchResult,
  type RoutineAuditPhase,
  type RoutineEngine,
  type RoutineEngineDeps,
  type RoutineEvent,
  type RoutinePublication
} from './routine-engine'
export { createRoutineStore, type RoutineFileIo, type RoutineScope, type RoutineStore } from './routine-store'
