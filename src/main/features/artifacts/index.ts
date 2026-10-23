/** Public surface of the artifacts feature (G53). Other modules reach it only through this file. */
export { composeArtifacts } from './compose'
export { createArtifactRegistry, type ArtifactRegistry, type RegisterArtifactInput } from './registry'
export { createArtifactService, type ArtifactService } from './service'
