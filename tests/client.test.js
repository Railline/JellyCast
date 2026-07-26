const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadClient() {
    const document = {
        documentElement: { lang: 'fr' },
        head: { appendChild() {} },
        body: { appendChild() {} },
        getElementById() { return {}; },
        querySelector() { return null; },
        createElement() {
            return { set id(value) {}, set textContent(value) {} };
        }
    };
    class MutationObserver { observe() {} }
    const sandbox = { window: {}, document, navigator: { language: 'fr' }, MutationObserver, console };
    vm.runInNewContext(
        fs.readFileSync('Jellyfin.Plugin.JellyCast/Web/jellycast.js', 'utf8'),
        sandbox);
    return sandbox.window.JellyCast;
}

test('accepts the primary user of a session', () => {
    const client = loadClient();
    assert.equal(client.belongsToUser({ UserId: 'USER-1' }, 'user-1'), true);
});

test('accepts an additional user and rejects a different account', () => {
    const client = loadClient();
    const session = { UserId: 'other', AdditionalUsers: [{ UserId: 'user-1' }] };
    assert.equal(client.belongsToUser(session, 'USER-1'), true);
    assert.equal(client.belongsToUser(session, 'user-2'), false);
});

