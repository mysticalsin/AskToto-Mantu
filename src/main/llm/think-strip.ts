/**
 * think-strip.ts — removes a reasoning model's visible "thinking" from the answer stream.
 *
 * Two different shapes leak a model's thought process, and only one of them was already handled:
 *
 *  1. A SEPARATE field (`reasoning_content` on the OpenAI-compatible delta). openai.ts already keeps
 *     this out of the answer — it only pings the stall watchdog with it — so nothing to do here.
 *  2. INLINE tags inside `content` itself: `<think>…</think>` and friends. Qwen, DeepSeek-R1 distills,
 *     GLM, QwQ and several Workers AI models emit this shape, and it streams straight through to the
 *     renderer as if it were the answer. That is what this file fixes.
 *
 * Applied at the single onDelta choke point in index.ts, so it holds for EVERY provider — cloud, CLI,
 * Dust, a user's own OpenAI-compatible endpoint, and the on-device model — rather than being patched
 * per-strategy and drifting. (The local sidecar also passes `--reasoning off`, but that only binds
 * llama.cpp; a hosted model behind Cloudflare or a custom base URL obeys nothing we set locally.)
 *
 * ── Correctness constraints, in priority order ────────────────────────────────────────────────────
 *  - NEVER lose real answer text. A '<' that turns out not to open a think tag is emitted verbatim.
 *  - Tags split across chunk boundaries ('<thi' then 'nk>') must still be caught, so the minimal
 *    ambiguous tail is held back between pushes rather than emitted early.
 *  - An UNTERMINATED think block must not blank the answer: if the stream ends mid-think having
 *    emitted nothing, flush() releases what was withheld. Showing the thinking beats showing nothing —
 *    a silent empty answer would be a worse failure than the leak this file exists to prevent.
 */

/**
 * Tag names treated as thinking. Matched case-insensitively, with optional attributes.
 *
 * `reflection` earns its place from a real report: NVIDIA NIM endpoints serving reflection-tuned
 * models emit a `<thinking>` → `<reflection>` → `<output>` triple, and with only `thinking` handled the
 * self-critique in `<reflection>` still reached the answer.
 */
const THINK_TAGS = [
  'think',
  'thinking',
  'reasoning',
  'thought',
  'scratchpad',
  'reflection',
  'reflexion', // the tuning literature's spelling; some fine-tunes emit it verbatim
  'critique',
  'plan',
  'inner_monologue'
] as const

/**
 * Wrappers around the FINAL answer. These are unwrapped, never stripped: the answer lives inside them,
 * so treating `<output>` like a think tag would blank the response entirely — the exact opposite of the
 * intended fix. Order matters: unwrapping runs after think-stripping, on text already cleared to emit.
 */
const ANSWER_WRAPPERS = ['output', 'answer', 'final', 'response', 'result'] as const
const WRAPPER_RE = new RegExp(`</?(?:${ANSWER_WRAPPERS.join('|')})(?:\\s[^>]*)?>`, 'gi')

/**
 * Three dialects, because "reasoning model" is not one wire format:
 *  - XML-ish `<think>…</think>` — Qwen, DeepSeek-R1 distills, GLM, QwQ.
 *  - Unicode-bracket `◁think▷…◁/think▷` — Kimi (K2 and the -for-coding line). Deliberately NOT the
 *    ASCII '<': those are U+25C1/U+25B7 triangles, so the XML branch never sees them.
 *  - OpenAI harmony `<|channel|>analysis<|message|>…<|end|>` — gpt-oss. This one matters here and now:
 *    `@cf/openai/gpt-oss-120b` is the DEEP tier of the shipped Cloudflare provider (shared/providers.ts),
 *    so every "Go deeper" ask on the default provider can emit it. Harmony's answer arrives on the
 *    `final` channel, so the rule is: drop analysis/commentary, keep final.
 */
