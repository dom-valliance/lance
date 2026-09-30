# Web learnings

### [2026-09-25] Reproduce a reference animation's loop as well as its look

**Context**: Dom pointed at the Wired "weight of the internet" header as the reference for a sign-in animation. The header cycles through ASCII pictures. I built a one-way robot-to-star morph that stopped on the star.
**Correction**: Dom asked for it to cycle continuously: robot, star, robot, and on.
**Rule**: When a reference is given, copy its timing behaviour as well as its visuals: whether it loops, holds, reverses or plays once. If the reference loops, loop unless Dom says otherwise. State the timing (hold, morph, cycle length) in the handover.
**Applies to**: apps/web, any animation built from a reference

### [2026-09-30] Ask where spare width goes before capping a layout

**Context**: Dom asked for the page content to stop at 1440px on desktop. I centred the capped column in the space beside the sidebar and asked only whether the cap should cover the sidebar too.
**Correction**: Dom wanted the content left-aligned against the navigation, with the spare width on the right.
**Rule**: A width cap forces a choice about where the leftover space goes: left-aligned, centred or right. In a sidebar app, align against the navigation by default. If the designs do not show a viewport wider than the cap, state the choice in the handover and offer the alternative.
**Applies to**: apps/web layout, any max-width change
