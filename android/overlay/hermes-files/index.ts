// Re-export the main extension from src/
export { default } from "./src/index.ts";
export { createHermesMemoryBackend } from "./src/hermes-runtime.ts";
export type {
  HermesBackendRuntime,
  HermesBackendRuntimeOptions,
  HermesBackendStatus,
  HermesBackendSearchOptions,
  HermesBackendSearchResult,
  HermesBackendSaveInput,
  HermesBackendSaveResult,
  HermesExec,
} from "./src/hermes-runtime.ts";
