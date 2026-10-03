export const AUDIT_STANDARD =
  'WCAG 2.2 AA: 1.4.3 text contrast, 1.4.11 non-text contrast, and no clipped or horizontally overflowing content'

const TEXT_REQUIRED = 4.5
const LARGE_TEXT_REQUIRED = 3
const NON_TEXT_REQUIRED = 3
const EPSILON = 0.01
const CLIP_TOLERANCE = 1

const CONTROL_SELECTOR = [
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="switch"]',
  '[role="checkbox"]'
].join(',')

function round(value, places = 2) {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

export function parseCssColor(value) {
  const input = String(value || '').trim().toLowerCase()
  if (!input || input === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(input)
  if (hex) {
    let raw = hex[1]
    if (raw.length === 3 || raw.length === 4) raw = raw.split('').map((c) => `${c}${c}`).join('')
    const hasAlpha = raw.length === 8
    return {
      r: Number.parseInt(raw.slice(0, 2), 16),
      g: Number.parseInt(raw.slice(2, 4), 16),
      b: Number.parseInt(raw.slice(4, 6), 16),
      a: hasAlpha ? round(Number.parseInt(raw.slice(6, 8), 16) / 255, 4) : 1
    }
  }

  const rgb = /^rgba?\((.+)\)$/.exec(input)
  if (!rgb) return undefined
  const slashParts = rgb[1].split('/').map((part) => part.trim())
  const channels = slashParts[0].includes(',') ? slashParts[0].split(',') : slashParts[0].split(/\s+/)
  if (channels.length < 3) return undefined
  const alpha = slashParts[1] ?? (channels.length > 3 ? channels[3] : '1')
  return {
    r: parseCssChannel(channels[0]),
    g: parseCssChannel(channels[1]),
    b: parseCssChannel(channels[2]),
    a: parseCssAlpha(alpha)
  }
}

function parseCssChannel(value) {
  const raw = String(value).trim()
  if (raw.endsWith('%')) return clamp01(Number.parseFloat(raw) / 100) * 255
  return clamp01(Number.parseFloat(raw) / 255) * 255
}

function parseCssAlpha(value) {
  const raw = String(value).trim()
  if (raw.endsWith('%')) return clamp01(Number.parseFloat(raw) / 100)
  return clamp01(Number.parseFloat(raw))
}

export function formatColor(color) {
  return `rgba(${round(color.r, 1)}, ${round(color.g, 1)}, ${round(color.b, 1)}, ${round(color.a, 4)})`
}

export function compositeColors(foreground, background) {
  const fg = typeof foreground === 'string' ? parseCssColor(foreground) : foreground
  const bg = typeof background === 'string' ? parseCssColor(background) : background
  if (!fg || !bg) return undefined
  const alpha = fg.a + bg.a * (1 - fg.a)
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 }
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / alpha,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / alpha,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / alpha,
    a: alpha
  }
}

function linearChannel(channel) {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

export function relativeLuminance(color) {
  const c = typeof color === 'string' ? parseCssColor(color) : color
  if (!c) return undefined
  return 0.2126 * linearChannel(c.r) + 0.7152 * linearChannel(c.g) + 0.0722 * linearChannel(c.b)
}

export function contrastRatio(foreground, background) {
  const fg = relativeLuminance(foreground)
  const bg = relativeLuminance(background)
  if (fg === undefined || bg === undefined) return undefined
  const lighter = Math.max(fg, bg)
  const darker = Math.min(fg, bg)
  return (lighter + 0.05) / (darker + 0.05)
}

export function isLargeText({ fontSizePx, fontWeight }) {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700)
}

export function textContrastRequirement(metrics) {
  return isLargeText(metrics) ? LARGE_TEXT_REQUIRED : TEXT_REQUIRED
}

