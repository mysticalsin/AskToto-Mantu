/** Every top-level view App renders; a renderer crash report names one of these. */
export const RENDERER_VIEWS = ['answer', 'copilot', 'settings', 'review', 'history', 'agenda', 'brain'] as const
export type RendererView = (typeof RENDERER_VIEWS)[number]
