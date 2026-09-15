# 雨落的小屋 — 项目交接文档

> 最后更新：2026-09-14
> 交接对象：接手这个博客维护工作的人（很可能是几个月后的雨落本人）

---

## 1. 这个项目是什么

一个用 **Hugo** 搭建、托管在 **GitHub Pages** 上的中文个人博客，主题是 **PaperMod**。

- **线上地址**：http://yulo.top
- **GitHub 仓库**：https://github.com/rainanow/rainanow.github.io
- **本地路径**：`C:\Users\rain\Documents\yulo`
- **内容定位**：日记 + 折腾笔记（目前 4 篇文章）

写博客的目的（作者原话，见 `content/posts/26-9-10.md`）：被高中老师一句"时间过得真快呀，都长大啦"触动，想留下点什么、记录点什么。

---

## 2. 技术栈与版本

| 项目 | 值 | 说明 |
|---|---|---|
| Hugo | **v0.166.0 extended** | 必须是 extended 版，普通版无法处理图片资源 |
| 主题 | PaperMod（MIT） | 通过 **git submodule** 引入 |
| 主题源 | `https://gitee.com/hitweston/paper-mod.git` | ⚠️ 是 Gitee 镜像，**不是**官方仓库，见第 9 节 |
| 托管 | GitHub Pages | 仓库 `main` 分支 |
| 部署 | GitHub Actions | `.github/workflows/hugo.yaml` |
| 语言 | 中文（zh），单语言 | |
| 评论 | Giscus | 基于仓库的 GitHub Discussions |

### 本地环境要求

```powershell
# 检查 Hugo 是否装好，必须看到 extended
hugo version
# 期望输出类似：hugo v0.166.0-...+extended windows/amd64
```

Hugo 装法（当初的做法）：从 GitHub Releases 下载 `hugo_extended_0.166.0_windows-amd64.zip`，解压把 `hugo.exe` 放到 `C:\hugo\bin`，再把这个路径加进系统环境变量 `PATH`。

---

## 3. 日常操作：写一篇新文章

这是最常用的流程，**只需要记住这一节**。

### 3.1 新建文章

```powershell
cd C:\Users\rain\Documents\yulo
hugo new content content/posts/文章文件名.md
```

生成的 md 文件开头是 front matter（`archetypes/default.md` 决定的）：

```toml
+++
date = '2026-09-14T10:00:00+08:00'
draft = true
title = '文章文件名'
+++
```

**必须改的两处：**

1. `title` — 现在是自动从文件名生成的，比如 `26 9 11` 这种，**建议改成有意义的中文标题**（如 `9月11日：论文通过`）。列表页、归档页、搜索、RSS 全都用这个标题。
2. `draft = true` → `draft = false` — 不改的话文章**不会发布**。

**建议加的两处：**

```toml
tags = ["日记"]           # 标签，会生成 /tags/日记/ 页面
categories = ["日记"]     # 分类
```

### 3.2 写正文 + 摘要标记（重要）

正文用 Markdown 写。**写完之后，在第一段末尾加一行 `<!--more-->`**：

```markdown
第一段，概括今天发生了什么。

<!--more-->

后面是正文的其余部分……
```

这一行决定了**列表页和 RSS 里显示多少内容**。不加的话，Hugo 会把接近整篇文章都塞进摘要里（中文尤其严重，因为 Hugo 按空格数词）。

> ⚠️ **不要把 `<!--more-->` 放在标题正下方**。那样摘要里就只剩标题了，比不加还糟。位置是"**第一段之后**"。

### 3.3 本地预览

```powershell
hugo server -D
```

浏览器打开 `http://localhost:1313/`。`-D` 表示连草稿一起预览。

> 💡 **本地预览时站点内链接会指向 `https://yulo.top`，点了会跳到线上**。这是正常的（`baseURL` 配的就是这个域名），不是你改坏了。

### 3.4 发布

```powershell
git add .
git commit -m "发布新文章"
git push
```

等 1～2 分钟，GitHub Actions 自动构建并部署。刷新 http://yulo.top 就能看到。

> 部署进度可在仓库的 **Actions** 标签页查看。

---

## 4. 目录结构

