
const AUTH0_CONFIG = {
    domain:   "findflower.au.auth0.com",
    clientId: "6L1pckrnAw9csi0ZyHEX1CC3vo1lcgxK",
};

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

const AUTH0_READY =
    !!AUTH0_CONFIG.domain && !AUTH0_CONFIG.domain.startsWith("YOUR_") &&
    !!AUTH0_CONFIG.clientId && !AUTH0_CONFIG.clientId.startsWith("YOUR_");

let _auth0Client = null;

async function ffGetClient() {
    if (!AUTH0_READY) return null;
    if (_auth0Client) return _auth0Client;
    if (typeof auth0 === "undefined" || !auth0 || !auth0.createAuth0Client) return null;
    try {
        _auth0Client = await auth0.createAuth0Client({
            domain: AUTH0_CONFIG.domain,
            clientId: AUTH0_CONFIG.clientId,
            authorizationParams: { redirect_uri: AUTH0_CALLBACK },
            cacheLocation: "localstorage",
            useRefreshTokens: true,
        });
    } catch (e) {
        console.warn("Auth0 unavailable; continuing as guest.", e);
        return null;
    }
    return _auth0Client;
}

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

async function ffRenderHeader() {
    const link = document.getElementById("signInLink");
    if (!link) return;
    const user = await ffUser();
    if (user) {
        ffCacheSessionProfile(user);
        link.textContent = user.given_name || user.nickname || user.name || "Account";
        link.href = "/dashboard";
        link.onclick = null;
    } else {
        link.textContent = "Sign In";
        link.href = "/login";
        link.onclick = null;
    }
}

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

async function ffGetToken(audience) {
    const client = await ffGetClient();
    if (!client) return null;
    try {
        if (!(await client.isAuthenticated())) return null;
        const opts = audience ? { authorizationParams: { audience } } : undefined;
        return await client.getTokenSilently(opts);
    } catch {
        return null;
    }
}

async function ffAuthHeader(audience) {
    const token = await ffGetToken(audience);
    return token ? { Authorization: "Bearer " + token } : {};
}

// The social API takes the ID token as its bearer, and getIdTokenClaims hands
// back whichever one the SDK cached at sign-in: it reads that entry without
// looking at exp, while isAuthenticated stays true for as long as the refresh
// token lives. So a session older than the token's own lifetime keeps producing
// a JWT the server refuses as expired, and only writes break, because reading
// the feed allows anonymous callers. A silent call with the cache off runs the
// refresh grant, and the SDK stores the new ID token that comes back with it.
const FF_TOKEN_MARGIN_SECONDS = 120;

function ffTokenExpired(raw) {
    if (!raw) return true;
    const part = String(raw).split(".")[1];
    if (!part) return false;
    let exp = 0;
    try {
        const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
        const claims = JSON.parse(atob(b64 + "===".slice((b64.length + 3) % 4)));
        exp = typeof claims.exp === "number" ? claims.exp : 0;
    } catch {
        return false;
    }
    return exp > 0 && exp - FF_TOKEN_MARGIN_SECONDS <= Math.floor(Date.now() / 1000);
}

async function ffIdToken() {
    const client = await ffGetClient();
    if (!client) return null;
    try {
        if (!(await client.isAuthenticated())) return null;
        let claims = await client.getIdTokenClaims();
        if (ffTokenExpired(claims && claims.__raw)) {
            await client.getTokenSilently({ cacheMode: "off" });
            claims = await client.getIdTokenClaims();
            if (ffTokenExpired(claims && claims.__raw)) return null;
        }
        return (claims && claims.__raw) || null;
    } catch {
        return null;
    }
}

async function ffDeriveKey(sub) {
    const data = new TextEncoder().encode("findflower:" + sub);
    const buf = await crypto.subtle.digest("SHA-256", data);
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
    return "ff_preview_" + hex.slice(0, 32);
}
