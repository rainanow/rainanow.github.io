/* Search is independent of pagination: the home JSON index covers all posts. */
(() => {
    const root = document.getElementById('posts-search');
    if (!root) return;
    const input = document.getElementById('posts-search-input');
    const list = document.getElementById('posts-list');
    const results = document.getElementById('posts-search-results');
    const status = document.getElementById('posts-search-status');
    const template = document.getElementById('posts-search-cards');
    const cards = new Map(Array.from(template.content.children, card => [card.dataset.postUrl, card]));
    let active = false;
    let engine;
    let loading;
    let revision = 0;

    function pathOf(url) {
        return new URL(url, window.location.href).pathname;
    }

    function announce(message) {
        status.textContent = message;
        status.hidden = !message;
    }

    function enter() {
        active = true;
        list.hidden = true;
        results.hidden = false;
    }

    function leave() {
        revision++;
        active = false;
        input.value = '';
        results.replaceChildren();
        results.hidden = true;
        list.hidden = false;
        announce('');
    }

    async function loadIndex() {
        if (engine) return engine;
        if (!loading) {
            loading = (async () => {
                const response = await fetch(input.dataset.indexUrl, { signal: AbortSignal.timeout(10000) });
                if (!response.ok) throw new Error('Search index unavailable');
                const data = await response.json();
                if (!Array.isArray(data)) throw new Error('Invalid search index');
                const byPath = new Map();
                data.forEach(post => {
                    const path = pathOf(post.permalink);
                    if (cards.has(path)) byPath.set(path, post);
                });
                const posts = Array.from(byPath.values());
                engine = new Fuse(posts, {
                    keys: [{ name: 'title', weight: 3 }, 'summary', 'content'],
                    threshold: 0.3,
                    ignoreLocation: true,
                    minMatchCharLength: 1,
                });
                return engine;
            })().finally(() => { loading = null; });
        }
        return loading;
    }

    async function search() {
        enter();
        const version = ++revision;
        const query = input.value.trim();
        results.replaceChildren();
        if (!query) {
            announce('');
            return;
        }
        announce('正在搜索……');
        try {
            const fuse = await loadIndex();
            if (!active || version !== revision) return;
            const matches = fuse.search(query);
            const fragment = document.createDocumentFragment();
            matches.forEach(({ item }) => {
                fragment.append(cards.get(pathOf(item.permalink)).cloneNode(true));
            });
            results.replaceChildren(fragment);
            announce(matches.length ? `找到 ${matches.length} 篇文章` : '未找到相关文章');
            document.dispatchEvent(new CustomEvent('post-search:results'));
        } catch {
            if (active && version === revision) {
                announce('搜索暂不可用，请重新输入重试，或按 Esc 返回文章列表');
            }
        }
    }

    input.addEventListener('focus', search);
    input.addEventListener('input', event => {
        if (event.isComposing) {
            revision++;
            enter();
            results.replaceChildren();
            announce('');
            return;
        }
        search();
    });
    input.addEventListener('compositionend', search);
    input.addEventListener('search', search);

    // An empty query ends only when focus/pointer moves outside the search area.
    // Keeping results inside root prevents blur from swallowing a result click.
    document.addEventListener('pointerdown', event => {
        if (active && !input.value.trim() && !root.contains(event.target)) leave();
    });
    root.addEventListener('focusout', () => {
        queueMicrotask(() => {
            if (active && !input.value.trim() && !root.contains(document.activeElement)) leave();
        });
    });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && active && !event.isComposing) {
            event.preventDefault();
            leave();
            input.blur();
        } else if (event.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)
            && !document.activeElement.isContentEditable && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            input.focus();
        }
    });
    root.addEventListener('keydown', event => {
        if (event.isComposing) return;
        const links = Array.from(results.querySelectorAll('.entry-link'));
        const index = links.indexOf(document.activeElement);
        if (event.key === 'ArrowDown' && links.length) {
            event.preventDefault();
            links[Math.min(index + 1, links.length - 1)].focus();
        } else if (event.key === 'ArrowUp' && index >= 0) {
            event.preventDefault();
            (index ? links[index - 1] : input).focus();
        } else if (event.key === 'Enter' && document.activeElement === input && links.length) {
            event.preventDefault();
            links[0].click();
        }
    });

    const params = new URLSearchParams(window.location.search);
    if (params.has('q') || params.has('search')) {
        input.value = params.get('q') || '';
        input.focus();
    }
})();
