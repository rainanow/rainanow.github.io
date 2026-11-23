/* Build Hugo first, then run node scripts/chat-resize.test.cjs.
 * CHAT_BUILD_DIR may point to a temporary build. Tests use no backend or accounts.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { JSDOM } = require(require.resolve('jsdom', { paths: [path.join(root, 'workers/chat')] }));
const build = process.env.CHAT_BUILD_DIR || path.join(root, 'public');

function page() {
    const dom = new JSDOM(fs.readFileSync(path.join(build, 'chat/index.html'), 'utf8'), {
        url: 'https://yulo.top/chat/', runScripts: 'outside-only', pretendToBeVisual: true,
    });
    const w = dom.window;
    // Stop boot at its first request, without touching users, messages or sessions.
    w.fetch = () => new Promise(() => {});
    const messages = w.document.querySelector('[data-chat-messages]');
    const handle = w.document.querySelector('[data-chat-resize]');
    assert.ok(handle, 'the actual shortcode must provide the resize control');
    // jsdom has no layout engine; only the measured height and pointer capture are mocked.
    messages.getBoundingClientRect = () => ({ height: parseFloat(messages.style.height) || 400 });
    Object.defineProperty(messages, 'scrollHeight', { value: 1000 });
    Object.defineProperty(messages, 'clientHeight', { value: 300 });
    let captured = null;
    handle.setPointerCapture = id => { captured = id; };
    handle.hasPointerCapture = id => captured === id;
    handle.releasePointerCapture = () => { captured = null; };
    w.eval(fs.readFileSync(path.join(root, 'assets/js/chat.js'), 'utf8'));
    return { dom, w, messages, handle, captured: () => captured };
}

function key(p, value) {
    p.handle.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
}

function pointer(p, type, y, id = 1, button = 0) {
    const event = new p.w.MouseEvent(type, { clientY: y, button, bubbles: true, cancelable: true });
    Object.defineProperty(event, 'pointerId', { value: id });
    p.handle.dispatchEvent(event);
}

test('keyboard resizing respects limits and Home/double-click restore the CSS default', () => {
    const p = page();
    p.handle.focus();
    assert.equal(p.handle.getAttribute('aria-valuenow'), '400');
    key(p, 'ArrowDown');
    assert.equal(p.messages.style.height, '416px');
    key(p, 'ArrowUp');
    assert.equal(p.messages.style.height, '400px');
    for (let i = 0; i < 100; i++) key(p, 'ArrowUp');
    assert.equal(p.messages.style.height, '160px');
    for (let i = 0; i < 100; i++) key(p, 'ArrowDown');
    assert.equal(p.messages.style.height, '1200px');
    assert.equal(p.handle.getAttribute('aria-valuenow'), '1200');
    key(p, 'Home');
    assert.equal(p.messages.style.height, '');
    assert.equal(p.handle.getAttribute('aria-valuenow'), '400');
    key(p, 'ArrowDown');
    p.handle.dispatchEvent(new p.w.MouseEvent('dblclick'));
    assert.equal(p.messages.style.height, '');
    p.dom.window.close();
});

test('pointer dragging changes height, clamps bounds and stops after release or cancel', () => {
    const p = page();
    pointer(p, 'pointerdown', 100, 1, 2);
    pointer(p, 'pointermove', 250);
    assert.equal(p.messages.style.height, '', 'secondary button must not resize');
    pointer(p, 'pointerdown', 100);
    assert.equal(p.captured(), 1);
    pointer(p, 'pointermove', 250);
    assert.equal(p.messages.style.height, '550px');
    pointer(p, 'pointermove', 0, 2);
    assert.equal(p.messages.style.height, '550px', 'another pointer must not interfere');
    pointer(p, 'pointermove', 2000);
    assert.equal(p.messages.style.height, '1200px');
    pointer(p, 'pointermove', -2000);
    assert.equal(p.messages.style.height, '160px');
    pointer(p, 'pointerup', 250);
    assert.equal(p.captured(), null);
    pointer(p, 'pointermove', 300);
    assert.equal(p.messages.style.height, '160px');
    pointer(p, 'pointerdown', 100);
    pointer(p, 'pointercancel', 100);
    pointer(p, 'pointermove', 400);
    assert.equal(p.messages.style.height, '160px');
    p.dom.window.close();
});

test('resizing preserves history reading position but keeps a bottom-pinned conversation pinned', () => {
    const p = page();
    p.messages.scrollTop = 200;
    pointer(p, 'pointerdown', 100);
    pointer(p, 'pointermove', 200);
    assert.equal(p.messages.scrollTop, 200);
    pointer(p, 'pointerup', 200);
    p.messages.scrollTop = 700;
    pointer(p, 'pointerdown', 100);
    pointer(p, 'pointermove', 200);
    assert.equal(p.messages.scrollTop, 1000);
    pointer(p, 'pointerup', 200);
    p.dom.window.close();
});
