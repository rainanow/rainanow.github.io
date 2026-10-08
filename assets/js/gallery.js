/* 图片画廊：自动排版 + 点击放大。
   配合两处产出：
     · layouts/_default/_markup/render-image.html（旅游文章的 markdown 图片）
     · layouts/shortcodes/score.html（乐谱短代码）
   两者都会输出 <a class="glightbox"> 包着一张 <img>，这个脚本只负责「怎么摆」。

   ── 一、自动排版 ──
   把正文里**连续相邻**的图片并成一行，用纯 CSS 的 justified 布局：
       flex-basis 正比于宽高比 + flex-grow 也正比于宽高比
   这样一行里的图必然等高，且等比缩放、不裁切、不留缝。
   （如果 flex-basis 是个固定值，就会出现「宽度 = 固定值 + 按比例分的剩余空间」，
     高度就不再相等 —— 所以 basis 必须跟着宽高比走。）

   只有 1 张的「连续段」不并排，保持独占整行（全宽）。所以：
       [图]              → 全宽
       [图][图][图]      → 一行
       [图]  [文字] [图] → 各自全宽（中间隔着文字就不算连续）

   ⚠️ 一个容易漏掉的情形：**图片之间没有空行时，Goldmark 会把它们塞进同一个 <p>**。
       ![a](1.jpg)
       ![b](2.jpg)
     这一对是「同一段里的两张图」，不是两段。所以判断单元不能是「段落」，
     必须是「段落里的图」—— 一个段落可能有 1 张，也可能有好几张，
     都得能参与并排。

   ── 二、宽高比从哪来 ──
   优先用服务端给的 data-width/data-height（Hugo 读出来的真实像素），
   没有就退到 <img> 的 width/height 属性，再没有就等图加载完量 naturalWidth。
   这个顺序很重要：前两个在图片下载之前就可用，布局不会先撑错再跳。

   ── 三、为什么要在这里初始化 GLightbox ──
   GLightbox 在 init 时按选择器收集元素，所以必须**先并排、后 init**，
   否则它记下的位置和实际 DOM 对不上（左右翻页的顺序会乱）。
*/

(function () {
    'use strict';

    var CONTENT = '.post-content';
    var LINK = 'a.glightbox';
    var MIN_RUN = 2;   // 连续几张才并排；1 张保持全宽

    var booted = false;

    /* 取一个节点里「能参与并排的那些图」。
       段落里只有图（没有别的文字）才算数 —— 夹在句子中间的图不并排。
       返回 null 表示这个节点不是「纯图片容器」，应当打断连续性。 */
    function imageLinks(node) {
        if (node.nodeType !== 1) return null;
        if (node.matches(LINK)) return [node];
        if (node.tagName !== 'P') return null;

        var links = Array.prototype.slice.call(node.querySelectorAll(LINK));
        if (links.length === 0) return null;
        if (node.querySelector('img') === null) return null;
        // 段里还有可见文字就不算「纯图片段落」。
        // （<img> 和它的 alt 都不进 textContent，所以纯图片段的 textContent 是空的。）
        if (node.textContent.replace(/\s+/g, '') !== '') return null;
        return links;
    }

    /* 量宽高比，写进 --ar。取不到就等它加载完再量。 */
    function setRatio(link) {
        var w = parseFloat(link.getAttribute('data-width'));
        var h = parseFloat(link.getAttribute('data-height'));
        var img = link.querySelector('img');

        if (!(w > 0 && h > 0) && img !== null) {
            w = parseFloat(img.getAttribute('width'));
            h = parseFloat(img.getAttribute('height'));
        }
        if (w > 0 && h > 0) {
            link.style.setProperty('--ar', String(w / h));
            return;
        }
        if (img === null) return;
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
            link.style.setProperty('--ar', String(img.naturalWidth / img.naturalHeight));
            return;
        }
        img.addEventListener('load', function () {
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                link.style.setProperty('--ar', String(img.naturalWidth / img.naturalHeight));
            }
        }, { once: true });
    }

    /* 把一段连续的图并成一行。run 是扁平的 { para, link } 列表 ——
       同一个 para 可能贡献多张图（图片之间没空行的情况）。 */
    function wrap(run) {
        var host = run[0].para.parentNode;
        if (host === null) return;

        var box = document.createElement('div');
        box.className = 'gallery';
        host.insertBefore(box, run[0].para);

        var paras = [];
        run.forEach(function (item) {
            item.link.parentNode.removeChild(item.link);
            box.appendChild(item.link);
            if (paras.indexOf(item.para) === -1) paras.push(item.para);
        });

        // 图被掏走之后没剩下东西的段落删掉，别留一堆空段落占间距。
        // （para 有时就是 link 自己 —— 短代码直接输出的那种裸 <a> ——
        //   此时它里面还装着 <img>，下面这个判断会把它留下。）
        paras.forEach(function (para) {
            if (para.parentNode === null) return;
            if (para.querySelector('img') === null && para.textContent.replace(/\s+/g, '') === '') {
                para.parentNode.removeChild(para);
            }
        });
    }

    /* 扫一遍容器的直接子节点，找出连续的图 */
    function group(root) {
        var nodes = Array.prototype.slice.call(root.childNodes);
        var run = [];

        function flush() {
            if (run.length >= MIN_RUN) wrap(run);
            run = [];
        }

        nodes.forEach(function (node) {
            // 段落之间的换行/缩进是文本节点，不能拿它打断连续性 ——
            // markdown 里「连续几行图片」中间就隔着这种空白。
            if (node.nodeType === 3) {
                if (node.textContent.replace(/\s+/g, '') === '') return;
                flush();
                return;
            }

            var links = imageLinks(node);
            if (links === null) {
                flush();
                return;
            }
            links.forEach(function (link) {
                // 每张图都先量好比例 —— 跟它最后会不会成组无关。
                // 只给「成组的那几张」量也行（CSS 目前只有 .gallery 用到 --ar），
                // 但统一量掉更省心：将来想给单图加限制（比如压一压超宽全景图），
                // 不用再回来改这里。
                setRatio(link);
                run.push({ para: node, link: link });
            });
        });
        flush();
    }

    function boot() {
        if (booted) return;

        var roots = document.querySelectorAll(CONTENT);
        // 脚本正常情况下在 </body> 前，上面的正文已经解析完了，
        // 所以这里能立刻排版、不会先画一遍再重排。
        // 万一以后被挪进 <head>，就等 DOM 好了再来。
        if (roots.length === 0 && document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', boot, { once: true });
            return;
        }
        booted = true;

        Array.prototype.forEach.call(roots, group);

        if (typeof GLightbox !== 'function') return;
        GLightbox({
            selector: LINK,
            touchNavigation: true,      // 手机上左右滑
            keyboardNavigation: true,   // ← → Esc
            loop: true,                 // 翻到最后一张再往后就回到第一张
            zoomable: true,             // 滚轮 / 双指缩放（乐谱要看细节全靠它）
            draggable: true,
            closeOnOutsideClick: true,
            openEffect: 'zoom',
            slideEffect: 'slide'
        });
    }

    boot();
})();
