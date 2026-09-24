# Web UI design

The Lance web UI is built from a Claude Design package produced against [claude-design-brief.md](claude-design-brief.md). The package lives in the Claude Design project "Design preparation questions" (project id `97f554c6-766f-40e0-b2ec-4da9ae86675d`) as one HTML file per page plus a foundations sheet and an index. Read it through the `DesignSync` tool in Claude Code (`list_files`, then `get_file` on a page) rather than copying the HTML into the repository; the files are large and the project is the source of truth for the visuals.

## What the package decided

The index page of the package records ten decisions that changed the existing build. The ones that matter to anyone editing the app:

- One accent, Valliance peach `#F3A982`: links, the active nav bar, pending rows, the focus ring at 45% alpha and the pending count. It replaces the grey ring and the unused sidebar blue.
- The base greys stay as the shadcn oklch scale. Destructive button text is the page background, not white, to reach AA on the salmon fill.
- Six semantic hues (blue, pink, peach, teal, green, red) plus neutral, each as fill, text and hairline. Every status, system, severity, decision and watcher state maps to one of them in `apps/web/src/lib/tones.ts`. Every badge carries a text label; colour is never the only signal.
- Page titles sit on the canvas; filters and tables are the cards.
- Enum values are humanised everywhere the reader sees them (`apps/web/src/lib/humanise.ts`); the raw value stays in URLs and forms.
- Expiry and due dates show a relative form with the absolute time beside it (`apps/web/src/lib/time.ts`, `apps/web/src/lib/ageing.ts`).
- Ledger trails and status histories are timelines. Failures are inline `role="alert"` text under the form that failed, never a toast; loading is a skeleton, never a page spinner.
- Below 1024px the sidebar becomes a 56px top bar with a drawer; hit targets are 44px.
- The reversed wordmark is the supplied JPEG with an invert and screen blend. A vector should replace it; the star mark path is in `apps/web/src/components/shell/star-mark.tsx`.

## Where the pieces live

| Design element | Code |
|---|---|
| Token sheet | `apps/web/src/app/globals.css` |
| Semantic tone mappings | `apps/web/src/lib/tones.ts` |
| Labels for enums, id shortening | `apps/web/src/lib/humanise.ts` |
| Relative and London times | `apps/web/src/lib/time.ts`, `apps/web/src/lib/ageing.ts` |
| Buttons, badges, fields | `apps/web/src/components/ui/` |
| Page header, filter pills, tables, timeline, provenance, ageing, empty and failure states | `apps/web/src/components/` |
| Shell: sidebar, top bar, drawer, paused banner | `apps/web/src/components/shell/` |

Alerts, Ontology, Policies and Agents are not in this package; the index marks them as the next pass. Their pages carry the spec's description until then. Admin (package 5.6, `apps/web/src/app/admin`) has no design either and is built from the components above.