export function hasClippedTextBox(box) {
  if (!box.visible || !box.textBearing) return false
  const clipsOverflow = ['hidden', 'clip'].includes(box.overflowX) || ['hidden', 'clip'].includes(box.overflowY)
  const ellipsis = box.textOverflow === 'ellipsis'
  if (!clipsOverflow && !ellipsis) return false
  return box.scrollWidth > box.clientWidth + CLIP_TOLERANCE || box.scrollHeight > box.clientHeight + CLIP_TOLERANCE
}

export function pageHasHorizontalScroll({ documentWidth, viewportWidth }) {
  return documentWidth > viewportWidth + CLIP_TOLERANCE
}

export function boxExtendsHorizontallyOutsideViewport(box, viewportWidth) {
  if (!box.visible) return false
  return box.left < -CLIP_TOLERANCE || box.right > viewportWidth + CLIP_TOLERANCE
}

export function emptyAuditResult() {
  return {
    pass: true,
    text: { checked: 0, failures: [] },
    nonText: { checked: 0, failures: [] },
    clipping: { checked: 0, failures: [] },
    unverifiable: []
  }
}

/**
 * @param {Array<{ audit?: { pass?: boolean, text: { checked: number, failures: Array<unknown> }, nonText: { checked: number, failures: Array<unknown> }, clipping: { checked: number, failures: Array<unknown> }, unverifiable: Array<unknown> } }>} entries
 * @param {{ detected: boolean, kinds: string[] }} negativeControl
 */
export function summarizeAudits(entries, negativeControl = { detected: false, kinds: [] }) {
  const summary = {
    standard: AUDIT_STANDARD,
    failures: 0,
    text: { checked: 0, failures: 0 },
    nonText: { checked: 0, failures: 0 },
    clipping: { checked: 0, failures: 0 },
    unverifiable: 0,
    negativeControl
  }
  for (const entry of entries) {
    const audit = entry.audit
    if (!audit) continue
    summary.text.checked += audit.text.checked
    summary.text.failures += audit.text.failures.length
    summary.nonText.checked += audit.nonText.checked
    summary.nonText.failures += audit.nonText.failures.length
    summary.clipping.checked += audit.clipping.checked
    summary.clipping.failures += audit.clipping.failures.length
    summary.unverifiable += audit.unverifiable.length
  }
  summary.failures = summary.text.failures + summary.nonText.failures + summary.clipping.failures
  return summary
}

function selectorFor(element) {
  if (!element || element.nodeType !== 1) return ''
  const tag = element.tagName.toLowerCase()
  const id = element.id ? `#${cssEscape(element.id)}` : ''
  if (id) return `${tag}${id}`
  const classes = Array.from(element.classList || []).slice(0, 2).map((c) => `.${cssEscape(c)}`).join('')
  const role = element.getAttribute('role')
  if (classes) return `${tag}${classes}`
  if (role) return `${tag}[role="${role}"]`
  return tag
}

function cssEscape(value) {
  const css = globalThis.CSS
  if (css?.escape) return css.escape(value)
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')
}

function elementLabel(element) {
  return {
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || undefined,
    selector: selectorFor(element)
  }
}

function isVisible(element, style = getComputedStyle(element)) {
  const rect = element.getBoundingClientRect()
  return (
    style.visibility !== 'hidden' &&
    style.display !== 'none' &&
    Number.parseFloat(style.opacity || '1') > 0 &&
    rect.width > 0 &&
    rect.height > 0
  )
}

function hasOwnVisibleText(element) {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true
  }
  return false
}

function hasText(element) {
  return Boolean(element.textContent?.trim())
}

function resolveBackground(element) {
  let current = element
  let background = { r: 255, g: 255, b: 255, a: 1 }
  const layers = []
  while (current) {
    const style = getComputedStyle(current)
    if (style.backgroundImage && style.backgroundImage !== 'none') return { resolved: false, reason: 'background-image' }
    const color = parseCssColor(style.backgroundColor)
    if (color && color.a > 0) layers.push(color)
    current = current.parentElement
  }
  for (const color of layers.reverse()) background = compositeColors(color, background)
  return { resolved: true, color: background }
}

