# Web learnings

### [2026-09-25] Reproduce a reference animation's loop as well as its look

**Context**: Dom pointed at the Wired "weight of the internet" header as the reference for a sign-in animation. The header cycles through ASCII pictures. I built a one-way robot-to-star morph that stopped on the star.
**Correction**: Dom asked for it to cycle continuously: robot, star, robot, and on.
**Rule**: When a reference is given, copy its timing behaviour as well as its visuals: whether it loops, holds, reverses or plays once. If the reference loops, loop unless Dom says otherwise. State the timing (hold, morph, cycle length) in the handover.
**Applies to**: apps/web, any animation built from a reference
