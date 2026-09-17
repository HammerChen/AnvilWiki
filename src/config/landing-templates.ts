/**
 * Landing TEMPLATES page copy — the "wiki page templates" showcase
 * (/landing/templates + /zh/landing/templates). Standalone module (v2.32.0),
 * deliberately NOT merged into landing-en/zh.ts — the landing copy modules
 * stay untouched (v2.31.1 split precedent); this file ships with its own
 * interface and is removed together with the whole landing layer by
 * apply-template.
 *
 * Every demo link below points at a REAL page built from src/content/wiki/
 * (verified to exist — a 404 here would sink the page's credibility), so
 * adding/removing demo articles means re-checking the links. Trailing-slash
 * 'always': every internal href ends with "/".
 */

import type { LandingLocale } from './landing-types';

export interface TemplatesPageContent {
  title: string;
  /** Meta description — carries the search-intent framing and volumes. */
  subtitle: string;
  intro: string;
  cardsTitle: string;
  cardsHint: string;
  /** Small cross-link to the comparison page, rendered under the cards. */
  compareNote: { text: string; href: string; label: string };
  /** One card per page type the template produces. */
  cards: {
    name: string;
    description: string;
    /** Template-mechanics bullets — wording kept aligned with
     *  docs/content-format.md; no capabilities the template doesn't have. */
    points: string[];
    /** Demo links (usually one; some page types have two worth showing). */
    links: { label: string; href: string }[];
  }[];
  cta: {
    title: string;
    subtitle: string;
    primaryLabel: string;
    primaryHref: string;
    secondaryLabel: string;
    secondaryHref: string;
  };
}

/** Short header-nav label (desktop + mobile menu), consumed by LandingLayout. */
export const templatesNavLabel: Record<LandingLocale, string> = {
  en: 'Templates',
  zh: '模板展示',
};