function textRow(element, ratio, required, foreground, background) {
  return {
    ...elementLabel(element),
    measured: round(ratio),
    required,
    foreground: formatColor(foreground),
    background: formatColor(background)
  }
}

function unresolvedRow(element, kind, reason) {
  return { ...elementLabel(element), kind, reason }
}

function collectTextContrast(result, elements) {
  for (const element of elements) {
    const style = getComputedStyle(element)
    if (!isVisible(element, style) || !hasOwnVisibleText(element)) continue
    const background = resolveBackground(element)
    if (!background.resolved) {
      result.unverifiable.push(unresolvedRow(element, 'text', background.reason))
      continue
    }
    const color = parseCssColor(style.color)
    if (!color) {
      result.unverifiable.push(unresolvedRow(element, 'text', 'text-color'))
      continue
    }
    const foreground = compositeColors(color, background.color)
    const ratio = contrastRatio(foreground, background.color)
    const required = textContrastRequirement({
      fontSizePx: Number.parseFloat(style.fontSize || '0'),
      fontWeight: numericFontWeight(style.fontWeight)
    })
    result.text.checked++
    if (ratio === undefined || ratio + EPSILON < required) {
      result.text.failures.push(textRow(element, ratio ?? 0, required, foreground ?? color, background.color))
    }
  }
}

function numericFontWeight(value) {
  if (value === 'bold') return 700
  if (value === 'normal') return 400
  return Number.parseInt(value || '400', 10) || 400
}

function borderColors(style) {
  const sides = [
    ['borderTop', style.borderTopColor, style.borderTopWidth, style.borderTopStyle],
    ['borderRight', style.borderRightColor, style.borderRightWidth, style.borderRightStyle],
    ['borderBottom', style.borderBottomColor, style.borderBottomWidth, style.borderBottomStyle],
    ['borderLeft', style.borderLeftColor, style.borderLeftWidth, style.borderLeftStyle]
  ]
  return sides
    .filter(([, , width, borderStyle]) => Number.parseFloat(width || '0') > 0 && borderStyle !== 'none')
    .map(([, color]) => color)
    .filter(Boolean)
    .filter((color, index, colors) => colors.indexOf(color) === index)
}

function contrastCandidate(color, background, source) {
  const parsed = parseCssColor(color)
  if (!parsed || parsed.a <= 0) return undefined
  const foreground = compositeColors(parsed, background)
  const ratio = contrastRatio(foreground, background)
  return { source, foreground: foreground ?? parsed, ratio: ratio ?? 0 }
}

export function bestNonTextContrastCandidate(candidates) {
  return candidates
    .filter(Boolean)
    .reduce((best, candidate) => (best && best.ratio >= candidate.ratio ? best : candidate), undefined)
}

function collectNonTextContrast(result, elements) {
  for (const element of elements) {
    const style = getComputedStyle(element)
    if (!isVisible(element, style)) continue
    const background = resolveBackground(element.parentElement || element)
    if (!background.resolved) {
      result.unverifiable.push(unresolvedRow(element, 'nonText', background.reason))
      continue
    }
    const candidates = [
      ...borderColors(style).map((color) => contrastCandidate(color, background.color, 'border')),
      contrastCandidate(style.backgroundColor, background.color, 'fill')
    ]
    const candidate = bestNonTextContrastCandidate(candidates)
    if (candidate) {
      result.nonText.checked++
      if (candidate.ratio + EPSILON < NON_TEXT_REQUIRED) {
        result.nonText.failures.push({
          ...elementLabel(element),
          kind: 'control',
          source: candidate.source,
          measured: round(candidate.ratio),
          required: NON_TEXT_REQUIRED,
          foreground: formatColor(candidate.foreground),
          background: formatColor(background.color)
        })
      }
    }

    const previousActive = document.activeElement
    if (typeof element.focus === 'function') element.focus({ preventScroll: true })
    const focusStyle = getComputedStyle(element)
    const outline = parseCssColor(focusStyle.outlineColor)
    const outlineWidth = Number.parseFloat(focusStyle.outlineWidth || '0')
    if (outline && outline.a > 0 && outlineWidth > 0 && focusStyle.outlineStyle !== 'none') {
      const color = compositeColors(outline, background.color)
      const ratio = contrastRatio(color, background.color)
      result.nonText.checked++
      if (ratio === undefined || ratio + EPSILON < NON_TEXT_REQUIRED) {
        result.nonText.failures.push({
          ...elementLabel(element),
          kind: 'focus-indicator',
          measured: round(ratio ?? 0),
          required: NON_TEXT_REQUIRED,
          foreground: formatColor(color ?? outline),
          background: formatColor(background.color)
        })
      }
    }
    if (previousActive && previousActive !== element && typeof previousActive.focus === 'function') {
      previousActive.focus({ preventScroll: true })
    } else if (document.activeElement === element && typeof element.blur === 'function') {
      element.blur()
    }
  }
}