```
yulo/
├── .github/workflows/hugo.yaml    ← GitHub Actions 部署配置
├── .gitignore                     ← 忽略 public/、resources/、.hugo_cache/ 等
├── .gitmodules                    ← 主题子模块配置
├── hugo.toml                      ← 【核心】站点配置，改功能基本都在这
├── archetypes/default.md          ← hugo new 生成文章的模板
├── content/
│   ├── about.md                   ← 「关于」页
│   ├── archives.md                ← 「归档」页（layout = archives）
│   ├── search.md                  ← 「搜索」页（layout = search）
│   └── posts/
│       ├── _index.md              ← 只需一行 title，把列表页标题从 "Posts" 改成「文章」
│       ├── 26-9-10.md             ← 日记
│       ├── 26-9-12.md             ← 日记
│       ├── hello-word.md          ← Hexo 搭建记录
│       └── hugo-blog-setup.md     ← Hugo 搭建记录
├── layouts/partials/              ← 【自定义覆盖】见第 5 节
│   ├── comments.html              ← Giscus 评论
│   ├── extend_head.html           ← 卜算子计数脚本
│   ├── extend_footer.html         ← 卜算子页脚显示
│   └── post_meta.html             ← 文章头部元信息
├── static/
│   ├── CNAME                      ← 内容就一行：yulo.top
│   ├── favicon.svg / .ico / -16x16.png / -32x32.png
│   ├── apple-touch-icon.png
│   ├── safari-pinned-tab.svg
│   └── img/touxiang.jpg           ← 头像
├── themes/PaperMod/               ← 主题（git submodule，不要手动改）
└── public/                        ← 构建产物，已 gitignore，可随时删
```

---

## 5. `layouts/partials/` 里的自定义覆盖（核心知识）

PaperMod 允许用**同名文件**覆盖主题自带模板。这个项目覆盖了 4 个 partial。

### ⚠️ 覆盖 = 整个替换，不是追加

**这是这个项目踩过的最大一个坑。** 当初有人为了加"本文阅读量"，写了个只包含阅读量的 `post_meta.html`，结果把主题原本渲染的**日期、阅读时长、字数、作者全都挤掉了**——因为 Hugo 的 partial 覆盖是整块替换。

所以下面每个文件都在注释里写明了是"照抄主题原版 + 追加"。

### 5.1 `extend_head.html`

在上面那个坑修复之前，这个文件叫 `extend_head**r**.html`（多个字母 `r`）。主题调用的是 `extend_head.html`，所以脚本**从来没被加载过**——页脚一直显示"本站总访问量　次"（空数字）。

**教训：文件名必须和主题里调用的名字逐字一致。** 对照位置：`themes/PaperMod/layouts/partials/head.html:197`。

内容：加载卜算子（busuanzi）统计脚本。

### 5.2 `extend_footer.html`

显示"本站总访问量 X 次 / 本站访客数 Y 人次"。

**注意：** 内部的 span id 是卜算子规定的固定名字（`busuanzi_value_site_pv`、`busuanzi_value_site_uv`），**不能随便改**，改了就显示不出数字。曾经误改成 `busuanzi_value_uv`，已修正。

### 5.3 `post_meta.html`

文章头部的元信息行 + 列表页每条的时间行。当前输出：

```
2026年9月10日 · 2 分钟 · 868 字 · 雨落 · 本文阅读量 X 次
```

### 5.4 `comments.html`

Giscus 评论组件，配置从 `hugo.toml` 的 `[params.giscus]` 读取。

单独关闭某篇文章的评论：在该文章 front matter 里加 `comments = false`。

---

## 6. `hugo.toml` 逐项说明

按配置文件里的顺序。

### 顶部基础项

| 配置 | 值 | 说明 |
|---|---|---|
| `baseURL` | `https://yulo.top/` | 站点根地址 |
| `title` | `雨落的小屋` | |
| `theme` | `PaperMod` | |
| `defaultContentLanguage` | `zh` | 见下方"语言"说明 |
| `hasCJKLanguage` | `true` | **见下方"中文分词"说明，很重要** |

#### 语言设置（`[languages]`）—— 为什么 key 必须是 `zh`

主题的中文翻译文件叫 **`themes/PaperMod/i18n/zh.yaml`**，**没有 `zh-cn.yaml`**。

- key 写 `zh` → 界面显示「上一页 / 下一页 / 目录 / 主页 / 编辑 / 分钟」
- key 写 `zh-cn` 或不写 `[languages]` → Hugo 默认键是 `en`，**整个界面变英文**（Home / Table of Contents / Prev / Next / min）

另外：顶层的 `locale = 'zh-cn'` **只影响 RSS 和 og:locale，不影响主题模板**，所以别指望靠它改界面语言。

