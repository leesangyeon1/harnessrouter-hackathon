# Interface contract

Harness gives a customer one readable view of their financial picture and spending, with paper investing clearly separated from bank data. The desktop layout uses a quiet sidebar, warm gray canvas, white panels, coral primary actions and restrained green finance accents. It borrows the approachable personal-finance dashboard vocabulary requested by the owner; branding, copy, SVG charts and component styling are original. No Rocket Money logo, private assets or account data were copied.

Hierarchy: page purpose first, one primary action, clear numeric summaries, then supporting categories and activity. System fonts, tabular numbers and restrained borders keep dense financial content readable. Desktop has two-column panels; mobile stacks content and uses a dismissible navigation drawer. Long tables scroll inside a labelled keyboard-focusable region, not the page. Dialogs use native focus containment and Escape handling. Focus rings, a skip link, labelled controls, reduced-motion behavior and text alternatives accompany charts and icon actions. Color is never the only status signal.

Target captures: 1440×1000 desktop and 390×844 mobile. Automated axe checks cover every customer destination and the authenticated mobile operations view; browser tests cover keyboard dialog closure, navigation, state changes and overflow. This is automated and rendered review evidence, not a full assistive-technology certification.

Content states remain distinct. Synthetic preview is always labelled. Loading preserves context; an empty spending report offers connection; provider failures offer retry; partial live data shows unknowns rather than sample figures. Successful reads show the report's calculation time. Operations denies access at the server when roles are unavailable or removed. Missing backend surfaces explain availability without inventing a numerical result or enabling privileged actions.

See [`evidence/report.json`](evidence/report.json) and its rendered screenshots for observations. Financial figures in these captures come only from synthetic preview data or local HTTP fixtures.

The delegated [official reference brief](REFERENCES.md) records the public design/auth/hosting sources and their limits. Rocket Money marketing images do not establish a verified current desktop release or supply our fixtures.
