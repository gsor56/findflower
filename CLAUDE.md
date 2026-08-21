FindFlower Engineering & Human UI Guidelines (De-AI Standard)

This document contains mandatory guidelines for all AI agents, sub-agents, and contributors working on the FindFlower codebase. Its primary goal is to eliminate obvious "AI-generated" design and code tropes, enforce tactile human engineering, and protect working code from unnecessary rewrites.

1. Code Preservation & Pragmatism (NO Unsolicited Refactoring)

Do NOT "Clean" or Rewrite Working Code: Never refactor, reformat, or "sanitize" surrounding working code unless explicitly requested. If a function works, leave its style, variable names, and structure intact even if it feels "messy."

Surgical Changes Only: Limit code modifications strictly to the files, functions, and lines needed to fulfill the request. Do not rewrite whole files to fix a 5-line feature.

Respect Existing Code Style: Mirror the existing project conventions (vanilla JS, native DOM APIs, inline state, explicit parameter passing). Do not introduce modern framework abstractions (e.g., custom state engines, signal libraries, virtual DOMs) where plain Web APIs suffice.

No Over-Engineering: Write pragmatic, direct code. Avoid creating 3 layers of wrapper functions for simple operations (e.g., a simple fetch or localStorage.getItem does not need an abstract StorageAdapterFactoryService).

2. Visual & Aesthetic Rules (Banning the "AI SaaS Vibe")

Shape & Geometry

No Universal Pill Shapes / Excessive Rounding: Do NOT make every single element rounded-2xl, rounded-3xl, or rounded-full.

Buttons and inputs: Use subtle, crisp radii (rounded-md / 4px–6px).

Containers and cards: Use sharp or slightly softened corners (rounded-lg / 8px).

Reserve pill shapes (rounded-full) exclusively for tags or badges where structurally necessary.

No Container Inception: Avoid nesting boxes inside boxes inside boxes with slightly different background tints. High-contrast white/light surfaces (#FCFCFC) with clean 1px neutral borders (border-neutral-200) look significantly more human than multi-tinted stacked cards.

Colors, Lighting, & Effects

NO Generic AI Tropes:

NO Glassmorphism: Ban backdrop-blur and translucent cards on menus, navbars, and modal backgrounds for basic UI.

NO Glowing Borders / Neon Gradients: Ban indigo-to-purple, cyan-to-pink, or neon glowing hover outlines (shadow-[0_0_15px_rgba(...)]).

NO Dark Radial Blob Backgrounds: No floating blurred colored circles (bg-gradient-to-r from-purple-500 to-indigo-500 blur-3xl opacity-20).

NO "Corporate Memphis" Vector Art: Do not use generic multi-colored flat human vector graphics or floating 3D isometric cubes.

Typography & Icons

Strict Tailwind Design Scale: Stick to standard Tailwind scale values (text-xs, text-sm, text-base, font-normal, font-medium, font-semibold). Never invent arbitrary sub-pixel sizes (e.g., text-[0.62rem]) or weight hacks (font-[550]).

Icon Discipline (No Icon Spam): Do NOT place an icon next to every single piece of text, header, button, or menu item. Icons should only exist where they clarify action intent (e.g., close buttons, search bars). Text-only design is cleaner and feels far more human.

3. UX Integrity & Anti-Bluffing

Zero Fake UI / Unbacked Controls:

Every button, toggle, filter, or setting MUST have a corresponding read/write path in code (e.g., writing to storage.js or localStorage).

NEVER add "dummy" settings switches, fake "Accuracy Score" meters, or non-functional filter dropdowns to make the UI look "feature-rich."

No Dead Links or "Coming Soon" Badges: Never render href="#" links or attach "Coming Soon" pill tags. If a feature or page does not exist, omit it entirely from the UI.

No Fake Utility Widgets: Do NOT embed live digital clocks, unsolicited browser geolocation triggers, or battery indicators into navigation menus or drawers.

No Unsolicited Sensor Prompts: Never trigger navigator.geolocation.getCurrentPosition() automatically on menu opens or page loads. Location must be explicitly requested by user action.

4. Copywriting (Writing Human Language)

Direct, Calm, & Functional Copy: Use natural, concise language. Tell the user exactly what a feature does.

Good: "Saved identifications", "Export dataset", "Delete scan", "Species details".

Bad (AI Buzzwords): "Unleash your botanical journey", "Empower your natural discovery", "Seamlessly manage insights", "Elevate your workflow", "Delve into nature".

No AI Tell Phrases: Avoid words like "Delve", "Seamless", "Supercharge", "Cutting-edge", "Game-changer", "Revolutionary", "Harness".

5. Code Cleanliness & Documentation

No Banner Comments or ASCII Art:

Ban: /* =================================================== */

Ban: // ------------------ EVENT HANDLERS ------------------

No Self-Evident Comments: Do not write comments that describe obvious syntax.

Ban: // Set variable to true

Ban: // Function to handle button click

Only Document Non-Obvious Decisions: Comments should only exist to explain why something complex was done (e.g., workaround for a Safari browser quirk, IndexedDB migration logic, or specific timing threshold).

6. FindFlower Architectural Ground Rules

Vanilla Stack: Pure HTML, Tailwind CSS / app.css, Vanilla JS (ES6 modules), native Web Components / helper modules. No React, Vue, Build tools, or Webpack.

Storage & State: storage.js is the single source of truth for user data (IndexedDB findflower database).

Stat totals (streaks, scan counts, species counts) must be calculated dynamically from valid stored records, especially after deletions.

Missing optional fields in legacy database records (e.g., missing alternatives or location) must be rendered cleanly as absence, NEVER as zero or null text.

Router Compatibility: All app pages must include data-ff-page markup attributes and work cleanly when loaded directly via document URL or swapped client-side via nav.js / router.

Test Harness First: Always execute and verify changes against the local QA harness test suite (..\ffqa-harness) before declaring work complete.