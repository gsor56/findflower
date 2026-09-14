
const AUTH0_CONFIG = {
    domain:   "dev-jvit0r04itv8hfjz.us.auth0.com",
    clientId: "9sWXgo4TtCodcmnfdr6vcSRighhkVXMy",
};

const AUTH0_CALLBACK = window.location.origin + "/login";
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

const FF_CONSENT_KEY = "ff_terms_accepted";

function _ffHasConsented() {
    try { return localStorage.getItem(FF_CONSENT_KEY) === "1"; } catch { return false; }
}

function _ffShowConsentGate() {
    return new Promise(function (resolve) {
        var existing = document.getElementById("ffConsentDialog");
        if (existing) { existing.remove(); }
        var dlg = document.createElement("dialog");
        dlg.id = "ffConsentDialog";
        dlg.className = "w-full max-w-sm p-0 border border-black bg-white backdrop:bg-black/30";
        dlg.innerHTML =
            '<div class="p-5">' +
            '<h2 class="text-sm font-medium text-neutral-900 mb-2">Before you sign in</h2>' +
            '<p class="text-xs text-neutral-600 leading-relaxed mb-3">' +
            'By signing in you agree to the FindFlower ' +
            '<a href="/terms" class="underline text-neutral-900" target="_blank">Terms of Service</a> and ' +
            '<a href="/privacy" class="underline text-neutral-900" target="_blank">Privacy Policy</a>.' +
            '</p>' +
            '<p class="text-xs text-red-600 leading-relaxed mb-4">' +
            'FindFlower is strictly an educational tool. If you do not agree to use this app strictly for educational purposes, or if you intend to consume wild plants based on these results, you are legally forbidden from using this service and must exit the site immediately.' +
            '</p>' +
            '<label class="flex items-start gap-2 text-sm text-neutral-700 cursor-pointer mb-4">' +
            '<input type="checkbox" id="ffConsentCheck" class="mt-0.5 accent-[#1a3622]">' +
            ' I have read and agree to the Terms of Service and Privacy Policy' +
            '</label>' +
            '<div class="flex items-center justify-end gap-2">' +
            '<button type="button" id="ffConsentCancel" class="text-sm text-neutral-500 hover:text-neutral-900 px-3 py-2 transition">Cancel</button>' +
            '<button type="button" id="ffConsentContinue" class="text-sm font-medium bg-neutral-900 text-white border border-black rounded-none px-4 py-2 hover:bg-neutral-800 transition disabled:opacity-40" disabled>Continue</button>' +
            '</div>' +
            '</div>';
        document.body.appendChild(dlg);
        var check = dlg.querySelector("#ffConsentCheck");
        var cont = dlg.querySelector("#ffConsentContinue");
        var cancel = dlg.querySelector("#ffConsentCancel");
        check.addEventListener("change", function () { cont.disabled = !check.checked; });
        cancel.addEventListener("click", function () { dlg.close(); resolve(false); });
        cont.addEventListener("click", function () {
            try { localStorage.setItem(FF_CONSENT_KEY, "1"); } catch {}
            dlg.close();
            resolve(true);
        });
        dlg.addEventListener("close", function () {
            dlg.remove();
        });
        dlg.showModal();
    });
}

async function ffLogin(returnTo) {
    const client = await ffGetClient();
    if (!client) return false;
    if (!_ffHasConsented()) {
        var accepted = await _ffShowConsentGate();
        if (!accepted) return false;
    }
    if (returnTo) localStorage.setItem("ff_return_to", returnTo);
    await client.loginWithRedirect({
        authorizationParams: { redirect_uri: AUTH0_CALLBACK },
    });
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
        link.removeAttribute("data-i18n");
    } else {
        // Back to a translatable label once there is no name to show.
        link.setAttribute("data-i18n", "nav.signin");
        link.textContent = (window.ffI18n && window.ffI18n.t("nav.signin")) || "Sign In";
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

async function ffGetToken() {
    const client = await ffGetClient();
    if (!client) return null;
    try {
        if (!(await client.isAuthenticated())) return null;
        return await client.getTokenSilently();
    } catch {
        return null;
    }
}

async function ffAuthHeader() {
    const token = await ffGetToken();
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
