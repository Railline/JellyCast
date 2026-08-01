const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function loadClient(language = 'fr', apiClient) {
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
        window: { ApiClient: apiClient, setInterval() {}, setTimeout() {} },
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

test('uses official Jellyfin commands for transfer playback and state', async () => {
    const calls = [];
    const item = { Id: 'item-1' };
    const source = {
        Id: 'source-session',
        UserId: 'user-1',
        DeviceId: 'source-device',
        NowPlayingItem: item,
        PlayState: { PositionTicks: 123456789 }
    };
    const target = {
        Id: 'target-session',
        UserId: 'user-1',
        DeviceId: 'target-device'
    };
    const apiClient = {
        getUrl(path) {
            return path;
        },
        async sendPlayStateCommand(sessionId, command) {
            calls.push({ type: 'state', sessionId, command });
        },
        async sendPlayCommand(sessionId, options) {
            calls.push({ type: 'play', sessionId, options });
        },
        async ajax() {
            return [{
                ...target,
                NowPlayingItem: item
            }];
        }
    };
    const client = loadClient('en', apiClient);

    const stopped = await client.transfer(source, {
        user: { Id: 'user-1' },
        target,
        sessions: [source, target]
    });

    assert.equal(stopped, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0], {
        type: 'state', sessionId: 'source-session', command: 'Pause'
    });
    assert.equal(calls[1].type, 'play');
    assert.equal(calls[1].sessionId, 'target-session');
    assert.equal(calls[1].options.PlayCommand, 'PlayNow');
    assert.equal(calls[1].options.ItemIds, 'item-1');
    assert.equal(calls[1].options.StartPositionTicks, 123456789);
    assert.deepEqual(calls[2], {
        type: 'state', sessionId: 'source-session', command: 'Stop'
    });
});
