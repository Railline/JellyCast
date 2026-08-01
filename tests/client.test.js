const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadClient(language = 'fr') {
    const document = {
        documentElement: {
            lang: language,
            getAttribute(name) { return name === 'lang' ? language : null; }
        },
        head: { appendChild() {} },
        body: { appendChild() {} },
        getElementById() { return {}; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        createElement() {
            return { set id(value) {}, set textContent(value) {} };
        }
    };
    class MutationObserver { observe() {} }
    const sandbox = {
        window: { setInterval() {}, setTimeout() {} },
        document,
        navigator: { language: 'fr' },
        MutationObserver,
        console
    };
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

test('recognizes Android UI and native playback sessions as the same device', () => {
    const client = loadClient();
    assert.equal(
        client.isSamePhysicalDevice(
            '824b3ed573f32579',
            '824b3ed573f32579076de1f7727447e0a316f8d52f63e5e2'),
        true);
    assert.equal(client.isSamePhysicalDevice('phone-1', 'desktop-1'), false);
});

test('uses the Jellyfin interface language with an English fallback', () => {
    assert.equal(loadClient('fr-FR').interfaceLanguage(), 'fr');
    assert.equal(loadClient('en-US').interfaceLanguage(), 'en');
    assert.equal(loadClient('de-DE').interfaceLanguage(), 'en');
});
