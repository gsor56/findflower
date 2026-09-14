// EJS-backed server-side rendering for the migrated public pages.
//
// The page bodies stay in their original HTML files so the static build and the
// server render are the same document. EJS owns the response, and the server
// injects the two things the browser used to fetch for itself:
//
//   1. Auth0 state, read from the express-openid-connect session instead of the
//      SPA SDK. The client-side auth tags are stripped on the way out, because a
//      second login flow on the same page fights the session cookie.
//   2. The first page of social data, rendered into the list containers, so
//      /community, /notifications and /chat paint without a spinner.
//
// Nothing here trusts the payload. Every value that reaches the document goes
// through escapeHtml, and the JSON bootstrap escapes `<` so a display name can
// never close the script element it sits inside.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import ejs from 'ejs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');
// Development: /repo/server/lib -> frontend at /repo, views at /repo/server/views.
// HidenCloud:   /lib             -> frontend at /,     views at /views.
const ROOT = existsSync(path.join(SERVER_ROOT, 'index.html'))
    ? SERVER_ROOT
    : path.resolve(SERVER_ROOT, '..');
const VIEWS = path.join(SERVER_ROOT, 'views');

/**
 * Page name -> source file, relative to the repository root.
 *
 * Every navigable page is here, not just the ones whose content the server
 * happens to fetch. A page that renders client-side is still a page the server
 * must serve: if it is missing from this map the route cannot exist, the
 * request falls through to the 404 handler, and on the way there it used to be
 * answered by GitHub Pages' 404.html -- the static shell that boots the SPA
 * login client and shows a signed-in visitor as signed out.
 */
const PAGES = {
    home: 'index.html',
    api: 'api.html',
    try: 'try.html',
    contribute: 'contribute.html',
    community: 'community.html',
    notifications: 'notifications/index.html',
    chat: 'chat/index.html',
    dashboard: 'dashboard.html',
    profile: 'profile.html',
    about: 'about.html',
    pricing: 'pricing.html',
    how: 'how.html',
    species: 'species.html',
    directory: 'directory.html',
    contact: 'contact.html',
    docs: 'docs.html',
    research: 'research.html',
    data: 'data.html',
    blogs: 'blogs.html',
    releases: 'releases.html',
    privacy: 'privacy.html',
    terms: 'terms.html',
    feedback: 'feedback.html',
    article: 'article.html',
    notFound: '404.html',
};

