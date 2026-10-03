import { z } from 'zod'

export const RecapExportSchema = z.object({
  title24: z.string(),
  tags: z.array(z.string()),
  overview: z.string(),
  topics: z.array(z.string()),
  keyQA: z.array(z.string()),
  decisions: z.array(z.string()),
  actionItems: z.array(
    z.object({
      text: z.string(),
      owner: z.string().nullable(),
      // Best-effort trailing "by <phrase>" as literally stated (e.g. "Friday", "June 5") — NOT parsed
      // into a date (RECAP_PROMPT only asks the model for "an owner when stated", never a structured
      // date). Shown in the "Book next steps" review UI and folded into the task description; never sent
      // as a structured due-date wire field, since neither ClickUp's nor Plane's exact optional argument
      // names for a due date are confirmed (see main/mcp/mcpClient.ts's header comment).
      dueDateText: z.string().nullable()
    })
  ),
  openQuestions: z.array(z.string()),
  notableQuotes: z.array(z.string()),
  markdown: z.string()
})
export type RecapExport = z.infer<typeof RecapExportSchema>
