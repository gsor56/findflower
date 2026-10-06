// The two shapes a user row is serialised into: the public card anybody may
// read, and the owner's own row behind GET /api/users/me.
//
// No database. toPublic and toPrivate are schema methods, so a row can be built
// in memory and asked directly, which is the whole surface that changed. The
// reason consent may not sit in toPublic is that GET /api/users/:handle serves
// that same shape to strangers, and whether a person accepted the terms is not
// something a public profile card should publish.
//
// The last block reads routes/users.js as text. It is the only thing standing
// between a later edit and the field quietly reappearing on the public card.

import { readFileSync } from 'node:fs';
import { User } from './models/user.js';

let pass = 0, fail = 0;
function one(name, ok, detail) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name.padEnd(58) + (detail === undefined ? '' : detail));
    ok ? pass++ : fail++;
}

function row(termsAccepted) {
    return new User({
        authSub: 'auth0|abc123',
        handle: 'ada',
        displayName: 'Ada Botanist',
        termsAccepted,
    });
}

console.log('--- the public card ---');
{
    const pub = row(true).toPublic();
    one('toPublic carries no termsAccepted', !('termsAccepted' in pub), Object.keys(pub).join(','));
    one('...nor termsAcceptedAt', !('termsAcceptedAt' in pub));
    one('...and still holds what the profile page renders',
        pub.handle === 'ada' && pub.displayName === 'Ada Botanist' && !!pub.privacy && !!pub.stats);
    one('...and never leaks authSub', !('authSub' in pub));
}

console.log("\n--- the owner's own row ---");
{
    const accepted = row(true).toPrivate();
    one('toPrivate reports consent', accepted.termsAccepted === true);
    one('...as a boolean when it is false', row(false).toPrivate().termsAccepted === false);
    one('...defaulting to false on a fresh row', new User({}).toPrivate().termsAccepted === false);
    one('...as a superset of the public card',
        Object.keys(row(true).toPublic()).every((k) => k in accepted), Object.keys(accepted).join(','));
    one('...and still never leaks authSub', !('authSub' in accepted));
}

console.log('\n--- which route serves which shape ---');
{
    const source = readFileSync(new URL('./routes/users.js', import.meta.url), 'utf8');
    const me = source.slice(source.indexOf("router.get('/me'"), source.indexOf("router.post('/',"));
    const created = source.slice(source.indexOf("router.post('/',"), source.indexOf("router.get('/:handle'"));
    const card = source.slice(source.indexOf("router.get('/:handle'"), source.indexOf("router.post('/consent'"));

    one('all three handlers were found', !!me && !!created && !!card && me !== card);
    one('GET /api/users/me serves the private shape',
        /toPrivate\(\)/.test(me) && !/toPublic\(\)/.test(me));
    one('POST /api/users still serves the public one',
        /toPublic\(\)/.test(created) && !/toPrivate\(\)/.test(created));
    one('GET /api/users/:handle still serves the public one',
        /toPublic\(\)/.test(card) && !/toPrivate\(\)/.test(card));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exitCode = fail ? 1 : 0;
