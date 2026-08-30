---
name: react-bits
description: Use React Bits when building or polishing animated UI in this Next.js/React application. Prefer TypeScript + Tailwind variants and install components on demand from the configured @react-bits registry. Use sparingly for high-value motion and interaction, not as a replacement for the core design system.
---

# React Bits UI Skill

Use React Bits for polished animated UI elements, backgrounds, transitions, loading states, cards, steppers, and agent activity surfaces.

## Project defaults

- Framework: Next.js App Router
- React: 19+
- Language: TypeScript
- Styling: Tailwind CSS v4
- React Bits variant: `TS-TW`
- Registry alias: `@react-bits`
- Registry URL is configured in the repository root `components.json`.

## Installation pattern

Install only the component needed for the current task. Do not install the full React Bits library.

Preferred command:

```bash
npx shadcn@latest add @react-bits/<ComponentName>-TS-TW
```

Example:

```bash
npx shadcn@latest add @react-bits/BlurText-TS-TW
```

If the CLI cannot be used, retrieve the React Bits TS-TW source and vendor the component into the project with its required dependencies.

## Usage guidance

Use React Bits primarily for:

- Agent status and execution feedback
- Step-by-step workflow visualization
- Meeting/PM agent cards
- Animated lists and activity feeds
- Loading and progress states
- High-value hover/focus interactions
- Lightweight page/background motion
- Entry/exit and reveal transitions

Avoid excessive motion. Standard controls, forms, dialogs, tables, menus, navigation, and accessibility-critical primitives should continue to follow the project's existing UI patterns unless there is a concrete reason to replace them.

## Enterprise UX rules

- Preserve keyboard navigation and visible focus states.
- Respect reduced-motion preferences where practical.
- Avoid decorative animation that obscures state, blocks interaction, or increases cognitive load.
- Prefer subtle motion suitable for an enterprise AI product.
- Keep runtime dependencies minimal and review any new dependency before adding it.
- Do not add external runtime network dependencies; components must work from bundled source and local dependencies.

## Selection heuristic

For this project, good first choices include components equivalent to:

- Spotlight Card for agent/skill cards
- Stepper for workflow phases
- Animated List for agent activity
- Fade Content / Animated Content for result transitions
- Subtle background effects only on prominent landing or empty states

When asked to improve a screen, first decide whether motion materially improves comprehension or perceived responsiveness. If not, use the existing project UI instead of React Bits.

## Source

Official project: `DavidHDev/react-bits` on GitHub.
Official registry: `https://reactbits.dev/r/{name}.json`.