export const templatesContent: Record<LandingLocale, TemplatesPageContent> = {
  en: {
    title: 'Game Wiki Page Templates — Every Page Type, Live',
    subtitle:
      '"Wiki page templates" (~870 searches/mo), "wiki template" (~1,000/mo) and "wiki template character" (~1,490/mo — SimilarWeb, 2026-08): people run these searches to see what a game wiki\'s pages actually look like. This page shows every page type the AnvilWiki template produces, each linked to a real page on the live demo.',
    intro:
      'Templates are easier to judge by output than by feature lists. Below is every page type AnvilWiki ships, each card linking to a real page on the demo wiki — a complete wiki for the fictional game "Anvil Quest" at anvil.wiki. Read a page, then picture your game\'s name on it.',
    cardsTitle: 'The page types',
    cardsHint:
      'Every link opens a real page running this template right now — nothing below is a mockup.',
    compareNote: {
      text: 'Weighing AnvilWiki against Fandom or a self-hosted engine?',
      href: '/landing/comparison/',
      label: 'Read the full comparison.',
    },
    cards: [
      {
        name: 'Boss guide',
        description:
          'The traffic workhorse: phase mechanics, strategy and loadouts for one boss fight.',
        points: [
          'Boss stat card rendered from frontmatter (HP, weakness, resist, location, level)',
          'Cover + 2–4 captioned gallery shots; 1200×675 covers generated with pnpm gen-covers',
          'Inline video registered in frontmatter → VideoObject JSON-LD',
        ],
        links: [{ label: 'Stormcaller boss guide', href: '/bosses/stormcaller/' }],
      },
      {
        name: 'Codes page',
        description:
          'The freshness page: every redeem code with reward, status, expiry date and source.',
        points: [
          'Structured codes frontmatter (code / reward / status / expiryDate / source)',
          'Auto-splits into an Active section (one-click copy) and an Expired table — keeps "is X still working" long-tail traffic',
          'FAQPage JSON-LD merged from the faq frontmatter',
        ],
        links: [{ label: 'All working codes', href: '/codes/all-codes/' }],
      },
      {
        name: 'Tier list',
        description:
          'Ranked pages that catch "best X" queries — and get re-searched every patch.',
        points: [
          'gameVersion frontmatter renders a patch badge — a freshness/E-E-A-T signal for fast-patching games',
          'summary frontmatter (a 40–60 word direct answer) → Quick Answer card + AI Overviews candidate',
          'Card images on headline entries',
        ],
        links: [{ label: 'Weapon tier list', href: '/guides/weapon-tier-list/' }],
      },
      {
        name: 'Beginner guide',
        description:
          'Long-form walkthrough pages with media, collapsible detail and cross-links.',
        points: [
          'Gallery layout: optimized covers + captioned shots in reserved zero-CLS boxes',
          'Accordion / Callout components for tips, warnings and collapsible depth',
          'check-content lints every page: no H1, heading order, alt text, ≥3 internal links',
        ],
        links: [{ label: 'Beginner guide', href: '/guides/beginner-guide/' }],
      },
      {
        name: 'Item & equipment pages',
        description:
          'Reference pages for materials, items and gear sets — the tabs players keep pinned while playing.',
        points: [
          'Markdown tables render with site typography — no hand-built HTML',
          'StatBar component for numeric stat comparisons',
          'Same MDX + Zod-validated frontmatter as every other page — one format to learn',
        ],
        links: [
          { label: 'Forging materials guide', href: '/items/forging-materials-guide/' },
          { label: 'Emberforged armor set', href: '/items/emberforged-armor-set/' },
        ],
      },
      {
        name: 'Docs / handbook center',
        description:
          'A docs center with sidebar navigation, on-page TOC and full-site search — the template\'s own bilingual handbook (learn + dev manuals) runs on it.',
        points: [
          'Bilingual (en/zh) with per-page language toggle',
          'Pagefind search scoped by html lang, indexed via data-pagefind-body',
          'The same layout fits game documentation, patch notes or a knowledge base',
        ],
        links: [{ label: 'Open the docs center', href: '/landing/docs/' }],
      },
    ],
    cta: {
      title: 'Every page above is one MDX file',
      subtitle:
        'Fork the template, tell your AI agent "write a boss guide from these notes", and you get a build-passing page — schema-validated, content-linted, deployed free on Cloudflare Pages with 100% of the ad revenue yours.',
      primaryLabel: 'Fork on GitHub',
      primaryHref: 'https://github.com/PNGTRID/AnvilWiki/fork',
      secondaryLabel: 'How pages are written',
      secondaryHref: '/landing/docs/first-article/',
    },
  },
  zh: {
    title: '游戏 Wiki 页面模板——每种页型,真实可看',
    subtitle:
      '「wiki page templates」(约 870 次/月)、「wiki template」(约 1,000 次/月)、「wiki template character」(约 1,490 次/月——SimilarWeb,2026-08):搜这些词的人想看的是「游戏 wiki 的页面到底长什么样」。本页把 AnvilWiki 模板能产出的每种页型摆出来,每一型都挂着线上 demo 的真实页面。',
    intro:
      '判断一个模板,看产出比看功能清单直接。下面是 AnvilWiki 内建的每一种页型,每张卡片都链到 demo 站的真实页面——demo 是虚构游戏「Anvil Quest」的完整 wiki(anvil.wiki)。读完一页,再把页面里的游戏名换成你的。',
    cardsTitle: '页型清单',
    cardsHint: '每条链接打开的都是当前跑着这套模板的真实页面——没有任何一张是设计稿。',
    compareNote: {
      text: '还在权衡 AnvilWiki 与 Fandom 或自托管引擎?',
      href: '/zh/landing/comparison/',
      label: '看完整对比页。',
    },
    cards: [
      {
        name: 'Boss 攻略页',
        description: '流量主力:单个 Boss 的阶段机制、打法思路与配装推荐。',
        points: [
          'frontmatter 的 boss 字段自动渲染属性卡(HP、弱点、抗性、位置、推荐等级)',
          '封面 + 2–4 张带说明的机制图;封面 1200×675 用 pnpm gen-covers 生成',
          '正文内联视频登记进 frontmatter videos → 输出 VideoObject JSON-LD',
        ],
        links: [{ label: 'Stormcaller Boss 攻略', href: '/bosses/stormcaller/' }],
      },
      {
        name: '兑换码页',
        description: '保鲜型页面:每条兑换码的奖励、状态、过期时间与来源。',
        points: [
          '结构化 codes frontmatter(code / reward / status / expiryDate / source)',
          '自动分组:Active 区(CodeBlock 一键复制)+ Expired 表格——承接「XX 还能用吗」长尾',
          'frontmatter faq 合并输出 FAQPage JSON-LD',
        ],
        links: [{ label: '全部有效兑换码', href: '/codes/all-codes/' }],
      },
      {
        name: 'Tier List 强度榜',
        description: '承接「best X」类查询的排行页——每个版本都会被重新搜一遍。',
        points: [
          'frontmatter gameVersion 渲染版本徽章——快速迭代游戏的时效性/E-E-A-T 信号',
          'frontmatter summary(40–60 词直答)→ Quick Answer 卡片 + AI Overviews 摘要候选',
          '头部条目配卡片图',
        ],
        links: [{ label: '武器强度榜', href: '/guides/weapon-tier-list/' }],
      },
      {
        name: '新手攻略页',
        description: '长文流程页:图文并茂、可折叠细节、站内互链。',
        points: [
          '画廊布局:优化封面 + 带说明的机制图,预留零 CLS 的 16:9 图框',
          'Accordion / Callout 组件承载提示、警告与折叠细节',
          'check-content 逐页体检:禁 H1、标题层级、alt 文本、正文 ≥3 条站内链',
        ],
        links: [{ label: '新手攻略', href: '/guides/beginner-guide/' }],
      },
      {
        name: '装备 / 物品页',
        description: '材料、物品与套装的参考页——玩家打游戏时常驻的侧边标签页。',
        points: [
          'Markdown 表格直接吃站点排版——不用手写 HTML',
          'StatBar 组件做数值对比',
          '与其他页型同一套 MDX + Zod 校验的 frontmatter——只学一种格式',
        ],
        links: [
          { label: '锻造材料指南', href: '/items/forging-materials-guide/' },
          { label: 'Emberforged 套装', href: '/items/emberforged-armor-set/' },
        ],
      },
      {
        name: '手册 / 文档中心',
        description:
          '带侧边导航、页内目录与全站搜索的文档中心——模板自带的中英双语手册(学习+开发两册)就跑在这套布局上。',
        points: [
          '中英双语,每页独立语言切换',
          'Pagefind 按 html lang 分语言索引,经 data-pagefind-body 标记收录',
          '同一布局也适合游戏官方文档、更新公告或知识库',
        ],
        links: [{ label: '打开文档中心', href: '/zh/landing/docs/' }],
      },
    ],
    cta: {
      title: '上面每一页就是一个 MDX 文件',
      subtitle:
        'Fork 模板,对 AI 代理说「根据这些笔记写一篇 Boss 攻略」,拿到的是能过构建的页面——schema 校验、内容体检、免费部署在 Cloudflare Pages,广告收益 100% 归你。',
      primaryLabel: '在 GitHub 上 Fork',
      primaryHref: 'https://github.com/PNGTRID/AnvilWiki/fork',
      secondaryLabel: '页面怎么写',
      secondaryHref: '/zh/landing/docs/first-article/',
    },
  },
};
