// Server-session shim: what replaces auth.js on a server-rendered page.
//
// The server owns the Auth0 session now, so there is no SPA client, no silent
// token refresh and no callback page to handle. What is left is the handful of
// globals the page scripts were written against -- ffUser, ffIsAuthenticated,
// ffLogin, getUserSession -- plus the localStorage profile row nav.js paints
// the header from. The server already told us who this is, so this file just
// hands those values back.
//
// Loaded synchronously in <head>, so nothing running under `defer` can race it.
(function () {
    'use strict';
    var SSR = window.__FF_SSR__ || {};
    var auth = SSR.auth || { authenticated: false, user: null };
    var user = auth.authenticated && auth.user ? auth.user : null;
    var KEY = 'ff_session_profile';

    try {
        if (user) {
            localStorage.setItem(KEY, JSON.stringify({
                authenticated: true,
                name: user.name || user.email || 'Botanist',
                email: user.email || null,
                picture: user.picture || null,
                sub: user.sub || null,
            }));
        } else {
            localStorage.removeItem(KEY);
        }
    } catch (e) { /* private mode, or storage full: the page still renders */ }

    window.FF_AUTH_MODE = 'server-session';
    window.FF_SSR_USER = user;

    window.ffIsAuthenticated = async function () { return !!user; };
    window.ffUser = async function () { return user; };

    // Nothing to hand out. The session cookie is httpOnly and same-origin, and
    // a bearer token sitting in JavaScript would only be a second copy to leak:
    // same-origin fetches carry the cookie on their own.
    window.ffIdToken = async function () { return null; };
    window.ffGetToken = async function () { return null; };
    window.ffGetClient = async function () { return null; };
    window.ffAuthHeader = async function () { return {}; };
    window.ffDeriveKey = async function () { return null; };

    window.ffLogin = function (returnTo) {
        var to = returnTo ? '?returnTo=' + encodeURIComponent(returnTo) : '';
        location.href = '/login' + to;
    };
    window.ffLogout = function () { location.href = '/logout'; };
    window.ffHandleCallback = async function () { return null; };

    window.getUserSession = async function () {
        if (!user) {
            return {
                authenticated: false, name: 'Guest Botanist', email: null,
                picture: null, sub: null, isGuest: true, user: null,
            };
        }
        return {
            authenticated: true,
            name: user.name || user.email || 'Botanist',
            email: user.email || null,
            picture: user.picture || null,
            sub: user.sub || null,
            isGuest: false,
            user: user,
        };
    };

    // nav.js calls this on load. It is the same DOM edit auth.js made, minus
    // the Auth0 round trip that no longer has anything to fetch.
    window.ffRenderHeader = async function () {
        var link = document.getElementById('signInLink');
        if (!link) return;
        if (user) {
            link.textContent = user.name || 'Account';
            link.href = '/dashboard';
            link.onclick = null;
            link.removeAttribute('data-i18n');
        } else {
            link.setAttribute('data-i18n', 'nav.signin');
            link.textContent = (window.ffI18n && window.ffI18n.t && window.ffI18n.t('nav.signin')) || 'Sign In';
            link.href = '/login';
            link.onclick = null;
        }
    };
})();