const OPEN_RE = new RegExp(
  `<(${THINK_TAGS.join('|')})(?:\\s[^>]*)?>` + // <think ...>
    `|◁(${THINK_TAGS.join('|')})▷` + // ◁think▷
    `|<\\|channel\\|>\\s*(?:analysis|commentary)\\b[^]*?<\\|message\\|>`, // harmony analysis header
  'i'
)
const CLOSE_RE = new RegExp(
  `</(${THINK_TAGS.join('|')})\\s*>` + // </think>
    `|◁/(${THINK_TAGS.join('|')})▷` + // ◁/think▷
    `|<\\|end\\|>|<\\|return\\|>` + // harmony block end
    `|<\\|start\\|>\\s*assistant\\s*<\\|channel\\|>\\s*final\\s*<\\|message\\|>` + // straight into the answer
    `|<\\|channel\\|>\\s*final\\s*<\\|message\\|>`,
  'i'
)

/**
 * Harmony scaffolding that can survive around the answer once the analysis block is gone. Each token
 * is consumed TOGETHER WITH the bare name that follows it: in harmony a role follows `<|start|>` and a
 * channel name follows `<|channel|>`, so deleting only the delimiters welds those words onto the answer
 * ('<|start|>assistant<|channel|>final<|message|>68' → 'assistantfinal68'). These are special tokens,
 * never ordinary prose, so consuming the trailing word cannot eat real content.
 */
const HARMONY_NOISE_RE =
  /<\|start\|>[ \t]*(?:assistant|user|system|developer)?|<\|channel\|>[ \t]*(?:final|analysis|commentary)?|<\|(?:end|return|message|constrain)\|>/gi

/** Literal openings whose PREFIX must be held back when a chunk ends mid-tag. Attribute forms are
 *  covered by the '<name' entries: anything after the name is ambiguous until the closing '>'. */
const OPEN_PREFIXES: string[] = [
  ...THINK_TAGS.map((t) => `<${t}>`),
  ...THINK_TAGS.map((t) => `<${t} `),
  ...THINK_TAGS.map((t) => `◁${t}▷`),
  // Every harmony structural token, not just the analysis opener. A half-arrived '<|channel|>fina'
  // must be held too: released early, the delimiter alone gets cleaned and the bare word 'final' welds
  // onto the answer. Holding until the token completes lets it be matched or cleaned atomically.
  '<|channel|>analysis<|message|>',
  '<|channel|>commentary<|message|>',
  '<|channel|>final<|message|>',
  '<|start|>assistant<|channel|>final<|message|>',
  '<|start|>',
  '<|end|>',
  '<|return|>',
  '<|message|>',
  '<|constrain|>'
]

/** Longest partial opening we might need to hold back — driven by the longest literal in
 *  OPEN_PREFIXES (harmony's '<|channel|>commentary<|message|>' is the big one). Caps the hold-back so a
 *  stray '<' in ordinary prose can never buffer without bound; anything longer is released by flush(). */
const MAX_PARTIAL = Math.max(...OPEN_PREFIXES.map((p) => p.length))

/** Could `tail` still grow into one of the opening forms (or a closing one)? */
function couldStillOpen(tail: string): boolean {
  const t = tail.toLowerCase()
  // A live prefix of any known opening: '<', '<thi', '◁th', '<|chan', …
  if (OPEN_PREFIXES.some((p) => p.toLowerCase().startsWith(t))) return true
  // Attribute form: '<think foo="bar"' stays ambiguous until its '>' arrives.
  if (THINK_TAGS.some((n) => t.startsWith(`<${n} `)) && !t.includes('>')) return true
  // Closing forms matter too — emitting half of '</think>' would print a stray fragment.
  const closers = [...THINK_TAGS.map((n) => `</${n}>`), ...THINK_TAGS.map((n) => `◁/${n}▷`)]
  if (closers.some((p) => p.toLowerCase().startsWith(t))) return true
  // Answer wrappers are unwrapped rather than stripped, but a HALF-arrived one must still be held or
  // '</out' would print before 'put>' completes it.
  const wrappers = ANSWER_WRAPPERS.flatMap((n) => [`<${n}>`, `<${n} `, `</${n}>`])
  if (wrappers.some((p) => p.toLowerCase().startsWith(t))) return true
  return false
}

