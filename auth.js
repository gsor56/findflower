/* ============================================================================
   FindFlower — shared Auth0 authentication (auth.js)
   ----------------------------------------------------------------------------
   Real Auth0 SPA integration. To activate it, create a free Auth0 application
   (type: "Single Page Application") and paste the two values below.

   Auth0 Dashboard → Applications → [your app] → Settings:
     • Domain    → AUTH0_CONFIG.domain    (e.g. dev-ab12cd.us.auth0.com)
     • Client ID → AUTH0_CONFIG.clientId

   Then, in that same Settings page, add these URLs (comma-separated) while
   testing locally on http://localhost:8000 :
     • Allowed Callback URLs : http://localhost:8000/login.html
     • Allowed Logout URLs   : http://localhost:8000/
     • Allowed Web Origins   : http://localhost:8000

   Production needs https://findflower.me/login.html and https://findflower.me/
   in those first two lists respectively.

   Both of those are matched by Auth0 as exact strings, which is why they are the
   two URLs on the site that did NOT move to clean paths when everything else
   did. AUTH0_CALLBACK stays "/login.html": rewriting it to "/login" without
   editing the dashboard first returns callback URL mismatch and no one can log
   in. The logout returnTo did move, to "/", so that entry has to be the bare
   origin with its trailing slash.
   Until both values are filled in, the site runs in "setup required" mode and
   nothing breaks — the login button simply explains what to configure.
   ========================================================================== */

const AUTH0_CONFIG = {
    domain:   "findflower.au.auth0.com",     // e.g. "dev-ab12cd.us.auth0.com"
    clientId: "6L1pckrnAw9csi0ZyHEX1CC3vo1lcgxK",  // e.g. "aBcD1234...."
};

// The single callback page Auth0 redirects back to after login.
const AUTH0_CALLBACK = window.location.origin + "/login.html";
const FF_SESSION_PROFILE_KEY = "ff_session_profile";

function ffCacheSessionProfile(user) {
    if (!user) return;
    try {
        localStorage.setItem(FF_SESSION_PROFILE_KEY, JSON.stringify({
            authenticated: true,
            name: user.given_name || user.nickname || user.name || user.email || "Botanist",
            email: user.email || null,
            picture: user.picture || null,
            sub: user.sub || null,
        }));
    } catch {}
}

// True only once real credentials have been supplied.
const AUTH0_READY =
    !!AUTH0_CONFIG.domain && !AUTH0_CONFIG.domain.startsWith("YOUR_") &&
    !!AUTH0_CONFIG.clientId && !AUTH0_CONFIG.clientId.startsWith("YOUR_");

let _auth0Client = null;

async function ffGetClient() {
    if (!AUTH0_READY) return null;
    if (_auth0Client) return _auth0Client;
    // auth0-spa-js is loaded from the CDN before this script. If that CDN is
    // blocked (corporate proxy, ad blocker, offline in the field) the `auth0`
    // global is simply absent -- so treat it as "no session available" rather
    // than letting a ReferenceError escape into a caller's request path.
    if (typeof auth0 === "undefined" || !auth0 || !auth0.createAuth0Client) return null;
    try {
        _auth0Client = await auth0.createAuth0Client({
            domain: AUTH0_CONFIG.domain,
            clientId: AUTH0_CONFIG.clientId,
            authorizationParams: { redirect_uri: AUTH0_CALLBACK },
            cacheLocation: "localstorage",   // keep the session across page loads
            useRefreshTokens: true,
        });
    } catch (e) {
        console.warn("Auth0 unavailable; continuing as guest.", e);
        return null;
    }
    return _auth0Client;
}

/* Process the ?code&state redirect (only meaningful on login.html). */
async function ffHandleCallback() {
    const client = await ffGetClient();
    if (!client) return false;
    const q = window.location.search;
    if (q.includes("code=") && q.includes("state=")) {
        try {
            await client.handleRedirectCallback();
        } catch (e) {
            console.error("Auth0 callback error:", e);
        }
        window.history.replaceState({}, document.title, window.location.pathname);
        return true;
    }
    return false;
}

