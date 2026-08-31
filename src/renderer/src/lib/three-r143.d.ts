/**
 * Ambient types for the vendored three@0.143.0 package (that release ships no .d.ts).
 * Only the surface the Starfield Close engine touches.
 */

declare module 'three' {
  export const AdditiveBlending: number
  export const VSMShadowMap: number
  export const RGBAFormat: number

  export class Color {
    constructor(color?: string | number)
  }

  export class Vector2 {
    x: number
    y: number
    constructor(x?: number, y?: number)
  }

  export class Vector3 {
    x: number
    y: number
    z: number
    constructor(x?: number, y?: number, z?: number)
    set(x: number, y: number, z: number): this
    copy(v: Vector3): this
    add(v: Vector3): this
    sub(v: Vector3): this
    lerp(v: Vector3, alpha: number): this
    normalize(): this
    multiplyScalar(s: number): this
    clone(): Vector3
    unproject(camera: Camera): this
  }

  export class Fog {
    constructor(color: number, near?: number, far?: number)
  }

  export class Camera {
    position: Vector3
    layers: Layers
  }

  export class PerspectiveCamera extends Camera {
    aspect: number
    constructor(fov: number, aspect: number, near: number, far: number)
    lookAt(x: number, y: number, z: number): void
    updateProjectionMatrix(): void
  }

  export class Layers {
    set(channel: number): void
    enable(channel: number): void
  }

  export class Object3D {
    layers: Layers
    rotation: { z: number }
    add(obj: Object3D): this
  }

  export class Scene extends Object3D {
    background: number | Color
    fog: Fog | null
  }

  export class Group extends Object3D {}

  export class BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number)
  }

  export class Float32BufferAttribute extends BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number)
  }

  export class BufferGeometry {
    setAttribute(name: string, attribute: BufferAttribute): this
    dispose(): void
  }

  export class ShaderMaterial {
    uniforms: Record<string, { value: unknown }>
    constructor(params: Record<string, unknown>)
    dispose(): void
  }

  export class Points extends Object3D {
    constructor(geometry: BufferGeometry, material: ShaderMaterial)
  }

  export class DataTexture {
    needsUpdate: boolean
    constructor(data: ArrayLike<number>, width: number, height: number, format?: number)
    dispose(): void
  }

  export class WebGLRenderer {
    domElement: HTMLCanvasElement
    shadowMap: { enabled: boolean; type: number }
    constructor(params?: {
      canvas?: HTMLCanvasElement
      antialias?: boolean
      alpha?: boolean
      powerPreference?: 'default' | 'high-performance' | 'low-power'
    })
    setPixelRatio(n: number): void
    setSize(w: number, h: number, updateStyle?: boolean): void
    setClearColor(color: number, alpha?: number): void
    getContext(): WebGLRenderingContext | null
    dispose(): void
  }

  export class WebGL1Renderer extends WebGLRenderer {}
}

declare module 'three/examples/jsm/postprocessing/EffectComposer.js' {
  export class EffectComposer {
    renderToScreen: boolean
    renderTarget1: { texture: unknown; dispose(): void }
    renderTarget2: { dispose(): void }
    passes: Array<{ dispose?: () => void }>
    constructor(renderer: unknown)
    addPass(pass: unknown): void
    setSize(width: number, height: number): void
    render(): void
  }
}

declare module 'three/examples/jsm/postprocessing/RenderPass.js' {
  export class RenderPass {
    constructor(scene: unknown, camera: unknown)
  }
}

declare module 'three/examples/jsm/postprocessing/ShaderPass.js' {
  export class ShaderPass {
    uniforms: Record<string, { value: unknown }>
    constructor(shader: unknown, textureID?: string)
  }
}

declare module 'three/examples/jsm/postprocessing/UnrealBloomPass.js' {
  export class UnrealBloomPass {
    constructor(resolution: unknown, strength: number, radius: number, threshold: number)
    dispose(): void
  }
}

declare module 'three/examples/jsm/shaders/GammaCorrectionShader.js' {
  export const GammaCorrectionShader: unknown
}

declare module 'three/examples/jsm/shaders/CopyShader.js' {
  export const CopyShader: unknown
}
