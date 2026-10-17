/* Build with Hugo first, then run: node scripts/blog-ui.test.cjs
 * BLOG_BUILD_DIR can point to a temporary build. Reuses the existing chat dev dependency.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { JSDOM } = require(require.resolve('jsdom', { paths: [path.join(root, 'workers/chat')] }));
const build = process.env.BLOG_BUILD_DIR || path.join(root, 'public');
const index = JSON.parse(fs.readFileSync(path.join(build, 'index.json'), 'utf8'));
const turn = () => new Promise(resolve => setImmediate(resolve));
async function settle() { for (let i = 0; i < 12; i++) await turn(); }

function page(url = 'http://localhost:1313/posts/', relative = 'posts/index.html') {
    const dom = new JSDOM(fs.readFileSync(path.join(build, relative), 'utf8'), {
        url, runScripts: 'outside-only', pretendToBeVisual: true,
    });
    dom.window.AbortSignal.timeout = () => new dom.window.AbortController().signal;
    return dom;
}

function search(dom) {
    const w = dom.window;
    w.fetch = async url => {
        assert.equal(url, '/index.json', 'index URL must also work from paginated lists');
        return { ok: true, json: async () => index };
    };
    const script = w.document.querySelector('script[src*="posts-search."]');
    w.eval(fs.readFileSync(path.join(build, script.getAttribute('src')), 'utf8'));
    return {
        w, input: w.document.getElementById('posts-search-input'),
        list: w.document.getElementById('posts-list'),
        results: w.document.getElementById('posts-search-results'),
        status: w.document.getElementById('posts-search-status'),
    };
}

function type(ui, value, options = {}) {
    ui.input.value = value;
    ui.input.dispatchEvent(new ui.w.InputEvent('input', { bubbles: true, ...options }));
}

function escape(ui) {
    ui.w.document.dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

function views(dom, fetch) {
    dom.window.fetch = fetch;
    dom.window.eval(fs.readFileSync(path.join(root, 'assets/js/page-views.js'), 'utf8'));
}

test('focus, query, no matches, clear, outside click and Escape follow the agreed states', async () => {
    const dom = page();
    const ui = search(dom);
    assert.equal(ui.list.hidden, false);
    ui.input.focus();
    assert.equal(ui.list.hidden, true);
    assert.equal(ui.results.children.length, 0);
    type(ui, '迁移学习中心');
    await settle();
    assert.ok(ui.results.querySelector('.entry-header').textContent.includes('迁移学习中心'));
    assert.equal(ui.list.hidden, true);
    const result = ui.results.querySelector('.entry-link');
    result.focus();
    await settle();
    assert.equal(result.isConnected, true, 'blur must not remove the clicked/focused result');
    assert.equal(ui.list.hidden, true);
    type(ui, 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
    await settle();
    assert.equal(ui.results.children.length, 0);
    assert.equal(ui.status.textContent, '未找到相关文章');
    ui.input.focus();
    type(ui, '');
    assert.equal(ui.list.hidden, true, 'clearing inside search keeps the list hidden');
    ui.w.document.body.dispatchEvent(new ui.w.Event('pointerdown', { bubbles: true }));
    assert.equal(ui.list.hidden, false);
    ui.input.blur();
    ui.input.focus();
    type(ui, '乐谱');
    await settle();
    escape(ui);
    assert.equal(ui.input.value, '');
    assert.equal(ui.results.hidden, true);
    assert.equal(ui.list.hidden, false);
    dom.window.close();
});

test('a late index response cannot restore results after Escape; failed loads can retry', async () => {
    const dom = page();
    const ui = search(dom);
    let resolve;
    ui.w.fetch = () => new Promise(done => { resolve = done; });
    ui.input.focus();
    type(ui, '乐谱');
    escape(ui);
    resolve({ ok: true, json: async () => index });
    await settle();
    assert.equal(ui.list.hidden, false);
    assert.equal(ui.results.children.length, 0);
    dom.window.close();

    const retryDom = page();
    const retry = search(retryDom);
    retry.w.fetch = async () => { throw new Error('offline'); };
    retry.input.focus();
    type(retry, '乐谱');
    await settle();
    assert.match(retry.status.textContent, /搜索暂不可用/);
    retry.w.fetch = async () => ({ ok: true, json: async () => index });
    type(retry, '迁移学习中心');
    await settle();
    assert.ok(retry.results.children.length > 0);
    retryDom.window.close();
});

test('duplicate index entries from a live rebuild produce only one result per article', async () => {
    const dom = page();
    const ui = search(dom);
    ui.w.fetch = async () => ({ ok: true, json: async () => [...index, ...index] });
    ui.input.focus();
    type(ui, '迁移学习中心');
    await settle();
    const urls = Array.from(ui.results.children, element => element.dataset.postUrl);
    assert.ok(urls.length > 0);
    assert.equal(new Set(urls).size, urls.length);
    dom.window.close();
});

test('IME composition, keyboard navigation, old search query and focus exit work', async () => {
    const dom = page('http://localhost:1313/posts/?q=乐谱');
    const ui = search(dom);
    await settle();
    assert.equal(ui.input.value, '乐谱');
    assert.ok(ui.results.children.length > 0);
    type(ui, '迁', { isComposing: true });
    assert.equal(ui.results.children.length, 0);
    ui.input.value = '迁移学习中心';
    ui.input.dispatchEvent(new ui.w.CompositionEvent('compositionend'));
    await settle();
    ui.input.dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.ok(ui.w.document.activeElement.matches('.entry-link'));
    let clicked = false;
    ui.results.querySelector('.entry-link').addEventListener('click', e => { e.preventDefault(); clicked = true; });
    ui.input.focus();
    await settle();
    ui.results.querySelector('.entry-link').addEventListener('click', e => { e.preventDefault(); clicked = true; });
    ui.input.dispatchEvent(new ui.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert.equal(clicked, true);
    type(ui, '');
    ui.w.document.querySelector('.logo a').focus();
    await settle();
    assert.equal(ui.list.hidden, false);
    dom.window.close();
});

test('preview card counters are per URL, GET only, deduplicated and limited to three concurrent requests', async () => {
    const dom = page();
    const calls = [];
    let active = 0;
    let maximum = 0;
    views(dom, async (endpoint, options) => {
        assert.notEqual(options.method, 'POST');
        const url = new URL(endpoint).searchParams.get('url');
        assert.ok(url.startsWith('https://yulo.top/posts/'));
        calls.push(url);
        active++;
        maximum = Math.max(maximum, active);
        await turn();
        active--;
        return { ok: true, json: async () => ({ status: 'success', data: { page_pv: url.length } }) };
    });
    await settle();
    const elements = dom.window.document.querySelectorAll('[data-page-url]');
    assert.ok(elements.length > 1);
    assert.equal(calls.length, elements.length, 'inert search templates do not fetch counters');
    assert.equal(new Set(calls).size, calls.length);
    assert.ok(maximum <= 3);
    for (const element of elements) {
        const url = new URL(element.dataset.pageUrl, 'https://yulo.top/').href;
        assert.equal(element.textContent, `阅读量 ${url.length} 次`);
    }
    const clone = elements[0].cloneNode(true);
    dom.window.document.body.append(clone);
    dom.window.document.dispatchEvent(new dom.window.CustomEvent('post-search:results'));
    await settle();
    assert.equal(calls.length, elements.length, 'the same article reuses its counter');
    dom.window.close();
});

test('production records only the current document once and detail views reuse the POST result', async () => {
    const dom = page('https://yulo.top/posts/');
    const paths = Array.from(dom.window.document.querySelectorAll('[data-page-url]'), el => el.dataset.pageUrl);
    const current = paths[0];
    const script = dom.window.document.querySelector('script[data-page-views]');
    script.dataset.record = 'true';
    script.dataset.currentPath = current;
    const calls = [];
    views(dom, async (endpoint, options) => {
        calls.push({ endpoint, options });
        return { ok: true, json: async () => ({ status: 'success', data: { page_pv: 42 } }) };
    });
    await settle();
    const writes = calls.filter(call => call.options.method === 'POST');
    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(writes[0].options.body).url, new URL(current, 'https://yulo.top/').href);
    assert.equal(calls.length, paths.length, 'the current article is not fetched again after recording');
    assert.match(dom.window.document.cookie, /vercount_uv_yulo_top=1/);
    dom.window.close();
});

test('counter errors and malformed responses never show stale counts from another article', async () => {
    for (const payload of [null, { status: 'error' }, { status: 'success', data: { page_pv: null } }]) {
        const dom = page();
        dom.window.localStorage.setItem('visitorCountData', JSON.stringify({ page_pv: 104482 }));
        views(dom, async () => {
            if (!payload) throw new Error('offline');
            return { ok: true, json: async () => payload };
        });
        await settle();
        for (const element of dom.window.document.querySelectorAll('[data-page-url]')) {
            assert.equal(element.textContent, '阅读量暂不可用');
        }
        dom.window.close();
    }
});

test('paginated lists search the complete index and restore their original pagination', async t => {
    const relative = 'posts/page/2/index.html';
    if (!fs.existsSync(path.join(build, relative))) {
        t.skip('Use a build with pagination.pagerSize=3 to exercise the second page.');
        return;
    }
    const dom = page('http://localhost:1313/posts/page/2/', relative);
    const ui = search(dom);
    const firstPage = page();
    const firstTitle = firstPage.window.document.querySelector('#posts-list h2').textContent;
    firstPage.window.close();
    assert.ok(!ui.list.textContent.includes(firstTitle));
    ui.input.focus();
    type(ui, firstTitle);
    await settle();
    assert.ok(ui.results.textContent.includes(firstTitle), 'search finds articles outside the current page');
    escape(ui);
    assert.equal(ui.list.hidden, false);
    assert.ok(ui.list.querySelector('.pagination'));
    dom.window.close();
});
