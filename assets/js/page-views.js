/* Vercount public contract: GET reads, POST increments only the current page.
 * https://github.com/EvanNotFound/vercount/blob/main/apps/api/internal/api/log.go
 * Counts are keyed by canonical URL, never by a repeated DOM id or a site-wide fallback.
 */
(() => {
    const script = document.querySelector('script[data-page-views]');
    if (!script) return;
    const site = new URL(script.dataset.siteUrl);
    const api = script.dataset.api;
    const requests = new Map();
    const observed = new WeakSet();
    const queue = [];
    let running = 0;

    function canonical(path) {
        return new URL(path, site).href;
    }

    async function request(url, write = false) {
        const endpoint = new URL(api);
        const options = { signal: AbortSignal.timeout(8000), credentials: 'omit' };
        const cookieKey = `vercount_uv_${site.host.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        if (write) {
            const knownVisitor = document.cookie.split('; ').some(cookie => cookie === `${cookieKey}=1`);
            options.method = 'POST';
            options.headers = { 'Content-Type': 'application/json' };
            options.body = JSON.stringify({ url, isNewUv: !knownVisitor });
        } else {
            endpoint.searchParams.set('url', url);
        }
        const response = await fetch(endpoint.href, options);
        if (!response.ok) throw new Error('Counter unavailable');
        const payload = await response.json();
        if (payload.status !== 'success') throw new Error('Counter rejected request');
        const value = payload.data?.page_pv;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid counter');
        if (write) document.cookie = `${cookieKey}=1; path=/; max-age=31536000; samesite=lax`;
        return value;
    }

    function pump() {
        while (running < 3 && queue.length) {
            const { url, resolve, reject } = queue.shift();
            running++;
            request(url).then(resolve, reject).finally(() => { running--; pump(); });
        }
    }

    function read(url) {
        if (!requests.has(url)) {
            const promise = new Promise((resolve, reject) => { queue.push({ url, resolve, reject }); });
            requests.set(url, promise);
            pump();
        }
        return requests.get(url);
    }

    async function fill(element) {
        try {
            const value = await read(canonical(element.dataset.pageUrl));
            element.textContent = `阅读量 ${value.toLocaleString('zh-CN')} 次`;
        } catch {
            element.textContent = '阅读量暂不可用';
        }
    }

    const observer = 'IntersectionObserver' in window ? new IntersectionObserver(entries => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            observer.unobserve(entry.target);
            fill(entry.target);
        });
    }, { rootMargin: '100px' }) : null;

    function scan() {
        document.querySelectorAll('[data-page-url]').forEach(element => {
            if (observed.has(element)) return;
            observed.add(element);
            if (observer) observer.observe(element);
            else fill(element);
        });
    }

    // Production records this document once. Localhost and preview hosts only read.
    if (script.dataset.record === 'true' && window.location.host === site.host) {
        const current = canonical(script.dataset.currentPath);
        const recorded = request(current, true).catch(() => request(current));
        requests.set(current, recorded);
        // Pages without a visible counter still record site visits; consume failures.
        recorded.catch(() => {});
    }
    scan();
    document.addEventListener('post-search:results', scan);
})();
