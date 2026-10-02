// Consent gate for /try page - runs before any scanner interaction
// Shows consent modal on first visit for signed-in users without termsAccepted
(function () {
    'use strict';

    async function checkConsentRequired() {
        // Only run if Auth0 SDK is loaded
        if (typeof ffIsAuthenticated !== 'function') return false;

        try {
            const authed = await ffIsAuthenticated();
            if (!authed) return false;

            // Check if user has already accepted terms locally
            const localAccepted = localStorage.getItem('ff_terms_accepted');
            if (localAccepted === '1') return false;

            // Fetch profile to check server-side termsAccepted flag
            const headers = {};
            if (typeof ffIdToken === 'function') {
                const token = await ffIdToken();
                if (token) headers['Authorization'] = 'Bearer ' + token;
            }

            const res = await fetch('/api/users/me', {
                method: 'GET',
                credentials: 'same-origin',
                headers: headers,
            });

            if (!res.ok) {
                // 409 means no profile yet - consent gate shouldn't show, handle claim comes first
                return false;
            }

            const data = await res.json();
            // Only show consent if user has a profile but hasn't accepted terms
            if (!data.user) return false;

            // If user has accepted terms, mark it locally and don't show modal
            if (data.user.termsAccepted) {
                try { localStorage.setItem('ff_terms_accepted', '1'); } catch (x) {}
                return false;
            }

            // User exists but hasn't accepted terms
            return true;
        } catch (err) {
            console.error('[consent-gate] Check failed:', err);
            return false;
        }
    }

    function showConsentModal() {
        const modal = document.createElement('div');
        modal.id = 'ffConsentModal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'consentTitle');
        modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:1.5rem;';

        modal.innerHTML = `
            <div style="background:#FCFCFC;max-width:520px;width:100%;border-radius:8px;box-shadow:0 20px 60px -18px rgba(23,23,23,0.25);max-height:90vh;overflow-y:auto;">
                <div style="padding:2rem;">
                    <h2 id="consentTitle" style="font-size:1.5rem;font-weight:500;color:#171717;margin-bottom:1rem;line-height:1.3;">Before you continue</h2>
                    <p style="color:#525252;margin-bottom:1.5rem;line-height:1.6;">To use FindFlower you must agree to the Terms of Service and Privacy Policy.</p>

                    <div style="border:1px solid #E5E5E5;padding:1.25rem;margin-bottom:1.5rem;background:#FAFAFA;">
                        <p style="margin-bottom:1rem;font-size:0.875rem;line-height:1.5;color:#404040;"><strong style="color:#171717;">FindFlower is strictly an educational tool.</strong> AI predictions can be wrong. You must never forage, ingest, touch, or handle any wild plant based solely on a FindFlower identification.</p>
                        <p style="margin-bottom:1rem;font-size:0.875rem;line-height:1.5;color:#404040;">If you do not agree to use this app strictly for educational purposes, or if you intend to consume wild plants based on these results, you are legally forbidden from using this service and must exit the site immediately.</p>
                        <p style="font-size:0.875rem;line-height:1.5;color:#404040;">By continuing you also acknowledge that you are responsible for what you post in the community and chat, and that harassment or illegal content will result in an immediate ban.</p>
                    </div>

                    <label style="display:flex;align-items:start;gap:0.75rem;margin-bottom:1.5rem;cursor:pointer;font-size:0.875rem;color:#404040;">
                        <input type="checkbox" id="ffConsentCheck" style="margin-top:0.125rem;accent-color:#1a3622;cursor:pointer;">
                        <span>I have read and agree to the <a href="/terms" target="_blank" style="text-decoration:underline;color:#171717;">Terms of Service</a> and <a href="/privacy" target="_blank" style="text-decoration:underline;color:#171717;">Privacy Policy</a>, and I understand this app is for educational use only.</span>
                    </label>

                    <p id="ffConsentError" style="display:none;color:#dc2626;font-size:0.875rem;margin-bottom:1rem;"></p>

                    <div style="display:flex;gap:0.75rem;flex-wrap:wrap;">
                        <button id="ffConsentAccept" disabled style="flex:1;min-width:120px;padding:0.75rem 1.5rem;background:#737373;color:white;border:1px solid #525252;font-weight:500;font-size:0.875rem;cursor:not-allowed;opacity:0.5;transition:all 0.2s;">Accept and continue</button>
                        <button id="ffConsentDecline" style="flex:1;min-width:120px;padding:0.75rem 1.5rem;background:white;color:#404040;border:1px solid #D4D4D4;font-weight:500;font-size:0.875rem;cursor:pointer;transition:all 0.2s;" onmouseover="this.style.borderColor='#A3A3A3';this.style.color='#171717'" onmouseout="this.style.borderColor='#D4D4D4';this.style.color='#404040'">Exit site</button>
                    </div>

                    <div style="margin-top:1rem;display:flex;gap:1rem;font-size:0.875rem;">
                        <a href="/terms" target="_blank" style="color:#3D5341;text-decoration:underline;text-underline-offset:2px;">Read Terms</a>
                        <a href="/privacy" target="_blank" style="color:#3D5341;text-decoration:underline;text-underline-offset:2px;">Read Privacy Policy</a>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
        document.body.style.overflow = 'hidden';

        const checkbox = document.getElementById('ffConsentCheck');
        const acceptBtn = document.getElementById('ffConsentAccept');
        const declineBtn = document.getElementById('ffConsentDecline');
        const errorEl = document.getElementById('ffConsentError');

        checkbox.addEventListener('change', () => {
            acceptBtn.disabled = !checkbox.checked;
            if (checkbox.checked) {
                acceptBtn.style.background = '#1a3622';
                acceptBtn.style.borderColor = 'black';
                acceptBtn.style.opacity = '1';
                acceptBtn.style.cursor = 'pointer';
            } else {
                acceptBtn.style.background = '#737373';
                acceptBtn.style.borderColor = '#525252';
                acceptBtn.style.opacity = '0.5';
                acceptBtn.style.cursor = 'not-allowed';
            }
        });

        declineBtn.addEventListener('click', () => {
            window.location.href = '/';
        });

        acceptBtn.addEventListener('click', async () => {
            if (!checkbox.checked) return;

            acceptBtn.disabled = true;
            acceptBtn.textContent = 'Saving...';
            acceptBtn.style.opacity = '0.6';
            errorEl.style.display = 'none';

            try {
                const headers = { 'Content-Type': 'application/json' };
                if (typeof ffIdToken === 'function') {
                    const token = await ffIdToken();
                    if (token) headers['Authorization'] = 'Bearer ' + token;
                }

                const res = await fetch('/api/users/consent', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: headers,
                    body: '{}',
                });

                const data = await res.json();

                if (res.ok && data.ok) {
                    try { localStorage.setItem('ff_terms_accepted', '1'); } catch (x) {}
                    document.body.removeChild(modal);
                    document.body.style.overflow = '';
                    return;
                }

                errorEl.textContent = data.error || 'Something went wrong. Please try again.';
                errorEl.style.display = 'block';
            } catch (err) {
                errorEl.textContent = 'Could not reach the server. Please try again.';
                errorEl.style.display = 'block';
            }

            acceptBtn.disabled = false;
            acceptBtn.textContent = 'Accept and continue';
            acceptBtn.style.opacity = '1';
        });

        // Prevent closing modal by clicking outside or pressing Escape
        modal.addEventListener('click', (e) => {
            if (e.target === modal) e.stopPropagation();
        });
    }

    // Run on page load
    document.addEventListener('DOMContentLoaded', async () => {
        const needsConsent = await checkConsentRequired();
        if (needsConsent) {
            showConsentModal();
        }
    });
})();