function collectClipping(result, elements) {
  const viewportWidth = window.innerWidth
  if (pageHasHorizontalScroll({ documentWidth: document.documentElement.scrollWidth, viewportWidth })) {
    result.clipping.failures.push({
      kind: 'page-horizontal-scroll',
      measured: document.documentElement.scrollWidth,
      required: viewportWidth
    })
  }

  for (const element of elements) {
    const style = getComputedStyle(element)
    if (!isVisible(element, style)) continue
    const rect = element.getBoundingClientRect()
    const box = {
      visible: true,
      textBearing: hasText(element),
      overflowX: style.overflowX,
      overflowY: style.overflowY,
      textOverflow: style.textOverflow,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      left: rect.left,
      right: rect.right
    }
    result.clipping.checked++
    if (hasClippedTextBox(box)) {
      result.clipping.failures.push({
        ...elementLabel(element),
        kind: 'text-clipped',
        measured: `${element.scrollWidth}x${element.scrollHeight}`,
        required: `${element.clientWidth}x${element.clientHeight}`
      })
    }
    if (boxExtendsHorizontallyOutsideViewport(box, viewportWidth)) {
      result.clipping.failures.push({
        ...elementLabel(element),
        kind: 'outside-viewport-horizontal',
        measured: `${round(rect.left)}..${round(rect.right)}`,
        required: `0..${viewportWidth}`
      })
    }
  }
}

export function collectPageAudit() {
  const result = emptyAuditResult()
  const elements = Array.from(document.body.querySelectorAll('*'))
  collectTextContrast(result, elements)
  collectNonTextContrast(result, elements.filter((element) => element.matches(CONTROL_SELECTOR)))
  collectClipping(result, elements)
  if (result.text.checked === 0) {
    result.text.failures.push({ kind: 'vacuous-audit', selector: 'body', measured: 0, required: 1 })
  }
  if (result.clipping.checked === 0) {
    result.clipping.failures.push({ kind: 'vacuous-audit', selector: 'document', measured: 0, required: 1 })
  }
  result.pass =
    result.text.failures.length === 0 &&
    result.nonText.failures.length === 0 &&
    result.clipping.failures.length === 0 &&
    result.unverifiable.length === 0
  return result
}

export function detectedFailureKinds(audit) {
  const kinds = new Set()
  if (audit.text.failures.length > 0) kinds.add('text')
  if (audit.nonText.failures.length > 0) kinds.add('nonText')
  if (audit.clipping.failures.length > 0) kinds.add('clipping')
  return [...kinds].sort()
}

export function missingFailureKinds(audit, requiredKinds = ['clipping', 'nonText', 'text']) {
  const detected = new Set(detectedFailureKinds(audit))
  return requiredKinds.filter((kind) => !detected.has(kind))
}

if (typeof window !== 'undefined') {
  window.__DESIGN_CAPTURE_AUDIT__ = { collect: collectPageAudit }
}