#### 中文分词（`hasCJKLanguage = true`）

Hugo 默认按"空格"数词。中文没有空格，于是整篇日记被算成 1 个词，**每篇文章的阅读时长都显示"1 分钟"**。

实测对比（以 `26-9-10.md` 为例）：

| 设置 | 阅读时长 |
|---|---|
| 不写（默认 false） | 1 分钟 |
| `hasCJKLanguage = true` | **2 分钟** |

> ⚠️ 这个开关**只修阅读时长和字数，不修列表页摘要**。摘要必须用 `<!--more-->` 控制（见 3.2）。这一点容易搞混——`summaryLength` 对中文**完全无效**，实测过 15 / 40 / 默认三个值，摘要长度一模一样。

### `[params]` — 基础信息

| 配置 | 说明 |
|---|---|
| `author` | 文章和 RSS 里的作者名 |
| `description` | SEO 和社交分享用 |
| `DateFormat` | `2006年1月2日`（Go 的时间格式）。不写会显示英文 `September 10, 2026` |
| `images` | 分享到微信/QQ/Twitter 时的默认缩略图。不写则 `og:image` **完全不存在**，分享出去没有图 |

### `[params]` — 外观与列表

| 配置 | 值 | 说明 |
|---|---|---|
| `defaultTheme` | `auto` | 跟随系统；也可 `light` / `dark` |
| `disableThemeToggle` | `false` | 是否隐藏明暗切换按钮 |
| `ShowReadingTime` | `true` | 阅读时长 |
| `ShowWordCount` | `true` | 字数（中文按字计） |
| `ShowShareButtons` | `false` | 社交分享按钮（当前关） |
| `ShowPostNavLinks` | `true` | 底部上一篇/下一篇 |
| `ShowBreadCrumbs` | `true` | 面包屑 |
| `ShowCodeCopyButtons` | `true` | 代码块复制按钮 |
| `ShowToc` | `true` | 目录（单篇可在 front matter 覆盖） |
| `comments` | `true` | 评论总开关 |

### `socialIcons`

首页 profileMode 下显示在头像下方。当前 4 个：

```toml
{ name = "github",   url = "https://github.com/rainanow" },
{ name = "bilibili", url = "https://space.bilibili.com/3546734554778324" },
{ name = "email",    url = "mailto:2418331674@qq.com" },
{ name = "rss",      url = "/index.xml" }
```

可用的图标名有 300 多个，写在 `themes/PaperMod/layouts/partials/svg.html`。中文博客常用的还有：`douban`、`juejin`、`zhihu`、`qq`、`wechat`、`neteasecloudmusic`、`steam`、`telegram`、`mastodon`。**名字写错不会报错，只是图标不显示**，所以加之前先在这个文件里搜一下。

### `schema`、`assets`、`editPost`

```toml
schema = { publisherType = "Person" }   # 个人博客。不写会标成 Organization（组织）
assets = { favicon = "/favicon.svg" }   # 主图标用 SVG
editPost = {
  URL = "https://github.com/rainanow/rainanow.github.io/edit/main/content",
  appendFilePath = true                 # 自动拼上文章的 md 路径
}
```

`editPost` 让文章标题栏出现「编辑」链接，点进去是 GitHub 网页编辑器里对应的 md 文件，手机上改错别字很方便。

### `profileMode`（首页）

```toml
profileMode = {
  enabled = true,
  title = "雨落",
  subtitle = "喜欢数码，热爱生活，喜欢到处乱逛",
  imageUrl = "/img/touxiang.jpg",
  imageWidth = 120,
  imageHeight = 120,
  buttons = [
    { name = "文章", url = "/posts" },
    { name = "关于", url = "/about" }
  ]
}
```

想换成普通列表首页：`enabled = false`。

### `[params.busuanzi]` 与 `[params.giscus]`

```toml
[params.busuanzi]
  enable = true

[params.giscus]
  enable = true
  repo = "rainanow/rainanow.github.io"
  repoId = "R_kgDOUU9-cg"
  category = "General"
  categoryId = "DIC_kwDOUU9-cs4Cw2w5"
  mapping = "pathname"
  reactionsEnabled = "1"
  inputPosition = "bottom"
  theme = "preferred_color_scheme"
```

