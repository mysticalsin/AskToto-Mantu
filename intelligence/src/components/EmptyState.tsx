/**
 * The page a view shows before the brain has anything to show.
 *
 * People and Accounts both used to collapse to a single grey sentence on an otherwise black page —
 * no heading, no explanation of what the page is for, no way to tell "nothing yet" apart from
 * "something broke". A first-run install therefore had two views that looked like a rendering bug.
 *
 * This keeps the page's own identity (its heading and standfirst render exactly as they do when
 * populated) and adds one specific sentence about how records actually get here. Two call sites, which
 * is why it is a component rather than a copied block.
 */
interface Props {
  /** The view's own h1 — identical to the populated state, so the page never loses its identity. */
  title: string
  /** The view's standfirst, also identical to the populated state. */
  standfirst: string
  /** What is missing, in the user's words. */
  headline: string
  /** How records get here. Specific to this product, never generic encouragement. */
  body: string
}

export function EmptyState({ title, standfirst, headline, body }: Props) {
  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-white/95">{title}</h1>
      <p className="mt-1 text-sm text-white/50">{standfirst}</p>

      <div className="mt-6 max-w-2xl rounded-xl border border-white/10 bg-white/[0.03] px-5 py-6" role="status">
        <p className="text-sm font-medium text-white/80">{headline}</p>
        <p className="mt-2 text-sm leading-relaxed text-white/50">{body}</p>
      </div>
    </div>
  )
}
