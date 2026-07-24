// ==UserScript==
// @name         Steam 自动翻译 (评论区 & 创意工坊)
// @namespace    https://steampp.net/steam-translate
// @version      1.0.0
// @description  自动翻译 Steam 评论区与创意工坊内容为中文,译文显示在原文下方,带悬浮管理面板
// @author       User
// @match        *://steamcommunity.com/*
// @match        *://store.steampowered.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      translate.googleapis.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ============================================================
    // 模块 1:配置管理
    // ============================================================
    const STORAGE_PREFIX = 'steam_translate_';

    const DEFAULT_CONFIG = {
        enabled: true,                 // 翻译总开关
        targetLang: 'zh-CN',           // 目标语言
        translateReviews: true,        // 评论区/评测
        translateWorkshop: true,       // 创意工坊描述
        translateComments: true,       // 通用评论流
        panelCollapsed: false,         // 面板是否最小化
        panelX: null,                  // 面板横坐标
        panelY: null,                  // 面板纵坐标
        cacheExpiry: 86400000          // 缓存有效期 24h
    };

    // GM 存储,不可用时降级 localStorage
    const store = {
        get(key, defaultValue) {
            try {
                if (typeof GM_getValue === 'function') {
                    const v = GM_getValue(key, undefined);
                    if (v !== undefined) return v;
                }
            } catch (e) { /* 忽略 */ }
            try {
                const raw = localStorage.getItem(STORAGE_PREFIX + key);
                if (raw !== null) return JSON.parse(raw);
            } catch (e) { /* 忽略 */ }
            return defaultValue;
        },
        set(key, value) {
            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(key, value);
                    return;
                }
            } catch (e) { /* 忽略 */ }
            try {
                localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
            } catch (e) { /* 忽略 */ }
        },
        remove(key) {
            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(key, undefined);
                }
            } catch (e) { /* 忽略 */ }
            try {
                localStorage.removeItem(STORAGE_PREFIX + key);
            } catch (e) { /* 忽略 */ }
        }
    };

    let config = Object.assign({}, DEFAULT_CONFIG);

    function loadConfig() {
        const saved = store.get('config', {});
        config = Object.assign({}, DEFAULT_CONFIG, saved);
    }

    function saveConfig() {
        store.set('config', config);
    }

    function setConfig(key, value) {
        config[key] = value;
        saveConfig();
        onConfigChange(key);
    }

    // 配置变更后的实时响应
    function onConfigChange(key) {
        if (key === 'enabled') {
            if (config.enabled) {
                startTranslation();
            } else {
                stopTranslation();
            }
        }
        if (key === 'translateReviews' || key === 'translateWorkshop' || key === 'translateComments') {
            // 作用范围变更,无需重启 Observer,processElement 内部会判断
        }
    }

    // ============================================================
    // 模块 2:翻译缓存
    // ============================================================
    function getCacheKey(text, targetLang) {
        // 简易哈希,避免长 key
        let hash = 0;
        for (let i = 0; i < text.length; i++) {
            const chr = text.charCodeAt(i);
            hash = ((hash << 5) - hash) + chr;
            hash |= 0;
        }
        return 'cache_' + targetLang + '_' + (hash >>> 0).toString(36);
    }

    function getCachedTranslation(text, targetLang) {
        const key = getCacheKey(text, targetLang);
        const entry = store.get(key, null);
        if (!entry) return null;
        if (Date.now() - entry.ts > config.cacheExpiry) {
            store.remove(key);
            return null;
        }
        stats.cacheHits++;
        updateStatsDisplay();
        return entry.text;
    }

    function setCachedTranslation(text, targetLang, translation) {
        const key = getCacheKey(text, targetLang);
        store.set(key, { text: translation, ts: Date.now() });
    }

    function clearAllCache() {
        // 清除所有 cache_ 前缀的键(localStorage 模式)
        try {
            const toRemove = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(STORAGE_PREFIX + 'cache_') === 0) {
                    toRemove.push(k);
                }
            }
            toRemove.forEach(k => localStorage.removeItem(k));
        } catch (e) { /* 忽略 */ }
        stats.translated = 0;
        stats.cacheHits = 0;
        updateStatsDisplay();
    }

    // ============================================================
    // 模块 3:翻译请求(Google 免费接口)
    // ============================================================
    const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
    const MAX_TEXT_LENGTH = 1800;       // 单次请求文本上限
    const MAX_CONCURRENT = 3;           // 最大并发
    const REQUEST_INTERVAL = 200;       // 请求间隔(ms)

    let lastRequestTime = 0;

    function gmFetch(url) {
        return new Promise((resolve, reject) => {
            const opts = {
                method: 'GET',
                url: url,
                timeout: 10000,
                onload: function (resp) {
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve(resp.responseText);
                    } else {
                        reject(new Error('HTTP ' + resp.status));
                    }
                },
                onerror: function (err) { reject(new Error('网络错误')); },
                ontimeout: function () { reject(new Error('请求超时')); }
            };
            try {
                GM_xmlhttpRequest(opts);
            } catch (e) {
                reject(e);
            }
        });
    }

    // 节流:确保请求间隔
    function throttle() {
        return new Promise(resolve => {
            const now = Date.now();
            const wait = Math.max(0, REQUEST_INTERVAL - (now - lastRequestTime));
            setTimeout(() => {
                lastRequestTime = Date.now();
                resolve();
            }, wait);
        });
    }

    async function translateText(text, targetLang) {
        const trimmed = text.trim();
        if (!trimmed) return '';

        // 跳过纯数字/符号/过短内容
        if (/^[\d\s\p{P}\p{S}]+$/u.test(trimmed) || trimmed.length < 2) {
            return '';
        }

        // 命中缓存
        const cached = getCachedTranslation(trimmed, targetLang);
        if (cached !== null) return cached;

        // 超长文本截断
        const queryText = trimmed.length > MAX_TEXT_LENGTH
            ? trimmed.slice(0, MAX_TEXT_LENGTH)
            : trimmed;

        const url = GOOGLE_ENDPOINT +
            '?client=gtx&sl=auto&tl=' + encodeURIComponent(targetLang) +
            '&dt=t&q=' + encodeURIComponent(queryText);

        await throttle();

        try {
            const raw = await gmFetch(url);
            const data = JSON.parse(raw);
            // data[0] 是 [[译文, 原文, ...], ...]
            let result = '';
            if (Array.isArray(data) && Array.isArray(data[0])) {
                for (const seg of data[0]) {
                    if (Array.isArray(seg) && typeof seg[0] === 'string') {
                        result += seg[0];
                    }
                }
            }
            if (result) {
                setCachedTranslation(trimmed, targetLang, result);
                stats.translated++;
                updateStatsDisplay();
                return result;
            }
            return '';
        } catch (e) {
            console.warn('[Steam翻译] 翻译失败:', e.message, '文本:', trimmed.slice(0, 50));
            throw e;
        }
    }

    // 批量翻译(并发限制)
    async function translateBatch(texts, targetLang) {
        const results = new Array(texts.length);
        let index = 0;

        async function worker() {
            while (index < texts.length) {
                const i = index++;
                try {
                    results[i] = await translateText(texts[i], targetLang);
                } catch (e) {
                    results[i] = '';
                }
            }
        }

        const workers = [];
        for (let i = 0; i < MAX_CONCURRENT; i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        return results;
    }

    // ============================================================
    // 模块 4:页面选择器(Steam DOM 适配)
    // ============================================================
    const SELECTORS = {
        // 评论区/评测
        reviews: [
            '.apphub_CardTextContent',
            '.apphub_CardContentMainText',
            '.responsive_review_body'
        ],
        // 创意工坊
        workshop: [
            '.workshopItemDescription',
            '.workshopItemTitle',
            '.workshopBrowseItems .workshopItemTitle'
        ],
        // 通用评论流
        comments: [
            '.commentthread_comment_text',
            '.commentthread_comment .content'
        ]
    };

    // 判断元素是否属于某作用域
    function getScope(el) {
        for (const sel of SELECTORS.reviews) {
            if (el.matches && el.matches(sel)) return 'reviews';
        }
        for (const sel of SELECTORS.workshop) {
            if (el.matches && el.matches(sel)) return 'workshop';
        }
        for (const sel of SELECTORS.comments) {
            if (el.matches && el.matches(sel)) return 'comments';
        }
        return null;
    }

    // 判断该作用域是否启用
    function isScopeEnabled(scope) {
        if (scope === 'reviews') return config.translateReviews;
        if (scope === 'workshop') return config.translateWorkshop;
        if (scope === 'comments') return config.translateComments;
        return false;
    }

    // 获取当前页面所有目标元素
    function getAllTargetElements() {
        const all = [];
        const scopes = ['reviews', 'workshop', 'comments'];
        for (const scope of scopes) {
            if (!isScopeEnabled(scope)) continue;
            for (const sel of SELECTORS[scope]) {
                document.querySelectorAll(sel).forEach(el => all.push(el));
            }
        }
        return all;
    }

    // ============================================================
    // 模块 5:DOM 观察与翻译执行
    // ============================================================
    let observer = null;
    let debounceTimer = null;

    // 是否为中文/日文等不需要翻译的语言(简单判断)
    function shouldSkipText(text) {
        const trimmed = text.trim();
        if (!trimmed) return true;
        // 纯数字/符号
        if (/^[\d\s\p{P}\p{S}]+$/u.test(trimmed)) return true;
        // 中文占比高则跳过(目标语言为中文时)
        if (config.targetLang.indexOf('zh') === 0) {
            const cjkCount = (trimmed.match(/[\u4e00-\u9fff]/g) || []).length;
            if (cjkCount / trimmed.length > 0.5) return true;
        }
        return false;
    }

    async function processElement(el) {
        if (!el || el.dataset.steamTranslated === '1') return;
        const scope = getScope(el);
        if (!scope || !isScopeEnabled(scope)) return;
        if (!config.enabled) return;

        const text = el.innerText || el.textContent || '';
        if (shouldSkipText(text)) {
            el.dataset.steamTranslated = '1';
            return;
        }

        el.dataset.steamTranslated = '1';

        // 插入 loading 占位
        const resultNode = createResultNode('');
        resultNode.querySelector('.steam-translate-text').textContent = '翻译中...';
        resultNode.classList.add('steam-translate-loading');
        el.insertAdjacentElement('afterend', resultNode);

        try {
            const translation = await translateText(text, config.targetLang);
            if (translation) {
                resultNode.querySelector('.steam-translate-text').textContent = translation;
                resultNode.classList.remove('steam-translate-loading');
                resultNode.dataset.origHash = getCacheKey(text, config.targetLang);
            } else {
                resultNode.remove();
            }
        } catch (e) {
            resultNode.querySelector('.steam-translate-text').textContent = '翻译失败';
            resultNode.classList.remove('steam-translate-loading');
            resultNode.classList.add('steam-translate-error');
        }
    }

    function createResultNode(translation) {
        const wrapper = document.createElement('div');
        wrapper.className = 'steam-translate-result';
        const divider = document.createElement('div');
        divider.className = 'steam-translate-divider';
        divider.textContent = '—— 译文 ——';
        const text = document.createElement('div');
        text.className = 'steam-translate-text';
        text.textContent = translation;
        wrapper.appendChild(divider);
        wrapper.appendChild(text);
        return wrapper;
    }

    // 扫描已存在的目标元素
    function scanExisting() {
        const els = getAllTargetElements();
        els.forEach(el => processElement(el));
    }

    // 处理 MutationObserver 回调(防抖)
    function onDomMutations(mutations) {
        if (!config.enabled) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            const pending = [];
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    // 节点本身可能是目标
                    const scope = getScope(node);
                    if (scope) {
                        pending.push(node);
                    }
                    // 也可能是目标元素的容器,需查找子节点
                    const scopes = ['reviews', 'workshop', 'comments'];
                    for (const sc of scopes) {
                        if (!isScopeEnabled(sc)) continue;
                        for (const sel of SELECTORS[sc]) {
                            if (node.matches && node.matches(sel)) {
                                pending.push(node);
                            } else if (node.querySelector) {
                                node.querySelectorAll(sel).forEach(el => pending.push(el));
                            }
                        }
                    }
                }
            }
            // 去重
            const unique = [...new Set(pending)];
            unique.forEach(el => processElement(el));
        }, 300);
    }

    function initObserver() {
        if (observer) return;
        observer = new MutationObserver(onDomMutations);
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function stopObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        if (debounceTimer) {
            clearTimeout(debounceTimer);
            debounceTimer = null;
        }
    }

    function startTranslation() {
        initObserver();
        scanExisting();
    }

    function stopTranslation() {
        stopObserver();
    }

    // 移除所有已添加译文(切换语言时可选)
    function removeAllTranslations() {
        document.querySelectorAll('.steam-translate-result').forEach(el => el.remove());
        document.querySelectorAll('[data-steam-translated="1"]').forEach(el => {
            delete el.dataset.steamTranslated;
        });
    }

    // ============================================================
    // 模块 6:样式注入
    // ============================================================
    function injectStyles() {
        const css = `
        .steam-translate-result {
            margin: 6px 0 6px 0;
            padding: 6px 10px;
            background: rgba(47, 137, 188, 0.08);
            border-left: 3px solid #2f89bc;
            border-radius: 2px;
            font-size: 13px;
            line-height: 1.5;
            color: #c7d5e0;
            clear: both;
        }
        .steam-translate-result.steam-translate-loading .steam-translate-text {
            color: #8f98a0;
            font-style: italic;
        }
        .steam-translate-result.steam-translate-error .steam-translate-text {
            color: #c9302c;
        }
        .steam-translate-divider {
            font-size: 11px;
            color: #588a8b;
            margin-bottom: 3px;
            font-weight: bold;
            opacity: 0.8;
        }
        .steam-translate-text {
            word-wrap: break-word;
            white-space: pre-wrap;
        }

        /* 悬浮管理面板 */
        #steam-translate-panel {
            position: fixed;
            top: 80px;
            right: 20px;
            width: 260px;
            background: #1b2838;
            border: 1px solid #2a475e;
            border-radius: 6px;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            z-index: 2147483647;
            color: #c7d5e0;
            font-family: "Motiva Sans", Arial, Helvetica, sans-serif;
            font-size: 12px;
            user-select: none;
        }
        #steam-translate-panel.steam-translate-hidden {
            display: none;
        }
        #steam-translate-panel .stp-header {
            background: linear-gradient(135deg, #1b2838 0%, #2a475e 100%);
            padding: 8px 12px;
            border-radius: 6px 6px 0 0;
            cursor: move;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-weight: bold;
            color: #66c0f4;
        }
        #steam-translate-panel .stp-body {
            padding: 10px 12px;
            display: block;
        }
        #steam-translate-panel.collapsed .stp-body {
            display: none;
        }
        #steam-translate-panel .stp-row {
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        #steam-translate-panel .stp-row label {
            flex: 1;
        }
        #steam-translate-panel .stp-btn {
            background: #5c7e10;
            color: #fff;
            border: none;
            padding: 4px 8px;
            border-radius: 3px;
            cursor: pointer;
            font-size: 11px;
            margin-right: 4px;
        }
        #steam-translate-panel .stp-btn:hover {
            background: #75a017;
        }
        #steam-translate-panel .stp-btn.danger {
            background: #a0392c;
        }
        #steam-translate-panel .stp-btn.danger:hover {
            background: #c94434;
        }
        #steam-translate-panel .stp-select {
            background: #2a475e;
            color: #c7d5e0;
            border: 1px solid #345e7a;
            padding: 2px 4px;
            border-radius: 3px;
            font-size: 11px;
        }
        #steam-translate-panel .stp-checkbox {
            cursor: pointer;
        }
        #steam-translate-panel .stp-stats {
            border-top: 1px solid #2a475e;
            padding-top: 6px;
            margin-top: 6px;
            font-size: 11px;
            color: #8f98a0;
        }
        #steam-translate-panel .stp-toggle {
            cursor: pointer;
            color: #66c0f4;
            font-size: 14px;
        }
        /* 最小化图标 */
        #steam-translate-fab {
            position: fixed;
            top: 80px;
            right: 20px;
            width: 44px;
            height: 44px;
            background: #1b2838;
            border: 1px solid #2a475e;
            border-radius: 50%;
            box-shadow: 0 2px 8px rgba(0,0,0,0.5);
            z-index: 2147483647;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #66c0f4;
            font-size: 20px;
        }
        #steam-translate-fab.steam-translate-hidden {
            display: none;
        }
        `;
        if (typeof GM_addStyle === 'function') {
            GM_addStyle(css);
        } else {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    // ============================================================
    // 模块 7:悬浮管理面板(功能管理页)
    // ============================================================
    let panelEl = null;
    let fabEl = null;
    const stats = { translated: 0, cacheHits: 0 };

    function createPanel() {
        // 悬浮图标(最小化时显示)
        fabEl = document.createElement('div');
        fabEl.id = 'steam-translate-fab';
        fabEl.innerHTML = '译';
        fabEl.title = '打开 Steam 翻译管理面板';
        fabEl.addEventListener('click', togglePanelFromFab);
        document.body.appendChild(fabEl);

        // 主面板
        panelEl = document.createElement('div');
        panelEl.id = 'steam-translate-panel';
        panelEl.innerHTML = buildPanelHTML();
        document.body.appendChild(panelEl);

        // 恢复位置
        if (config.panelX !== null && config.panelY !== null) {
            panelEl.style.left = config.panelX + 'px';
            panelEl.style.top = config.panelY + 'px';
            panelEl.style.right = 'auto';
        }

        // 应用折叠状态
        if (config.panelCollapsed) {
            panelEl.classList.add('collapsed');
        } else {
            fabEl.classList.add('steam-translate-hidden');
        }

        bindPanelEvents();
        updateStatsDisplay();
    }

    function buildPanelHTML() {
        const langs = [
            { value: 'zh-CN', label: '简体中文' },
            { value: 'zh-TW', label: '繁體中文' },
            { value: 'en', label: 'English' },
            { value: 'ja', label: '日本語' },
            { value: 'ko', label: '한국어' },
            { value: 'ru', label: 'Русский' }
        ];
        const langOptions = langs.map(l =>
            '<option value="' + l.value + '"' + (l.value === config.targetLang ? ' selected' : '') + '>' + l.label + '</option>'
        ).join('');

        return `
        <div class="stp-header">
            <span>Steam 翻译管理</span>
            <span class="stp-toggle" id="stp-collapse" title="最小化">—</span>
        </div>
        <div class="stp-body">
            <div class="stp-row">
                <label>翻译总开关</label>
                <input type="checkbox" class="stp-checkbox" id="stp-enabled" ${config.enabled ? 'checked' : ''}>
            </div>
            <div class="stp-row">
                <label>目标语言</label>
                <select class="stp-select" id="stp-lang">${langOptions}</select>
            </div>
            <div class="stp-row">
                <label>评论区/评测</label>
                <input type="checkbox" class="stp-checkbox" id="stp-reviews" ${config.translateReviews ? 'checked' : ''}>
            </div>
            <div class="stp-row">
                <label>创意工坊描述</label>
                <input type="checkbox" class="stp-checkbox" id="stp-workshop" ${config.translateWorkshop ? 'checked' : ''}>
            </div>
            <div class="stp-row">
                <label>通用评论流</label>
                <input type="checkbox" class="stp-checkbox" id="stp-comments" ${config.translateComments ? 'checked' : ''}>
            </div>
            <div class="stp-row">
                <button class="stp-btn" id="stp-translate-now">立即翻译当前页</button>
            </div>
            <div class="stp-row">
                <button class="stp-btn danger" id="stp-clear-cache">清除缓存</button>
                <button class="stp-btn" id="stp-clear-page">清除本页译文</button>
            </div>
            <div class="stp-stats" id="stp-stats">已翻译: 0 | 缓存命中: 0</div>
        </div>
        `;
    }

    function bindPanelEvents() {
        // 总开关
        document.getElementById('stp-enabled').addEventListener('change', e => {
            setConfig('enabled', e.target.checked);
        });
        // 目标语言
        document.getElementById('stp-lang').addEventListener('change', e => {
            setConfig('targetLang', e.target.value);
            removeAllTranslations();
            if (config.enabled) scanExisting();
        });
        // 作用域复选框
        document.getElementById('stp-reviews').addEventListener('change', e => {
            setConfig('translateReviews', e.target.checked);
        });
        document.getElementById('stp-workshop').addEventListener('change', e => {
            setConfig('translateWorkshop', e.target.checked);
        });
        document.getElementById('stp-comments').addEventListener('change', e => {
            setConfig('translateComments', e.target.checked);
        });
        // 立即翻译
        document.getElementById('stp-translate-now').addEventListener('click', () => {
            removeAllTranslations();
            scanExisting();
        });
        // 清除缓存
        document.getElementById('stp-clear-cache').addEventListener('click', () => {
            clearAllCache();
        });
        // 清除本页译文
        document.getElementById('stp-clear-page').addEventListener('click', () => {
            removeAllTranslations();
        });
        // 折叠/展开
        document.getElementById('stp-collapse').addEventListener('click', () => {
            const collapsed = !panelEl.classList.contains('collapsed');
            panelEl.classList.toggle('collapsed', collapsed);
            fabEl.classList.toggle('steam-translate-hidden', !collapsed);
            setConfig('panelCollapsed', collapsed);
        });

        // 拖拽
        enableDrag();
    }

    function enableDrag() {
        const header = panelEl.querySelector('.stp-header');
        let isDragging = false;
        let startX = 0, startY = 0, startLeft = 0, startTop = 0;

        header.addEventListener('mousedown', e => {
            if (e.target.id === 'stp-collapse') return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panelEl.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            e.preventDefault();
        });

        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            const newLeft = startLeft + (e.clientX - startX);
            const newTop = startTop + (e.clientY - startY);
            panelEl.style.left = newLeft + 'px';
            panelEl.style.top = newTop + 'px';
            panelEl.style.right = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (!isDragging) return;
            isDragging = false;
            const rect = panelEl.getBoundingClientRect();
            setConfig('panelX', rect.left);
            setConfig('panelY', rect.top);
        });
    }

    function togglePanelFromFab() {
        panelEl.classList.remove('collapsed');
        fabEl.classList.add('steam-translate-hidden');
        setConfig('panelCollapsed', false);
    }

    function togglePanel() {
        if (panelEl.classList.contains('collapsed') || panelEl.classList.contains('steam-translate-hidden')) {
            panelEl.classList.remove('collapsed', 'steam-translate-hidden');
            fabEl.classList.add('steam-translate-hidden');
            setConfig('panelCollapsed', false);
        } else {
            panelEl.classList.add('collapsed');
            fabEl.classList.remove('steam-translate-hidden');
            setConfig('panelCollapsed', true);
        }
    }

    function updateStatsDisplay() {
        const el = document.getElementById('stp-stats');
        if (el) {
            el.textContent = '已翻译: ' + stats.translated + ' | 缓存命中: ' + stats.cacheHits;
        }
    }

    // ============================================================
    // 模块 8:URL 变化监听(SPA 导航)
    // ============================================================
    let lastURL = location.href;

    function watchURLChanges() {
        // 覆写 history 方法
        const origPush = history.pushState;
        const origReplace = history.replaceState;
        history.pushState = function () {
            const ret = origPush.apply(this, arguments);
            onURLChange();
            return ret;
        };
        history.replaceState = function () {
            const ret = origReplace.apply(this, arguments);
            onURLChange();
            return ret;
        };
        window.addEventListener('popstate', onURLChange);
    }

    let urlChangeTimer = null;
    function onURLChange() {
        if (location.href === lastURL) return;
        lastURL = location.href;
        if (urlChangeTimer) clearTimeout(urlChangeTimer);
        urlChangeTimer = setTimeout(() => {
            if (config.enabled) {
                scanExisting();
            }
        }, 1000);
    }

    // ============================================================
    // 模块 9:主入口
    // ============================================================
    function main() {
        loadConfig();
        injectStyles();

        // 等待 body 就绪
        const start = () => {
            createPanel();

            // 注册菜单命令(快捷入口)
            if (typeof GM_registerMenuCommand === 'function') {
                try {
                    GM_registerMenuCommand('打开/关闭翻译管理面板', togglePanel);
                } catch (e) { /* 忽略 */ }
            }

            // 启动翻译
            if (config.enabled) {
                startTranslation();
            }

            // 监听 URL 变化
            watchURLChanges();

            console.log('[Steam翻译] 插件已加载,目标语言:', config.targetLang);
        };

        if (document.body) {
            start();
        } else {
            document.addEventListener('DOMContentLoaded', start);
        }
    }

    main();
})();
