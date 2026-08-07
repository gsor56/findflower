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
     • Allowed Logout URLs   : http://localhost:8000/index.html
     • Allowed Web Origins   : http://localhost:8000

   (Add your production URLs alongside these when you deploy.)
   Until both values are filled in, the site runs in "setup required" mode and
   nothing breaks — the login button simply explains what to configure.
   ========================================================================== */

const AUTH0_CONFIG = {
    domain:   "findflower.au.auth0.com",     // e.g. "dev-ab12cd.us.auth0.com"
    clientId: "6L1pckrnAw9csi0ZyHEX1CC3vo1lcgxK",  // e.g. "aBcD1234...."
};

// The single callback page Auth0 redirects back to after login.
const AUTH0_CALLBACK = window.location.origin + "/login.html";

// True only once real credentials have been supplied.
const AUTH0_READY =
    !!AUTH0_CONFIG.domain && !AUTH0_CONFIG.domain.startsWith("YOUR_") &&
    !!AUTH0_CONFIG.clientId && !AUTH0_CONFIG.clientId.startsWith("YOUR_");

let _auth0Client = null;

async function ffGetClient() {
    if (!AUTH0_READY) return null;
    if (_auth0Client) return _auth0Client;
    // auth0-spa-js is loaded from the CDN before this script.
    _auth0Client = await auth0.createAuth0Client({
        domain: AUTH0_CONFIG.domain,
        clientId: AUTH0_CONFIG.clientId,
        authorizationParams: { redirect_uri: AUTH0_CALLBACK },
        cacheLocation: "localstorage",   // keep the session across page loads
        useRefreshTokens: true,
    });
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
    const client = await ffGetClient();
    if (!client) return;
    await client.logout({
        logoutParams: { returnTo: window.location.origin + "/index.html" },
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
        link.textContent = user.given_name || user.nickname || user.name || "Account";
        link.href = "#";
        link.onclick = (e) => { e.preventDefault(); ffLogout(); };
    } else {
        link.textContent = "Sign In";
        link.href = "login.html";
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

/* Derive a stable, shareable preview key from the user's Auth0 id.
   NOTE: real secret keys will be issued by the hosted API backend at launch;
   this deterministic key identifies a developer during the preview program. */
async function ffDeriveKey(sub) {
    const data = new TextEncoder().encode("findflower:" + sub);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    return "ff_preview_" + hex.slice(0, 32);
}
