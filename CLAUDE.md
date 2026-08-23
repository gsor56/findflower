FindFlower Human-Centered UI & Code Guidelines (De-AI Standard)
All changes to the FindFlower codebase must favor clarity, pragmatism, and a handcrafted feel. Follow these strict, actionable rules to avoid “generic AI” design tropes.

1. Code Preservation & Pragmatism (No Unnecessary Refactoring)
Never refactor working code without request: If a function works, leave it as-is (Open/Closed Principle: “Invoice is closed to modification, open to extension”). Instead of rewriting, extend by adding new code.
Surgical fixes only: Limit changes to the minimal files/lines required. Don’t rewrite large portions of code to fix a small bug or implement a small feature.
Respect existing style: Match the project’s conventions (plain JS, no frameworks, direct DOM APIs). Vanilla JS is extremely efficient (as one developer notes, “highly optimized VanillaJS will always be faster than any framework. Period.”). Avoid adding heavy libraries or custom state managers unless absolutely needed.
Avoid over-engineering: Implement only what’s required now (YAGNI principle). Don’t preemptively build complex abstractions or factories for simple tasks. Keep code as direct and simple as possible – focus on current requirements.
KISS and “code first, comment later”: Write simple, clear logic so that minimal comments are needed. If code is hard to explain, consider refactoring it rather than commenting obvious steps.
2. Visual & Aesthetic Rules (No “AI SaaS” Look)
Shape & Geometry
Subtle corner radii: Use small rounding on UI elements (e.g. Tailwind’s rounded-md ~4–6px for buttons, rounded-lg ~8px for containers). Reserve fully rounded (“pill”) shapes for special cases like tags or badges. Don’t make every element an oversized pill.
Avoid nested tinted boxes: Don’t stack slightly-different shaded panels inside each other. Instead, use flat, high-contrast surfaces (e.g. white/light backgrounds with 1px neutral borders). This flattens the UI and reduces clutter. As a UX expert advises, remove extra “card” elevations to avoid “cards on cards” and visual clutter. A flat approach reads as more polished and human.
Colors, Lighting & Effects
No glassmorphism or translucency: Avoid frosted-glass panels or heavy blur effects. Glassmorphic UIs (translucent blurred cards) can hurt readability and accessibility, so use them only where they truly add utility (e.g. VR overlays), not in basic app menus or modals.
No neon/glow effects: Steer clear of bright glowing borders, neon gradients, or animated glows. Such flashy effects may look trendy but typically feel gimmicky. They also often violate color-contrast best practices. For example, glowing outlines on hover usually reduce text readability and can strain the eye. Use simple shadows or subtle highlights instead.
No dark blob backgrounds: Avoid amorphous blurred color blobs or radial gradients behind the UI. These were trendy (the “Blob” design fad in 2017) but often add unnecessary decoration. In fact, designers warn that many blob designs are “arbitrary, unnecessary and at times complicate the UI”. Stick with clean solid or gradient backgrounds that align with brand palette.
No generic illustration art: Do not use flat cartoon “Corporate Memphis” illustrations or stock vectors. As Wired reports, this style has led to “massive homogenization and dulling down of the internet’s visual culture,” and many designers call it “pretty lazy”. Instead use real photos or purpose-built graphics that fit the app’s personality, if any illustration is needed at all.
Typography & Icons
Strict Tailwind sizing: Use only the standard Tailwind font sizes (text-xs, text-sm, text-base, etc.) and weights (font-normal, font-medium, etc.). Tailwind’s docs show the fixed values (e.g. text-xs = 0.75rem, text-sm = 0.875rem). Do not use arbitrary font-size hacks or sub-pixel values. Likewise, use the defined weight classes (e.g. font-medium = 500, font-semibold = 600). Avoid any custom hacks like text-[0.62rem] or font-[550].
Icon discipline: Only include icons where they clarify meaning. Icons should have a standard, easily recognized purpose (e.g. a magnifying glass for search, an “X” for close). Don’t add icons next to every header, button, or menu item—text labels alone are usually clearer. Nielsen Norman points out that if an icon’s meaning isn’t obvious, it becomes “mere eye candy — confusing, frustrating… visual noise” that hinders the user. If you do use an icon, accompany it with a text label. Otherwise, stick with text-only buttons and menus for a cleaner, more human feel.
3. UX Integrity & Anti-Bluffing
No fake or dummy controls: Every visible button, toggle, or filter must be fully functional. Do not add UI elements just to make the app look feature-rich. For example, don’t show an accuracy meter, or non-functional “Insights” or “Coming Soon” sections. Research shows that using vague or dummy vocabulary undermines user trust, and lying with the interface will quickly erode confidence. As one UI expert notes, a fake progress indicator is literally “lying to the user… leaving the user with a false expectation”. We must avoid that deception. If a feature isn’t implemented, omit it from the UI entirely rather than showing a greyed-out or “soon” placeholder.
No dead links: Do not include <a href="#"> placeholders. Every link should point to a real location. If a page or feature isn’t ready, remove it from navigation entirely.
No gratuitous utility widgets: Do not clutter the interface with unrelated widgets like live clocks, battery indicators, or auto-displayed weather/geo data. Only show those if the user explicitly requests or enables them. Otherwise they feel irrelevant and gimmicky. For instance, do not trigger the browser geolocation API on page load; ask the user to tap a “Get Location” button first. Unsolicited prompts (e.g. location, camera, etc.) should never fire without direct user action.
4. Copy & Language
Direct and clear wording: Write UI text (labels, buttons, headings) in plain language that tells the user exactly what it does. Use short phrases like “Saved scans”, “Export data”, “Delete record”, “Species details” – functional and specific.
Avoid hype and buzzwords: Never use marketing fluff or AI clichés in copy. Phrases like “Unleash your journey”, “Seamlessly manage insights”, “game-changer” or “revolutionary workflow” should be removed. Nielsen Norman advises to “express yourself plainly and simply… [and] weed out vague jargon and complicated words”. Similarly, studies show that using inflated or vague terminology actually undermines trust. In short, write as if you’re calmly explaining to a friend what each feature does.
Cut filler and hype: Remove empty intensifiers (e.g. “very”, “extremely”) and business jargon (“synergy,” “empower,” “leverage” etc.). If a buzzword is present, replace it with a straightforward synonym or remove it. (For example, NN/g suggests replacing “utilize” with “use,” and dropping needless qualifiers.) Keep the tone helpful, honest, and human-friendly.
5. Code Cleanliness & Documentation
No big banner comments or separators: Don’t add framed headers, ASCII-art dividers, or banner blocks in code. They just take up space. For example, avoid multi-line “==========” or big headers like you might see in autogenerated docs. They tend to become outdated and are rarely maintained.
Comment only complex rationale: Write code that’s self-explanatory whenever possible. As Jeff Atwood advises, “write your code as if comments didn’t exist,” so that the logic is already clear. Only add comments when something isn’t obvious – e.g. explaining why a browser workaround is needed, or the intention behind a tricky algorithm. In other words, comments should explain why the code does something nonstandard, not what it does (the code already shows that).
Avoid trivial comments: Don’t write comments for the obvious (e.g. // increment i, // set flag to true). If the code itself is clear (like i++ or isOpen = true), a comment is redundant. If you feel compelled to comment such lines, consider refactoring: perhaps give a variable a clearer name or extract a function (e.g. finalizeSubmission()).
Document unique decisions: Use comments to note non-obvious decisions – for example, a bug workaround for a specific browser, why a timeout is needed, or the reason a legacy data migration is implemented. These “why” comments help future devs understand design decisions.
6. FindFlower Architecture & Data Rules
Vanilla Stack: The app uses pure HTML, Tailwind CSS (via app.css), and vanilla ES6 JavaScript modules. We explicitly do not use React, Vue, or any bundler/build-tool pipelines. This keeps the app lean and straightforward.
Storage & State: All persistent data belongs in storage.js (IndexedDB “findflower” database). Do not spread data across other sources. Treat storage.js as the single source of truth for user data (scans, saved plants, etc.).
Compute stats dynamically: Any totals or stats (like streaks, scan counts, species counts) should be calculated from the stored records on-the-fly. Don’t hardcode or cache these counts, because they can change when records are deleted or edited. Recompute them after any data change to ensure accuracy.
Handle missing fields gracefully: Some older (legacy) database records might lack optional properties. In those cases, show the field as simply empty in the UI. Never display “0” or the text “null” for missing text fields (just leave it blank or hide the label).
Router compatibility: Every page must include the data-ff-page attribute. Ensure that all pages work whether loaded directly by URL or by the client-side router (nav.js). In other words, deep linking to any page should work without error.
QA harness first: After making changes, always test them against the FindFlower QA harness (ffqa-harness) before considering the work done. This automated suite will catch regressions and ensure architecture rules are followed.


TIPS THAT ALSO MUST BE FOLLOWED
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