- `repoId` 来自 https://api.github.com/repos/rainanow/rainanow.github.io 的 `node_id`
- `categoryId` 对应仓库 Discussions 里的 `General` 分类
- 换分类：仓库 → Discussions → 分类右侧编辑，或去 https://giscus.app 自动生成配置
- `mapping = "pathname"` 表示按页面路径关联评论。**注意：改了文章 URL 会丢评论。**

### `[menu]`

顶部导航，5 项：文章 / 归档 / 标签 / 搜索 / 关于。`weight` 控制顺序，数字小的在前。

### `[markup.highlight]`

```toml
[markup]
  [markup.highlight]
    noClasses = false
```

让 Hugo 输出 CSS class 而不是内联样式。**不写的话代码块颜色会写死成 Monokai 深色**，切换到浅色模式时代码块还是黑的。配色直接复用主题自带的 chroma 样式表，不需要额外配置。

### `[outputs]` 与待启用的 robots.txt / llms.txt

当前：

```toml
[outputs]
  home = ["HTML", "RSS", "JSON"]
```

**`robots.txt` 和 `llms.txt` 目前注释掉了**（博客还在测试期，不想被搜索引擎收录）。

以后想启用，按文件末尾注释里的说明**两步都要做**：

```toml
home = ["HTML", "RSS", "JSON", "robotsTXT", "LLMS"]
```

```toml
[outputFormats.robotsTXT]
  mediaType = "text/plain"
  baseName = "robots"
  isPlainText = true
  notAlternative = true

[outputFormats.LLMS]
  mediaType = "text/plain"
  baseName = "llms"
  isPlainText = true
  notAlternative = true
```

> ⚠️ **只改 `outputs` 是无效的。** Hugo 没有内置这两种输出格式，主题虽然自带模板，但必须同时声明 `[outputFormats.*]` 才会渲染。

---

## 7. 部署流程

`.github/workflows/hugo.yaml` 的逻辑：

1. 装 Hugo 0.166.0 extended
2. checkout（`submodules: recursive`，所以主题会被一起拉下来）
3. `actions/configure-pages@v5` 取得站点 URL
4. 构建：`hugo --minify --baseURL "${{ steps.pages.outputs.base_url }}/"`
5. 上传 `public/` 并部署到 Pages

**触发条件**：推送到 `main` 分支，或在 Actions 页面手动触发（`workflow_dispatch`）。

### ⚠️ 一个容易困惑的点：为什么 `baseURL` 是两处

`hugo.toml` 里写了 `baseURL = 'https://yulo.top/'`，但 workflow 里又用 `--baseURL` **覆盖**了它，取的是 GitHub Pages API 返回的地址。

后果：**线上 canonical 链接取决于 GitHub Pages 的设置，而不是 `hugo.toml`**。目前线上仍然是 `http://`，原因见第 9 节。

`hugo.toml` 里的 `baseURL` 主要影响**本地 `hugo server` 预览**时的链接。

---

## 8. 主题更新

主题是 git submodule，**不要直接改 `themes/PaperMod/` 里的文件**——改了会在下次更新时冲突或被覆盖。

### 更新主题

```powershell
cd themes/PaperMod
git pull origin master
cd ../..
git add themes/PaperMod
git commit -m "更新 PaperMod 主题"
git push
```

### ⚠️ 更新主题后必须检查的 4 个文件

因为 `layouts/partials/` 里覆盖了主题模板，**主题升级后原版逻辑可能变了，覆盖文件不会自动同步**：

| 文件 | 检查什么 |
|---|---|
| `post_meta.html` | 对比 `themes/PaperMod/layouts/partials/post_meta.html`，看主题有没有新增/修改渲染逻辑 |
| `extend_head.html` | 确认主题仍在调用这个名字（搜 `extend_head`） |
| `extend_footer.html` | 同上 |
| `comments.html` | 确认 `single.html` 的调用方式没变 |

**如何对比**：直接打开两边的文件目视对比即可。

---

## 9. 已知问题与待办（交接重点）

按优先级排列。

### 🔴 P0：HTTPS 未启用

**现象**：线上 http://yulo.top 能访问，但 https 打不开；页面里所有 canonical 链接都是 `http://`。

**原因**：GitHub 仓库 Settings → Pages 里的 **"Enforce HTTPS" 没勾**。

**修法（不用改代码）**：仓库 → Settings → Pages → 勾选 **Enforce HTTPS**。下次构建后全站自动变 https。