/* Start login. `returnTo` is where we send the user after they authenticate. */
async function ffLogin(returnTo) {
    const client = await ffGetClient();
    if (!client) return false;
    if (returnTo) localStorage.setItem("ff_return_to", returnTo);
    await client.loginWithRedirect();
    return true;
}

async function ffLogout() {
    try { localStorage.removeItem(FF_SESSION_PROFILE_KEY); } catch {}
    const client = await ffGetClient();
    if (!client) return;
    await client.logout({
        logoutParams: { returnTo: window.location.origin + "/" },
    });
}

async function ffIsAuthenticated() {
    const client = await ffGetClient();
    if (!client) return false;
    return client.isAuthenticated();
}

async function ffUser() {
    const client = await ffGetClient();
    if (!client) return null;
    if (!(await client.isAuthenticated())) return null;
    return client.getUser();
}

/* Reflect auth state in a shared header link (id="signInLink"), if present. */
async function ffRenderHeader() {
    const link = document.getElementById("signInLink");
    if (!link) return;
    const user = await ffUser();
    if (user) {
        ffCacheSessionProfile(user);
        link.textContent = user.given_name || user.nickname || user.name || "Account";
        // Signed in, the name is a route to your own stuff -- not a logout trap.
        // This used to be href="#" with a logout handler, so clicking your own
        // name signed you out; and the plain markup fallback still points at
        // login.html, which bounces an already-authenticated user straight back.
        // Sign out lives where it belongs: the dashboard's own Sign out button
        // and login.html's logout control.
        link.href = "/dashboard";
        // Must clear: ffRenderHeader can run again after nav.js rebuilds the
        // header, and a surviving handler would swallow the navigation.
        link.onclick = null;
    } else {
        link.textContent = "Sign In";
        link.href = "/login";
        link.onclick = null;
    }
}

/* Global session helper.

   Every page that personalises anything needs the same three answers: is
   someone signed in, what do we call them, and what picture do we show. This
   resolves all three in one await and NEVER rejects -- Auth0 being unreachable
   (blocked script, offline in the field) must not stop the scanner or the
   dashboard from working, so the failure mode is a guest session.

   Shape: { authenticated, name, email, picture, sub, isGuest, user } */
async function getUserSession() {
    const guest = {
        authenticated: false,
        name: "Guest Botanist",
        email: null,
        picture: null,
        sub: null,
        isGuest: true,
        user: null,
    };
    try {
        const user = await ffUser();
        if (!user) return guest;
        ffCacheSessionProfile(user);
        return {
            authenticated: true,
            name: user.given_name || user.nickname || user.name || user.email || "Botanist",
            email: user.email || null,
            picture: user.picture || null,
            sub: user.sub || null,
            isGuest: false,
            user,
        };
    } catch {
        return guest;
    }
}

/* Access token for authenticated API calls.

   Returns the raw JWT string, or null when nobody is signed in / Auth0 is
   unreachable. Never rejects, so callers decide what an absent token means
   rather than having a network hiccup throw inside their request path.

   Pass an `audience` (your API identifier from the Auth0 dashboard) to get a
   token the backend can actually validate — without one Auth0 issues an opaque
   token that only its own /userinfo endpoint understands, which a resource
   server cannot verify. */
async function ffGetToken(audience) {
    const client = await ffGetClient();
    if (!client) return null;
    try {
        if (!(await client.isAuthenticated())) return null;
        const opts = audience ? { authorizationParams: { audience } } : undefined;
        return await client.getTokenSilently(opts);
    } catch {
        // Expired refresh token, blocked third-party cookies, offline in the
        // field: all mean "no usable token right now".
        return null;
    }
}

/* Authorization header for an authenticated fetch, or {} when signed out.
   Spread into a fetch's headers: { ...(await ffAuthHeader()), ... } */
async function ffAuthHeader(audience) {
    const token = await ffGetToken(audience);
    return token ? { Authorization: "Bearer " + token } : {};
}

/* Derive a stable, shareable preview key from the user's Auth0 id.
   NOTE: real secret keys will be issued by the hosted API backend at launch;
   this deterministic key identifies a developer during the preview program. */
async function ffDeriveKey(sub) {
    const data = new TextEncoder().encode("findflower:" + sub);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    return "ff_preview_" + hex.slice(0, 32);
}
