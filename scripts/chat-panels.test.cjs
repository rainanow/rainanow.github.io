/* Build Hugo first. CHAT_BUILD_DIR may point to a temporary build.
 * No backend requests, accounts or messages are created by these tests.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { JSDOM } = require(require.resolve('jsdom', { paths: [path.join(root, 'workers/chat')] }));

function page() {
    const build = process.env.CHAT_BUILD_DIR || path.join(root, 'public');
    const dom = new JSDOM(fs.readFileSync(path.join(build, 'chat/index.html'), 'utf8'), {
        url: 'https://yulo.top/chat/', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const w = dom.window;
    w.fetch = () => new Promise(() => {});
    const find = name => w.document.querySelector('[data-chat-' + name + ']');
    const app = w.document.querySelector('.chat');
    app.getBoundingClientRect = () => ({ left: 100, top: 60, width: 720 });
    for (const type of ['members', 'rooms']) {
        find(type + '-toggle').hidden = false;
        find(type + '-toggle').getBoundingClientRect = () => ({ left: 250, bottom: 90 });
        find(type + '-panel').getBoundingClientRect = () => ({ width: 288 });
    }
    w.eval(fs.readFileSync(path.join(root, 'assets/js/chat.js'), 'utf8'));
    return { dom, w, find, app };
}

test('disclosures are mutually exclusive and preserve offline-list and room-link controls', () => {
    const p = page();
    p.find('members-toggle').click();
    assert.equal(p.find('members-panel').hidden, false);
    assert.equal(p.find('members-toggle').getAttribute('aria-expanded'), 'true');
    p.find('offline-toggle').click();
    assert.equal(p.find('offline-list').hidden, false);
    p.find('offline-toggle').dispatchEvent(new p.w.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(p.find('members-panel').hidden, false, 'interacting inside must keep the card open');
    p.find('rooms-toggle').click();
    assert.equal(p.find('members-panel').hidden, true);
    assert.equal(p.find('rooms-panel').hidden, false);
    assert.ok(p.find('rooms-panel').querySelector('a[href="/chat/tech/"]'));
    p.find('members-toggle').click();
    assert.equal(p.find('rooms-panel').hidden, true);
    p.find('members-toggle').click();
    assert.equal(p.find('members-panel').hidden, true);
    p.dom.window.close();
});

test('outside pointer closes the card and Escape restores focus to its button', () => {
    const p = page();
    p.find('rooms-toggle').click();
    p.w.document.body.dispatchEvent(new p.w.MouseEvent('pointerdown', { bubbles: true }));
    assert.equal(p.find('rooms-panel').hidden, true);
    assert.equal(p.find('rooms-toggle').getAttribute('aria-expanded'), 'false');
    p.find('members-toggle').click();
    p.find('offline-toggle').focus();
    p.w.document.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(p.find('members-panel').hidden, true);
    assert.equal(p.w.document.activeElement, p.find('members-toggle'));
    p.dom.window.close();
});

test('cards follow their anchor and clamp within a narrow viewport after resizing', () => {
    const p = page();
    p.find('rooms-toggle').click();
    assert.equal(p.find('rooms-panel').style.top, '38px');
    assert.equal(p.find('rooms-panel').style.left, '150px');
    Object.defineProperty(p.w, 'innerWidth', { value: 390 });
    p.app.getBoundingClientRect = () => ({ left: 24, top: 60, width: 342 });
    p.find('rooms-toggle').getBoundingClientRect = () => ({ left: 330, bottom: 120 });
    p.w.dispatchEvent(new p.w.Event('resize'));
    assert.equal(p.find('rooms-panel').style.left, '54px');
    assert.equal(p.find('rooms-panel').style.top, '68px');
    assert.equal(p.find('messages').style.height, '', 'opening must not change manual/default chat height');
    p.dom.window.close();
});