**为什么紧急**：`giscus.app` 是 https 资源。页面在 http 下，浏览器会拦截，**评论区显示不出来**。修好 HTTPS 之前，Giscus 等于白配。

### 🟠 P1：article 页面的评论区未在线上验证

本地构建产物里 giscus 标签是正常的，但线上是 http，评论实际能不能加载出来，**需要在 HTTPS 修好后亲自去线上文章页确认一次**。

### 🟡 P2：文章文件名与标题不规范

现有 4 篇：

| 文件 | 当前标题 | 问题 |
|---|---|---|
| `26-9-10.md` | `26 9 10` | 标题无意义 |
| `26-9-12.md` | `26 9 11` | ⚠️ **文件名是 9-12，标题和日期却是 9-11**，两者不一致 |
| `hello-word.md` | `Hello World` | URL 是 `hello-word`，拼写遗留 |
| `hugo-blog-setup.md` | `我的 Hugo 博客搭建记录` | 正常 |

建议给日记改成有意义的标题（如 `9月11日：论文通过`）。**改标题不影响 URL**，安全。

### 🟡 P3：永久链接结构（时间敏感，需要决策）

当前 URL 是 `/posts/26-9-10/`。可以改成按年月分目录：

```toml
[permalinks]
  posts = '/posts/:year/:month/:slug/'
```

结果：`/posts/2026/09/26-9-10/`

**⏰ 要改就趁现在**——站还很新、几乎没有外部链接。等以后有了友链和搜索引擎收录，改一次就会断掉所有旧链接，还得额外配跳转。

**注意**：改了 URL 之后，`mapping = "pathname"` 的 Giscus 会把评论当新页面，**已有评论会"丢失"**（其实还在 GitHub Discussions 里，但不再显示）。目前线上还没有真实评论，所以现在改代价最小。

### 🟢 P4：可选增强（都还没做）

| 项目 | 做法 | 成本 |
|---|---|---|
| 页脚版权声明 | `[params] copyright = "..."`，主题会自动渲染在页脚 | 一行 |
| 头像 alt 文案 | `profileMode.imageTitle`，现在英文是 `profile image` | 一行 |
| 站点运行时间 | 在 `extend_footer.html` 里用 Go 模板算，零 JS | 小 |
| 改进 `archetypes/default.md` | 预填 `tags`/`categories`，省得每次手写 | 小 |
| 封面图 | front matter 加 `cover.image`，会自动生成响应式图并作为 `og:image` | 中 |
| 留言板 | 建 `content/guestbook.md`，front matter 加 `comments: true`，再挂到菜单 | 小 |

---

## 10. 明确不建议做的事

这些是评估过、**刻意不做**的。如果以后有人想加，请先看这里的理由。

| 想加的东西 | 为什么不做 |
|---|---|
| 看板娘 / Live2D | 几百 KB 的 JS + 模型资源，依赖 CDN，模型还常有非商用许可限制。作者当初就是因为"太重了"才放弃 Hexo butterfly 主题的 |
| 鼠标点击特效 / 背景特效 | 纯装饰，同上 |
| 音乐播放器 | 网易云 API 有法律灰区，自建 Meting 又要后端 |
| 说说 / 碎碎念 | 「日记」标签**本身就是**短内容流，加独立功能反而把内容割裂了。而且 Hugo 没有原生的静态方案，Memos 要 Docker，Artitalk 后端在下线 |
| 打赏 | 学生博客，容易招垃圾 |
| 文章加密 | 静态站的加密是**伪加密**，内容仍在 HTML 里。不想公开就别发 |
| 独立的 `series` 分类 | 只有两三篇教程，还不值得 |
| 每日一句 / 每日诗词 | 多一个第三方运行时依赖和网络请求，提供方还要求挂署名链接 |
| 阅读进度条 | 收益小，却要给一个刻意做轻的主题加 JS |

---

## 11. 常见故障排查

### 构建失败 / 线上没更新

1. 去仓库 **Actions** 标签页看日志，找红色的 `ERROR`
2. 本地先复现：`hugo --gc --minify`，看是否报错
3. 本地没问题但线上失败 → 多半是主题子模块没拉全，检查 Actions 日志里有没有 `submodules`

### 本地构建报 `Access is denied` 写缓存失败

Hugo 默认把缓存写到用户目录。如果受限，指定到项目内：

```powershell
$env:HUGO_CACHEDIR = "C:\Users\rain\Documents\yulo\.hugo_cache"
hugo --gc --minify
```

