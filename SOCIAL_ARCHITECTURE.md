FindFlower Social & Ecosystem Architecture
This document is the strict master blueprint for the FindFlower Social Expansion. It must be read before proceeding with any implementation in this phase to prevent context loss, ensure strict UI consistency, and safeguard device performance.

1. Core Principles (De-AI & Honesty)
Strict Visual Discipline: Enforce the rules in CLAUDE.md. There will be zero bubbly UI; use only rounded or rounded-sm. Maintain tactile surfaces (#FCFCFC), crisp neutral borders (border-neutral-200), and sage typography.
No Hallucinated UI: Every single metric, button, and indicator must be wired to real, functional data. Never create a UI element that suggests a feature that does not exist in the code.
Honest Copy: No marketing buzzwords or corporate startup language.

2. Data Limits & Device Performance (Crucial)
DOM Virtualization (The "Doomed Phone" Fix): The UI must never render thousands of list items or chat messages in the DOM at once. Chat feeds, community grids, and search results MUST use virtualized scrolling (only rendering the DOM nodes currently visible in the viewport) to prevent mobile thermal throttling and browser crashes.
Cache vs. Truth (The Storage Limit Fix): IndexedDB is strictly a Local Cache, not the ultimate source of truth. It will locally store only the 100 most recent messages or community posts.
Data Eviction: If the browser or OS arbitrarily wipes IndexedDB storage to save space, the local architecture must fail gracefully and prepare to re-sync missing historical data from the backend when needed. Older data must be paginated and fetched from the server only when requested.

3. The Browser Memory Strategy (IndexedDB Schemas)
To prototype locally before connecting a live backend, we will use storage.js (Storage v3) to manage the following schemas:
ff_users: User profiles, bios, privacy settings, and compressed Base64 avatars.
ff_posts: Community articles, forum threads, timestamps, and appreciate counters.
ff_friends: Status of user relationships (e.g., pending, accepted, blocked).
ff_messages: Local cache for global and direct chat logs.

4. Feature Specifications
Universal Search (Dashboard Command Palette): Dual-indexing logic. A single search bar that queries both the botanical taxonomy dataset (e.g., Rosa) and the user profile directory (e.g., gsor56). Supports quick-action focus (e.g., Ctrl+K).
Article & Community Engine:
Refactor blogs.html into a masonry index grid.
Add article.html for deep reading of markdown content.
Build a "Discuss in Community" handoff pipeline to bridge articles to the forum.
Public Profiles: Display custom avatars, current streak, top identified species, and a public friends list (subject to privacy settings).
Achievements: Mathematical badge unlocking triggered by explicit database thresholds (e.g., "Seedling" for 1 scan, "Nightshade" for a scan between 22:00 and 04:00, "Social Butterfly" for 5 friends).
Settings & Privacy: Controls for profile visibility (Public/Private), comprehensive data export (including social history), and complete account deletion.
Moderation: A concrete data payload structure for User Reporting and Blocking.

5. The Two-Tier Chat System
Global Chat: A unified, real-time public feed where the community can share field notes and scans.
Direct Chat (chat.html): 1-on-1 private messaging locked securely behind mutual friend acceptance.

6. Backend Handoff Plan
The local IndexedDB frontend is a prototype. The final implementation will sync these local schemas with a Node.js/Express WebSocket server hosted on our existing Render CPU.
Due to Render's ephemeral storage, the Render CPU will act only as the compute and routing layer. It will be backed by a persistent external database (e.g., PostgreSQL via Neon or MongoDB Atlas) as the ultimate Source of Truth.