// Page bodies, keyed by file and held with the mtime they were read at.
const cache = new Map();

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/** JSON that is safe to sit inside a script element. */
function jsonForScript(value) {
    return JSON.stringify(value === undefined ? null : value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

// Read each page once, then revalidate that copy against the file's mtime on
// every render. Caching the body with no expiry meant an upload to a running
// container kept serving the previous document until the process restarted: a
// deploy that looks applied and is not. One stat per render is cheap next to
// the render itself, and the second read only happens when the file changed.
async function pageSource(file) {
    const full = path.join(ROOT, file);
    let stamp;
    try {
        stamp = (await stat(full)).mtimeMs;
    } catch {
        // Missing page: drop the stale copy and let readFile raise the error
        // the caller already handles, rather than serving yesterday's document.
        cache.delete(file);
        return readFile(full, 'utf8');
    }
    const hit = cache.get(file);
    if (hit && hit.stamp === stamp) return hit.text;
    const text = await readFile(full, 'utf8');
    cache.set(file, { stamp, text });
    return text;
}

// The SPA SDK, its wrapper, and the per-page worker override are the three
// things a server session replaces. Left in place the page boots a conflicting
// login state and points social calls at the Cloudflare proxy instead of the
// origin that just rendered it.
const CLIENT_AUTH = [
    /<script\b[^>]*src="[^"]*auth0-spa-js[^"]*"[^>]*>\s*<\/script>\s*/gi,
    /<script\b[^>]*src="\/?auth\.js[^"]*"[^>]*>\s*<\/script>\s*/gi,
    /<script\b[^>]*>\s*if \(location\.hostname[\s\S]*?FF_SOCIAL_API[\s\S]*?<\/script>\s*/gi,
];

function stripClientAuth(html) {
    return CLIENT_AUTH.reduce((acc, re) => acc.replace(re, ''), html);
}

/** Insert markup immediately after an opening tag, so the container keeps its
 *  own attributes and the client can still re-render over the top of it. */
function injectAfter(html, openingTag, markup) {
    const at = html.indexOf(openingTag);
    if (at < 0 || !markup) return html;
    const cut = at + openingTag.length;
    return html.slice(0, cut) + markup + html.slice(cut);
}

function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'FF';
    return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}

function avatar(user, size) {
    const px = size || 36;
    const src = user && user.avatar ? String(user.avatar) : '';
    if (src && /^data:image\//.test(src)) {
        return '<img src="' + escapeHtml(src) + '" alt="" width="' + px + '" height="' + px
            + '" class="rounded-full object-cover border border-black" loading="lazy">';
    }
    return '<span class="inline-flex items-center justify-center rounded-full border border-black bg-[#f2f5f2] text-xs font-medium" style="width:'
        + px + 'px;height:' + px + 'px" aria-hidden="true">' + escapeHtml(initials(user && user.displayName)) + '</span>';
}

function whenLabel(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

function communityFallback(data) {
    const posts = Array.isArray(data.posts) ? data.posts : [];
    if (!posts.length) {
        return '<p class="text-sm text-neutral-500 py-4">No field notes yet. The first post you write shows up here.</p>';
    }
    return posts.map((p) => {
        const author = p.author || null;
        const name = author ? (author.displayName || author.handle) : 'Someone';
        return '<article class="border border-black rounded-none p-4 bg-white mb-3" data-ssr-post="' + escapeHtml(p.id) + '">'
            + '<div class="flex items-center gap-3">' + avatar(author, 36)
            + '<div class="min-w-0"><p class="text-sm font-medium truncate">' + escapeHtml(name) + '</p>'
            + '<p class="text-xs text-neutral-500">' + escapeHtml(author && author.handle ? '@' + author.handle : '')
            + (p.space ? ' in ' + escapeHtml(p.space) : '') + '</p></div>'
            + '<time class="ml-auto text-xs text-neutral-500">' + escapeHtml(whenLabel(p.createdAt)) + '</time></div>'
            + (p.title ? '<h3 class="text-base mt-3">' + escapeHtml(p.title) + '</h3>' : '')
            + '<p class="text-sm leading-relaxed mt-2 whitespace-pre-wrap break-words">' + escapeHtml(p.content) + '</p>'
            + '</article>';
    }).join('');
}

function notificationsFallback(data) {
    if (!data.authenticated) {
        return '<li class="text-sm text-neutral-600">Sign in to see friend requests and messages.</li>';
    }
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) {
        return '<li class="text-sm text-neutral-500 py-3">Nothing new. Requests and messages land here.</li>';
    }
    return items.map((item) => {
        const user = item.user || null;
        const name = user ? (user.displayName || user.handle) : 'Someone';
        const body = item.type === 'friend_request'
            ? '<p class="text-sm mt-2">' + escapeHtml(name) + ' sent you a friend request.</p>'
            : '<p class="text-sm mt-2 whitespace-pre-wrap break-words">' + escapeHtml(item.snippet || '') + '</p>';
        const href = item.type === 'direct_message' && item.href ? item.href : null;
        return '<li class="border border-black rounded-none p-4 bg-white" data-ssr-notification="' + escapeHtml(item.id) + '">'
            + '<div class="flex items-center gap-3">' + avatar(user, 36)
            + '<div class="min-w-0"><p class="text-sm font-medium truncate">' + escapeHtml(name) + '</p>'
            + '<p class="text-xs text-neutral-500">' + escapeHtml(whenLabel(item.createdAt)) + '</p></div>'
            + (href ? '<a class="ml-auto text-xs underline" href="' + escapeHtml(href) + '">Open</a>' : '')
            + '</div>' + body + '</li>';
    }).join('');
}

function titleCase(value) {
    return String(value || '').replace(/(^|\s)(\w)/g, (m, pre, c) => pre + c.toUpperCase());
}

function agoLabel(iso) {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return '';
    const mins = Math.floor((Date.now() - then.getTime()) / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return mins + ' min ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + (hrs === 1 ? ' hour ago' : ' hours ago');
    const days = Math.floor(hrs / 24);
    if (days === 1) return 'Yesterday';
    if (days < 7) return days + ' days ago';
    return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const FLOWER_PATH = 'M12 21c0-4 0-7 0-9m0 0c0-3 2.5-5 6-5-.2 3.2-2.8 5-6 5Zm0 0c0-3-2.5-5-6-5 .2 3.2 2.8 5 6 5Z';

/** One saved find, in the same shape the dashboard's own card renderer uses.
 *  The reader's correction wins over the model's answer, because that is what
 *  the client shows and the two must not disagree about the same record. */
function scanCard(scan) {
    const told = scan.correction && scan.correction.species ? scan.correction.species : scan.species;
    const name = titleCase(told);
    const pct = typeof scan.confidence === 'number' ? Math.round(scan.confidence * 100) + '%' : '';
    const thumb = scan.imageBase64
        ? '<img src="' + escapeHtml(scan.imageBase64) + '" alt="" class="w-full h-full object-cover" loading="lazy">'
        : '<div class="w-full h-full flex items-center justify-center bg-sage-50">'
            + '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" '
            + 'class="text-sage-400"><path d="' + FLOWER_PATH + '"/></svg></div>';
    const inner = '<div class="aspect-square bg-neutral-100 overflow-hidden">' + thumb + '</div>'
        + '<div class="p-3">'
        + '<h3 class="font-medium text-sm text-neutral-900 leading-snug line-clamp-2">'
        + (name ? escapeHtml(name) : '<span class="font-normal text-neutral-400">Not named yet</span>') + '</h3>'
        + '<div class="flex items-center justify-between mt-1.5">'
        + '<span class="text-xs text-neutral-400">' + escapeHtml(agoLabel(scan.timestamp)) + '</span>'
        + (pct ? '<span class="text-xs font-medium text-sage-700 bg-sage-50 px-1.5 py-0.5 rounded">'
            + escapeHtml(pct) + '</span>' : '')
        + '</div></div>';
    return '<article data-scan-id="' + escapeHtml(scan.id) + '" class="group bg-white border border-neutral-200 rounded-lg overflow-hidden">'
        + (name ? '<a href="/species?name=' + encodeURIComponent(name) + '" class="block">' : '<div>')
        + inner
        + (name ? '</a>' : '</div>')
        + '</article>';
}

// The grid ships hidden with the empty state visible beside it, because that is
// the right first paint for a visitor who has never scanned. Rendering rows
// means flipping both: the cards have to be inserted, the container un-hidden,
// and the "your herbarium is empty" panel is a sibling that is visible by
// default, so it would otherwise sit above the finds it says do not exist.
const DASH_GRID = '<div id="recentGrid" class="hidden grid grid-cols-2 lg:grid-cols-3 gap-4"></div>';

function injectDashboardScans(html, data) {
    const scans = Array.isArray(data.scans) ? data.scans : [];
    if (!scans.length) return html;
    const open = '<div id="recentGrid" class="grid grid-cols-2 lg:grid-cols-3 gap-4">';
    let out = html.replace(DASH_GRID, open + scans.map(scanCard).join('') + '</div>');
    out = out.replace('id="recentEmpty" class="', 'id="recentEmpty" class="hidden ');
    return out;
}

function chatFallback(data) {
    if (!data.authenticated) {
        return '<li class="text-sm text-neutral-600">Sign in to open this conversation.</li>';
    }
    if (data.forbidden) {
        return '<li class="text-sm text-neutral-600">Direct messages need an accepted friend request.</li>';
    }
    const rows = Array.isArray(data.messages) ? data.messages : [];
    if (!rows.length) {
        return '<li class="text-sm text-neutral-500 py-3">No messages yet.</li>';
    }
    const meId = data.viewerId || null;
    return rows.map((m) => {
        const author = m.sender || null;
        const mine = !!(author && meId && author.id === meId);
        return '<li data-ssr-message="' + escapeHtml(m.id) + '" class="border border-black rounded-none p-3 '
            + (mine ? 'bg-[#f2f5f2]' : 'bg-white') + '">'
            + '<div class="flex justify-between gap-3"><span class="text-xs font-medium uppercase">'
            + escapeHtml(mine ? 'You' : (author ? (author.displayName || author.handle) : 'User')) + '</span>'
            + '<time class="text-xs text-neutral-500">' + escapeHtml(whenLabel(m.createdAt)) + '</time></div>'
            + '<p class="text-sm leading-relaxed mt-2 whitespace-pre-wrap break-words">' + escapeHtml(m.content) + '</p></li>';
    }).join('');
}

/**
 * Render one page through EJS with the session and the first data page inlined.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {keyof typeof PAGES} page
 * @param {{ session?: object, data?: object, viewerId?: string }} payload
 * @param {number} [status]
 */
export async function renderPage(req, res, page, payload, status) {
    const file = PAGES[page];
    if (!file) {
        res.status(404).type('text/plain').send('Unknown page.');
        return;
    }
    const settings = payload || {};
    const data = settings.data === undefined ? null : settings.data;

    let html;
    try {
        html = stripClientAuth(await pageSource(file));
    } catch {
        res.status(500).type('text/plain').send('Template unavailable.');
        return;
    }

    const boot = '<script>window.__FF_SSR__=' + jsonForScript({
        page,
        auth: settings.session || { authenticated: false, user: null },
        data,
    }) + ';window.FF_AUTH_MODE="server-session";window.FF_SOCIAL_API=location.origin;</script>'
        // The shim stands in for auth.js, which was stripped above. Both are in
        // head and both run before anything under defer.
        + '<script src="/scripts/ssr-session.js"></script>'
        // Injected here rather than added to every page: the live client only
        // means anything on an origin that holds a session, which is exactly the
        // set of pages this function renders. It is deferred and lands last, so
        // the page scripts have registered their listeners before it dispatches.
        + '<script src="/scripts/live.js" defer></script>'
        // The herbarium sync. Both directions are idempotent -- the upload is
        // keyed on the client's own record ids and the download is deduped by
        // them -- so it runs on every rendered page instead of behind a button
        // someone has to remember to press on each of their devices.
        + '<script src="/scripts/sync-scans.js" defer></script>';
    html = html.replace('</head>', boot + '</head>');

    if (page === 'community' && data) {
        html = injectAfter(html, '<div id="cmFeed" class="mt-4">', communityFallback(data));
    } else if (page === 'dashboard' && data) {
        html = injectDashboardScans(html, data);
    } else if (page === 'notifications' && data) {
        html = injectAfter(html, '<ul id="notificationsList" class="space-y-3">', notificationsFallback(data));
    } else if (page === 'chat' && data) {
        html = injectAfter(html, '<ul id="chatMessages" class="space-y-3 my-5" aria-live="polite">',
            chatFallback({ ...data, viewerId: settings.viewerId }));
    }

    let body;
    try {
        body = await ejs.renderFile(path.join(VIEWS, 'page.ejs'), { html }, { cache: false });
    } catch (err) {
        console.error('[ssr] render failed for', page, err.message);
        res.status(500).type('text/plain').send('Render failed.');
        return;
    }

    res.status(status || 200)
        .set('Content-Type', 'text/html; charset=utf-8')
        .set('Cache-Control', 'no-store')
        .send(body);
}

export { escapeHtml };