（`.hugo_cache/` 已在 `.gitignore` 里）

### 本地构建报 deprecation 警告

```
WARN deprecated: .Language.LanguageDirection was deprecated ...
WARN deprecated: .Language.LanguageCode was deprecated ...
```

**主题上游自带的，不影响输出**，等 PaperMod 更新即可，不用管。

### 页面样式错乱 / 中文变英文

先检查 `[languages]` 的 key 是不是 `zh`（见 6.1）。这个配错了整个界面都会变英文。

### 文件编码被写坏（真实踩过的坑）

**不要**用 PowerShell 的 `Get-Content ... | Set-Content ...` 原地改 `hugo.toml` 或任何含中文的文件——PowerShell 默认不按 UTF-8 写，会把中文**逐字节损坏**（`雨落的小屋` → `闆ㄨ惤鐨勫皬灞?`），而且属于二次编码，**不可逆**。

**正确做法**：
- 用编辑器的"另存为 UTF-8"
- 或用工具/api 写文件
- 要临时测试配置改动，**改用 `--config` 指向临时文件**，不要改原文件

判断文件是否还行：

```powershell
$s = New-Object System.Text.UTF8Encoding($false, $true)
try { $s.GetString([IO.File]::ReadAllBytes("hugo.toml")) | Out-Null; "UTF-8 正常" } catch { "已损坏" }
```

### 修改了主题文件导致更新冲突

`themes/PaperMod/` 里的改动会在 `git pull` 时报冲突。要放自定义内容，**正确位置是项目根目录的 `layouts/`**（见第 5 节）。

---

## 12. 关键信息速查

| 项目 | 值 |
|---|---|
| 线上地址 | http://yulo.top |
| 仓库 | https://github.com/rainanow/rainanow.github.io |
| 本地路径 | `C:\Users\rain\Documents\yulo` |
| 主分支 | `main` |
| Hugo 版本 | v0.166.0 extended |
| Giscus repoId | `R_kgDOUU9-cg` |
| Giscus categoryId | `DIC_kwDOUU9-cs4Cw2w5` |
| 卜算子 | 无需注册，脚本自动统计 |
| CNAME | `static/CNAME`，内容：`yulo.top` |

### 有用的链接

- PaperMod 官方 Wiki：https://github.com/adityatelange/hugo-PaperMod/wiki
- PaperMod 变量清单：https://github.com/adityatelange/hugo-PaperMod/wiki/Variables
- PaperMod 图标名清单：`themes/PaperMod/layouts/partials/svg.html`
- Hugo 配置文档：https://gohugo.io/configuration/all/
- Hugo 摘要机制：https://gohugo.io/content-management/summaries/
- Giscus：https://giscus.app

---

## 13. 交接时项目状态（2026-09-14 核实）

以下均为**实际执行命令验证过**的结果，不是凭记忆：

- ✅ 工作区干净，与 `HEAD` 一致，`main` 与 `origin/main` 同步
- ✅ 本地构建通过：`hugo --gc --minify` → 26 个页面，0 错误
- ✅ 线上已部署，http://yulo.top 返回 200
- ✅ 已生效：中文界面、中文日期、字数统计、卜算子、Giscus 标签、favicon、og:image、RSS 图标、编辑链接、`<!--more-->` 摘要
- ⚠️ 线上仍是 **http**（HTTPS 未启用，见 P0）
- ⚠️ 线上 HTTP 响应的 `Cache-Control` 是 `max-age=600`，所以**改完 push 后最多等 10 分钟**才看到变化，不是没部署成功

### 最近一次改动包含什么

提交 `d8ba4c5`（2026-09-13 21:14）是一次较大的修复，包含：

- 修复卜算子文件名拼写错误（`extend_headr.html` → `extend_head.html`）
- 修复 `post_meta.html` 覆盖导致日期/时长/字数/作者消失
- 添加中文本地化（`[languages.zh]` + `defaultContentLanguage` + `DateFormat`）
- 添加 `hasCJKLanguage = true`，修复阅读时长恒为 1 分钟
- 补齐全部 favicon 文件（原先是 5 个 404）
- 接入 Giscus 评论
- 优化 4 篇文章正文、修正标题与日期
- 给 4 篇文章加 `<!--more-->` 摘要标记

> 💡 提交信息目前都是 `update`，不方便回溯。建议以后写清楚，例如 `修复卜算子文件名拼写`、`发布 9月13日日记`。
