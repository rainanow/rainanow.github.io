+++
date = '2026-09-12T20:56:46+08:00'
draft = false
title = 'Hugo 折腾记录'
tags = ["博客"]
categories = ["技术"]
+++

## 🎯 最终成果

| 项目 | 内容 |
| :--- | :--- |
| **博客地址** | `https://rainanow.github.io`（已绑定自己的域名） |
| **博客标题** | 雨落的小屋 |
| **框架** | Hugo（extended 版，v0.166.0） |
| **主题** | PaperMod |
| **托管** | GitHub Pages |
| **部署方式** | GitHub Actions 自动构建 |
| **本地路径** | `C:\Users\rain\Documents\yulo` |

<!--more-->

---

## 📖 我是怎么一步步搭起来的

### 1. 装 Hugo

去 GitHub Releases 下载了 `hugo_extended_0.166.0_windows-amd64.zip`，解压后把 `hugo.exe` 放到 `C:\hugo\bin`，再把这个路径加到系统环境变量里。打开命令行输 `hugo version`，看到 `extended` 就说明装好了。

### 2. 创建站点

```powershell
cd C:\Users\rain\Documents\yulo
hugo new site . --force
```

### 3. 装主题

选的是 PaperMod，因为用的人多、文档全、遇到问题好搜。

```bash
git init
git submodule add https://gitee.com/hitweston/paper-mod.git themes/PaperMod
```

### 4. 配置 `hugo.toml`

这部分折腾了一会儿，踩了几个坑：

- `socialIcons` 一开始放错了位置，必须放在 `[params]` 里面
- TOML 的 `true`/`false` 不能加引号，加了就报错
- Hugo v0.166.0 要在 `[params]` 里补一个 `author`，不然 RSS 模板会报错

最后把 `baseURL`、`title`、`theme`、`author`、`profileMode`、`socialIcons`、`[menu]` 这些都配好了。

### 5. 写文章

```bash
hugo new content content/posts/文章名.md
```

把 `draft = true` 改成 `false`，正文用 Markdown 写。

### 6. 本地预览

```bash
hugo server -D
```

浏览器打开 `http://localhost:1313/` 看效果。

### 7. 推送到 GitHub

```bash
git add . && git commit -m "first commit" && git branch -M main && git remote add origin git@github.com:rainanow/rainanow.github.io.git && git push -u origin main
```

第一次推送被拒了，因为远程仓库里有旧内容，用 `--force` 强制覆盖才成功。

### 8. 配 GitHub Actions

创建了 `.github/workflows/hugo.yaml`，然后在仓库 `Settings` → `Pages` 里把 Source 改成 **GitHub Actions**。之后每次 `git push`，GitHub 就自动帮我构建和发布。

### 9. 绑定自己的域名

- 在 `static/` 下建了个 `CNAME` 文件，里面只写我的域名
- 在 GitHub 仓库 `Settings` → `Pages` → Custom domain 填上域名
- 去域名平台加了 4 条 A 记录和 1 条 CNAME 记录
- 等 DNS 生效后勾了 **Enforce HTTPS**

---

## ✍️ 我以后怎么发文章

```bash
hugo new content content/posts/新文章.md
```

编辑保存后：

```bash
git add . && git commit -m "发布新文章" && git push
```

等 1-2 分钟，刷新域名就能看到。

---

## 🧠 我搞懂的几个概念

| 概念 | 我的理解 |
| :--- | :--- |
| **YAML vs TOML** | Hexo 用 YAML（`---` 包裹），Hugo 用 TOML（`+++` 包裹），正文都是 Markdown |
| **Front-matter** | 文章开头的配置区，写标题、日期、标签这些 |
| **Git Submodule** | 主题用子模块方式装，以后更新方便 |
| **GitHub Actions** | 我 push 之后，GitHub 自动帮我构建部署，不用本地手动生成 |
| **CNAME** | 告诉 GitHub 我的自定义域名是什么 |
| **DNS 解析** | A 记录指向 GitHub 的 IP，CNAME 指向 `rainanow.github.io`，最后再把自定义域名填进 `baseURL` |

---

## 📂 我的目录结构

```
yulo/
├── .github/workflows/hugo.yaml   ← Actions 配置
├── .gitignore                     ← 忽略 public/ 这些
├── .gitmodules                    ← 子模块配置
├── archetypes/default.md
├── content/
│   ├── posts/                     ← 文章都放这儿
│   └── about.md
├── hugo.toml                      ← 站点配置
├── static/
│   ├── CNAME                      ← 我的域名
│   └── img/touxiang.jpg           ← 头像
└── themes/PaperMod/               ← 主题
```

---

## 🔄 从 Hexo 换到 Hugo，我的感受

| 对比项 | Hexo | Hugo |
| :--- | :--- | :--- |
| **安装** | 要装 Node.js + npm | 一个二进制文件搞定 |
| **构建速度** | 有点慢 | 快得离谱 |
| **部署** | 本地生成完再推 | GitHub Actions 自动构建 |
| **文章格式** | YAML（`---`） | TOML（`+++`），也支持 YAML |
| **日常流程** | `hexo g && hexo d` | `git add && commit && push` |

Hugo 最让我舒服的是：**push 完就不用管了**，GitHub 自己会构建发布。

---

## ✅ 我现在拥有的

- 一个完全免费的静态博客
- 自己的域名 + HTTPS
- 自动部署流水线，写完 push 就行
- 干净的本地环境
- 以后想换主题、加功能都有很大空间