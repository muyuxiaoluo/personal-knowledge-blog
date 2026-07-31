---
title: 人生攻略库
created: 2026-06-02
updated: 2026-06-03
branch: 待分类
subbranch:
stage: 已整理
validity: 待验证
category: 首页
tags: [知识库, 工作台, 数字花园]
type: 思考
project: 个人知识库博客
confidence: 中
source: [复盘]
reviewDate: 2026-07-02
summary: 一个本地个人知识工作台，用来记录经验、整理认知变化和长期复盘。
next: 围绕知识树、内容管理和复盘搜索持续沉淀内容。
layout: home
---

<div class="home-console">
<section class="kb-hero">
<div class="kb-hero-main">
<div class="kb-version">v2.0</div>
<div class="kb-eyebrow">人生攻略库 / 个人知识工作台</div>
<h1>把经验、思考和复盘长成一棵树</h1>
<div class="kb-badges">
<span class="kb-badge">经验整理</span>
<span class="kb-badge">思考随笔</span>
<span class="kb-badge warm">复盘记录</span>
</div>
</div>
</section>

<section class="kb-dashboard">
<div class="kb-section full">
<h2>今天从这里开始</h2>
<div class="kb-action-grid five">
<a class="kb-action-card primary" href="./write">
<span class="kb-action-icon">✎</span>
<h3>写一条新经验</h3>
<p>先记录发生了什么，再决定它属于哪条主线</p>
</a>
<a class="kb-action-card" href="./tree">
<span class="kb-action-icon">⌘</span>
<h3>知识树</h3>
<p>查看自己在哪条主线、哪个子分支、哪篇内容下</p>
</a>
<a class="kb-action-card" href="./manage">
<span class="kb-action-icon">▤</span>
<h3>内容管理</h3>
<p>统一编辑、整理、归档、移动和软删除</p>
</a>
<a class="kb-action-card" href="./review-search">
<span class="kb-action-icon">⌕</span>
<h3>复盘搜索</h3>
<p>筛选周复盘、项目复盘、工具测试和决策记录</p>
</a>
<a class="kb-action-card" href="./projects/">
<span class="kb-action-icon">□</span>
<h3>项目档案</h3>
<p>按 project 字段横向聚合相关经验和复盘</p>
</a>
</div>
</div>

<div class="kb-section full">
<h2>三条主线</h2>
<div class="kb-grid three">
<a class="kb-card" href="./tree?branch=经验整理">
<h3>经验整理</h3>
<p>沉淀方法，避免重复踩坑</p>
<div class="kb-badges">
<span class="kb-badge">工具经验</span>
<span class="kb-badge">工作流方法</span>
</div>
</a>
<a class="kb-card" href="./tree?branch=思考随笔">
<h3>思考随笔</h3>
<p>记录认知变化，整理复杂感受</p>
<div class="kb-badges">
<span class="kb-badge">AI时代与焦虑</span>
<span class="kb-badge">信息茧房</span>
</div>
</a>
<a class="kb-card" href="./tree?branch=复盘记录">
<h3>复盘记录</h3>
<p>校准行动，从周/月/项目中调整方向</p>
<div class="kb-badges">
<span class="kb-badge">周复盘</span>
<span class="kb-badge">项目复盘</span>
</div>
</a>
</div>
</div>

<div class="kb-section full kb-focus">
<h2>本周只推进</h2>
<p>把每条内容补上 branch 和 subbranch，让知识树先跑起来</p>
<div class="kb-badges">
<span class="kb-badge warm">聚焦</span>
<span class="kb-badge">内容定位</span>
<span class="kb-badge">不做 CMS</span>
</div>
</div>

<div class="kb-section full">
<h2>最近更新</h2>
<ArticleBrowser :limit="3" />
</div>
</section>
</div>
