---
title: 搭建博客
date: 2026-09-11 8:50:29
tags: 折腾
---

### 第一阶段：本地环境准备
- 安装 **Node.js**（验证 `node -v` 正常）
- 安装 **Git**（用 `git --version` 验证，注意是两个短横线）

### 第二阶段：本地搭建 Hexo
- 全局安装 Hexo 命令行工具：`npm install -g hexo-cli`
- 初始化博客：`hexo init my-blog`（中途 GitHub 连接失败，Hexo 自动用了备用方案）
- 安装依赖：`npm install`
- 本地预览：`hexo server`，浏览器访问 `http://localhost:4000` 成功
- 把博客文件夹挪到 `c:\Users\rain\Documents\blog`，并改了名字

### 第三阶段：创建 GitHub 仓库
- 创建仓库 `rainanow.GitHub.io`，后改名为全小写 `rainanow.github.io`
- 可见性选 **Public**
- 不勾 README、.gitignore、license

### 第四阶段：配置 SSH 密钥
- 生成密钥：`ssh-keygen -t rsa -C "2418331674@qq.com"`（注意是大写 `-C`）
- 复制公钥：`type C:\Users\rain\.ssh\id_rsa.pub`
- 到 GitHub 的 `Settings → SSH and GPG keys` 添加公钥
- 验证：`ssh -T git@github.com`，看到 `Hi rainanow!` 即成功

### 第五阶段：配置部署并上线
- 安装部署插件：`npm install hexo-deployer-git --save`
- 修改 `_config.yml`：
  - 站点信息：`title: 雨落`、`author: yulo`、`language: zh-CN`
  - `url: https://rainanow.github.io`
  - 底部 `deploy` 部分改成 git 类型，指向你的仓库
- 配置 Git 身份：`git config --global user.name` 和 `user.email`
- 一键部署：`hexo clean && hexo g && hexo d`
- 访问 `https://rainanow.github.io` 成功

### 📌 过程中踩过的坑
| 问题 | 原因 | 解决 |
| :--- | :--- | :--- |
| `git -version` 报错 | 少了一个短横线 | 改成 `git --version` |
| `hexo init` 卡住 | GitHub 连接不稳定 | 等 Hexo 自动用备用方案 |
| 多出 `hello-word.md` | 文件名拼写错误 | 删掉多余文件 |
| YAML 解析报错 | `tags:qwq` 少了空格 | 改成 `tags: qwq` |
| 部署时报 Author identity unknown | Git 不知道你是谁 | 配置 `user.name` 和 `user.email` |

### 🚀 以后写博客的日常流程
```bash
hexo new "文章标题"    # 创建文章
# 编辑 source/_posts/ 下的 .md 文件
hexo clean && hexo g && hexo d    # 一键发布
```

---

整个过程你从完全不懂，到最后有了一个可以访问的线上博客。接下来如果还想优化，可以考虑换主题、绑域名、加评论系统，随时可以继续。