/**
 * How much of `s`'s tail must be withheld because it could still grow into an opening tag.
 * Returns 0 when nothing is ambiguous, so the common case emits the whole chunk immediately.
 */
function ambiguousTailLength(s: string): number {
  const from = Math.max(0, s.length - MAX_PARTIAL)
  // LEFTMOST live candidate wins, so the scan runs forward. Scanning backwards and returning at the
  // rightmost one released everything before it — with '<|channel|>analysis<|' that meant emitting the
  // in-progress header and keeping only the trailing '<|', so the opener was never matched and the
  // whole reasoning block leaked. Whatever is held here is released by flush() regardless, so holding
  // too much only ever costs a little latency; holding too little loses the tag.
  for (let i = from; i < s.length; i++) {
    const ch = s[i]
    if (ch !== '<' && ch !== '◁') continue
    if (couldStillOpen(s.slice(i))) return s.length - i
  }
  return 0
}

/**
 * Stateful, streaming think-tag filter. One instance per answer stream (they carry position state,
 * so they are never shared across requests).
 */
export class ThinkStripper {
  private buf = ''
  private inThink = false
  private emittedAny = false
  /** What the current unterminated think block has swallowed — released by flush() only if nothing
   *  real was ever emitted, so a truncated reasoning stream still shows the user something. */
  private withheld = ''

  /** Feed one delta; returns the text that is safe to show (possibly ''). */
  push(chunk: string): string {
    this.buf += chunk
    let out = ''

    for (;;) {
      if (this.inThink) {
        const close = CLOSE_RE.exec(this.buf)
        if (!close) {
          // Still thinking — hold everything. Keep only a bounded tail: the rest can never contain a
          // close tag any more, so retaining it would grow memory for a long reasoning dump.
          this.withheld += this.buf.slice(0, Math.max(0, this.buf.length - MAX_PARTIAL))
          this.buf = this.buf.slice(Math.max(0, this.buf.length - MAX_PARTIAL))
          break
        }
        this.withheld += this.buf.slice(0, close.index)
        this.buf = this.buf.slice(close.index + close[0].length)
        this.inThink = false
        continue
      }

      const open = OPEN_RE.exec(this.buf)
      if (open) {
        out += this.buf.slice(0, open.index)
        this.buf = this.buf.slice(open.index + open[0].length)
        this.inThink = true
        continue
      }

      const hold = ambiguousTailLength(this.buf)
      out += this.buf.slice(0, this.buf.length - hold)
      this.buf = this.buf.slice(this.buf.length - hold)
      break
    }

    // Harmony leaves bare <|…|> scaffolding around the answer even once the analysis block is gone.
    out = out.replace(HARMONY_NOISE_RE, '').replace(WRAPPER_RE, '')
    // A stripped think block usually leaves the answer starting on blank lines. Trim only while
    // nothing real has been shown yet, so whitespace INSIDE the answer is never touched.
    if (!this.emittedAny) out = out.replace(/^\s+/, '')
    if (out) this.emittedAny = true
    return out
  }

  /**
   * End of stream. Releases any held-back tail, and — only when the answer would otherwise be empty —
   * the contents of an unterminated think block, so a truncated reasoning stream never renders blank.
   */
  flush(): string {
    // While inThink, `buf` holds the bounded tail of the THINKING (kept only so a close tag split
    // across chunks could still be matched) — never answer text. Emitting it unconditionally leaked
    // the last few words of an unterminated thought. Release it only to avoid a blank answer, and
    // then release the whole withheld block rather than just its tail.
    let out: string
    if (this.inThink) {
      out = this.emittedAny ? '' : this.withheld + this.buf
    } else {
      out = this.buf
    }
    this.buf = ''
    this.withheld = ''
    this.inThink = false
    out = out.replace(HARMONY_NOISE_RE, '').replace(WRAPPER_RE, '')
    if (!this.emittedAny) out = out.replace(/^\s+/, '')
    if (out) this.emittedAny = true
    return out
  }
}

/** Convenience for non-streaming callers (a whole response at once). */
export function stripThinking(text: string): string {
  const s = new ThinkStripper()
  return s.push(text) + s.flush()
}
