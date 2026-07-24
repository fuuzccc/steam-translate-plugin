// ==UserScript==
// @name         Steam 自动翻译 (评论区 & 创意工坊)
// @namespace    https://steampp.net/steam-translate
// @version      2.1.0
// @description  自动翻译 Steam 评论区与创意工坊内容为中文,译文显示在原文下方,带悬浮管理面板,支持百度翻译(含Google翻译兜底)
// @author       User
// @match        *://steamcommunity.com/*
// @match        *://store.steampowered.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @connect      fanyi-api.baidu.com
// @connect      *.baidu.com
// @connect      translate.googleapis.com
// @connect      *.googleapis.com
// @connect      *
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
        targetLang: 'zh',              // 目标语言(百度翻译语言代码)
        translateReviews: true,        // 评论区/评测
        translateWorkshop: true,       // 创意工坊描述
        translateComments: true,       // 通用评论流
        translateGameDesc: false,      // 游戏描述(商店页)
        baiduAppId: '',                // 百度翻译 APPID
        baiduSecretKey: '',            // 百度翻译密钥
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
    // 模块 3:翻译请求(百度翻译 API)
    // ============================================================
    const BAIDU_ENDPOINT = 'https://fanyi-api.baidu.com/api/trans/vip/translate';
    const MAX_TEXT_LENGTH = 1000;       // 单次请求文本上限(标准版 1000 字符)
    const MAX_CONCURRENT = 1;           // 最大并发(标准版 QPS=1)
    const REQUEST_INTERVAL = 1000;      // 请求间隔 1s(标准版 QPS=1)

    // 详细日志(始终输出,方便排查问题)
    let logSeq = 0;
    function log() {
        const args = Array.prototype.slice.call(arguments);
        args.unshift('[Steam翻译]');
        try { console.log.apply(console, args); } catch (e) {}
    }

    let lastRequestTime = 0;

    // MD5 实现(纯 JS, 兼容浏览器)
    function md5(str) {
        function rotateLeft(lValue, iShiftBits) {
            return (lValue << iShiftBits) | (lValue >>> (32 - iShiftBits));
        }
        function addUnsigned(lX, lY) {
            var lX4, lY4, lX8, lY8, lResult;
            lX8 = (lX & 0x80000000);
            lY8 = (lY & 0x80000000);
            lX4 = (lX & 0x40000000);
            lY4 = (lY & 0x40000000);
            lResult = (lX & 0x3FFFFFFF) + (lY & 0x3FFFFFFF);
            if (lX4 & lY4) return (lResult ^ 0x80000000 ^ lX8 ^ lY8);
            if (lX4 | lY4) {
                if (lResult & 0x40000000) return (lResult ^ 0xC0000000 ^ lX8 ^ lY8);
                else return (lResult ^ 0x40000000 ^ lX8 ^ lY8);
            } else return (lResult ^ lX8 ^ lY8);
        }
        function F(x, y, z) { return (x & y) | ((~x) & z); }
        function G(x, y, z) { return (x & z) | (y & (~z)); }
        function H(x, y, z) { return (x ^ y ^ z); }
        function I(x, y, z) { return (y ^ (x | (~z))); }
        function FF(a, b, c, d, x, s, ac) {
            a = addUnsigned(a, addUnsigned(addUnsigned(F(b, c, d), x), ac));
            return addUnsigned(rotateLeft(a, s), b);
        }
        function GG(a, b, c, d, x, s, ac) {
            a = addUnsigned(a, addUnsigned(addUnsigned(G(b, c, d), x), ac));
            return addUnsigned(rotateLeft(a, s), b);
        }
        function HH(a, b, c, d, x, s, ac) {
            a = addUnsigned(a, addUnsigned(addUnsigned(H(b, c, d), x), ac));
            return addUnsigned(rotateLeft(a, s), b);
        }
        function II(a, b, c, d, x, s, ac) {
            a = addUnsigned(a, addUnsigned(addUnsigned(I(b, c, d), x), ac));
            return addUnsigned(rotateLeft(a, s), b);
        }
        function convertToWordArray(str) {
            var lWordCount;
            var lMessageLength = str.length;
            var lNumberOfWords_temp1 = lMessageLength + 8;
            var lNumberOfWords_temp2 = (lNumberOfWords_temp1 - (lNumberOfWords_temp1 % 64)) / 64;
            var lNumberOfWords = (lNumberOfWords_temp2 + 1) * 16;
            var lWordArray = new Array(lNumberOfWords - 1);
            var lBytePosition = 0;
            var lByteCount = 0;
            while (lByteCount < lMessageLength) {
                lWordCount = (lByteCount - (lByteCount % 4)) / 4;
                lBytePosition = (lByteCount % 4) * 8;
                lWordArray[lWordCount] = (lWordArray[lWordCount] | (str.charCodeAt(lByteCount) << lBytePosition));
                lByteCount++;
            }
            lWordCount = (lByteCount - (lByteCount % 4)) / 4;
            lBytePosition = (lByteCount % 4) * 8;
            lWordArray[lWordCount] = lWordArray[lWordCount] | (0x80 << lBytePosition);
            lWordArray[lNumberOfWords - 2] = lMessageLength << 3;
            lWordArray[lNumberOfWords - 1] = lMessageLength >>> 29;
            return lWordArray;
        }
        function wordToHex(lValue) {
            var wordToHexValue = '', wordToHexValue_temp = '', lByte, lCount;
            for (lCount = 0; lCount <= 3; lCount++) {
                lByte = (lValue >>> (lCount * 8)) & 255;
                wordToHexValue_temp = '0' + lByte.toString(16);
                wordToHexValue = wordToHexValue + wordToHexValue_temp.substr(wordToHexValue_temp.length - 2, 2);
            }
            return wordToHexValue;
        }
        function utf8Encode(string) {
            string = string.replace(/\r\n/g, '\n');
            var utftext = '';
            for (var n = 0; n < string.length; n++) {
                var c = string.charCodeAt(n);
                if (c < 128) { utftext += String.fromCharCode(c); }
                else if ((c > 127) && (c < 2048)) {
                    utftext += String.fromCharCode((c >> 6) | 192);
                    utftext += String.fromCharCode((c & 63) | 128);
                } else {
                    utftext += String.fromCharCode((c >> 12) | 224);
                    utftext += String.fromCharCode(((c >> 6) & 63) | 128);
                    utftext += String.fromCharCode((c & 63) | 128);
                }
            }
            return utftext;
        }
        var x = [];
        var k, AA, BB, CC, DD, a, b, c, d;
        var S11 = 7, S12 = 12, S13 = 17, S14 = 22;
        var S21 = 5, S22 = 9, S23 = 14, S24 = 20;
        var S31 = 4, S32 = 11, S33 = 16, S34 = 23;
        var S41 = 6, S42 = 10, S43 = 15, S44 = 21;
        str = utf8Encode(str);
        x = convertToWordArray(str);
        a = 0x67452301; b = 0xEFCDAB89; c = 0x98BADCFE; d = 0x10325476;
        for (k = 0; k < x.length; k += 16) {
            AA = a; BB = b; CC = c; DD = d;
            a = FF(a, b, c, d, x[k + 0], S11, 0xD76AA478);
            d = FF(d, a, b, c, x[k + 1], S12, 0xE8C7B756);
            c = FF(c, d, a, b, x[k + 2], S13, 0x242070DB);
            b = FF(b, c, d, a, x[k + 3], S14, 0xC1BDCEEE);
            a = FF(a, b, c, d, x[k + 4], S11, 0xF57C0FAF);
            d = FF(d, a, b, c, x[k + 5], S12, 0x4787C62A);
            c = FF(c, d, a, b, x[k + 6], S13, 0xA8304613);
            b = FF(b, c, d, a, x[k + 7], S14, 0xFD469501);
            a = FF(a, b, c, d, x[k + 8], S11, 0x698098D8);
            d = FF(d, a, b, c, x[k + 9], S12, 0x8B44F7AF);
            c = FF(c, d, a, b, x[k + 10], S13, 0xFFFF5BB1);
            b = FF(b, c, d, a, x[k + 11], S14, 0x895CD7BE);
            a = FF(a, b, c, d, x[k + 12], S11, 0x6B901122);
            d = FF(d, a, b, c, x[k + 13], S12, 0xFD987193);
            c = FF(c, d, a, b, x[k + 14], S13, 0xA679438E);
            b = FF(b, c, d, a, x[k + 15], S14, 0x49B40821);
            a = GG(a, b, c, d, x[k + 1], S21, 0xF61E2562);
            d = GG(d, a, b, c, x[k + 6], S22, 0xC040B340);
            c = GG(c, d, a, b, x[k + 11], S23, 0x265E5A51);
            b = GG(b, c, d, a, x[k + 0], S24, 0xE9B6C7AA);
            a = GG(a, b, c, d, x[k + 5], S21, 0xD62F105D);
            d = GG(d, a, b, c, x[k + 10], S22, 0x02441453);
            c = GG(c, d, a, b, x[k + 15], S23, 0xD8A1E681);
            b = GG(b, c, d, a, x[k + 4], S24, 0xE7D3FBC8);
            a = GG(a, b, c, d, x[k + 9], S21, 0x21E1CDE6);
            d = GG(d, a, b, c, x[k + 14], S22, 0xC33707D6);
            c = GG(c, d, a, b, x[k + 3], S23, 0xF4D50D87);
            b = GG(b, c, d, a, x[k + 8], S24, 0x455A14ED);
            a = GG(a, b, c, d, x[k + 13], S21, 0xA9E3E905);
            d = GG(d, a, b, c, x[k + 2], S22, 0xFCEFA3F8);
            c = GG(c, d, a, b, x[k + 7], S23, 0x676F02D9);
            b = GG(b, c, d, a, x[k + 12], S24, 0x8D2A4C8A);
            a = HH(a, b, c, d, x[k + 5], S31, 0xFFFA3942);
            d = HH(d, a, b, c, x[k + 8], S32, 0x8771F681);
            c = HH(c, d, a, b, x[k + 11], S33, 0x6D9D6122);
            b = HH(b, c, d, a, x[k + 14], S34, 0xFDE5380C);
            a = HH(a, b, c, d, x[k + 1], S31, 0xA4BEEA44);
            d = HH(d, a, b, c, x[k + 4], S32, 0x4BDECFA9);
            c = HH(c, d, a, b, x[k + 7], S33, 0xF6BB4B60);
            b = HH(b, c, d, a, x[k + 10], S34, 0xBEBFBC70);
            a = HH(a, b, c, d, x[k + 13], S31, 0x289B7EC6);
            d = HH(d, a, b, c, x[k + 0], S32, 0xEAA127FA);
            c = HH(c, d, a, b, x[k + 3], S33, 0xD4EF3085);
            b = HH(b, c, d, a, x[k + 6], S34, 0x04881D05);
            a = HH(a, b, c, d, x[k + 9], S31, 0xD9D4D039);
            d = HH(d, a, b, c, x[k + 12], S32, 0xE6DB99E5);
            c = HH(c, d, a, b, x[k + 15], S33, 0x1FA27CF8);
            b = HH(b, c, d, a, x[k + 2], S34, 0xC4AC5665);
            a = II(a, b, c, d, x[k + 0], S41, 0xF4292244);
            d = II(d, a, b, c, x[k + 7], S42, 0x432AFF97);
            c = II(c, d, a, b, x[k + 14], S43, 0xAB9423A7);
            b = II(b, c, d, a, x[k + 5], S44, 0xFC93A039);
            a = II(a, b, c, d, x[k + 12], S41, 0x655B59C3);
            d = II(d, a, b, c, x[k + 3], S42, 0x8F0CCC92);
            c = II(c, d, a, b, x[k + 10], S43, 0xFFEFF47D);
            b = II(b, c, d, a, x[k + 1], S44, 0x85845DD1);
            a = II(a, b, c, d, x[k + 8], S41, 0x6FA87E4F);
            d = II(d, a, b, c, x[k + 15], S42, 0xFE2CE6E0);
            c = II(c, d, a, b, x[k + 6], S43, 0xA3014314);
            b = II(b, c, d, a, x[k + 13], S44, 0x4E0811A1);
            a = II(a, b, c, d, x[k + 4], S41, 0xF7537E82);
            d = II(d, a, b, c, x[k + 11], S42, 0xBD3AF235);
            c = II(c, d, a, b, x[k + 2], S43, 0x2AD7D2BB);
            b = II(b, c, d, a, x[k + 9], S44, 0xEB86D391);
            a = addUnsigned(a, AA);
            b = addUnsigned(b, BB);
            c = addUnsigned(c, CC);
            d = addUnsigned(d, DD);
        }
        return (wordToHex(a) + wordToHex(b) + wordToHex(c) + wordToHex(d)).toLowerCase();
    }

    // 诊断 GM_xmlhttpRequest 是否可用
    function getGmDiag() {
        let diag = 'GM_xmlhttpRequest=' + (typeof GM_xmlhttpRequest);
        try { diag += ' location=' + location.hostname; } catch (e) {}
        return diag;
    }

    function gmPost(url, data) {
        const reqId = '[Steam翻译#' + (++logSeq) + ']';
        // GM_xmlhttpRequest 不可用时降级用 fetch
        if (typeof GM_xmlhttpRequest !== 'function') {
            log(reqId, 'GM_xmlhttpRequest不可用,降级fetch POST ' + url);
            return fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: data
            }).then(resp => {
                log(reqId, 'fetch响应 status=' + resp.status);
                if (resp.ok) return resp.text();
                return resp.text().then(t => { throw new Error('HTTP ' + resp.status + ' ' + t.slice(0, 200)); });
            }).catch(e => {
                log(reqId, 'fetch失败:', e.message);
                throw new Error('fetch失败: ' + e.message + ' [' + getGmDiag() + ']');
            });
        }
        return new Promise((resolve, reject) => {
            let settled = false;
            const guardTimer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    const msg = 'GM_xmlhttpRequest 2秒内无任何回调,可能被Watt Toolkit静默拦截 [' + getGmDiag() + ']';
                    log(reqId, msg);
                    reject(new Error(msg));
                }
            }, 2000);

            const opts = {
                method: 'POST',
                url: url,
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                data: data,
                timeout: 15000,
                onload: function (resp) {
                    if (settled) return; settled = true; clearTimeout(guardTimer);
                    log(reqId, 'onload status=' + resp.status + ' len=' + (resp.responseText ? resp.responseText.length : 0));
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve(resp.responseText);
                    } else {
                        let detail = '';
                        try { detail = resp.responseText ? resp.responseText.slice(0, 200) : ''; } catch (e) {}
                        log(reqId, '非2xx响应:', detail);
                        reject(new Error('HTTP ' + resp.status + (detail ? ' ' + detail : '')));
                    }
                },
                onerror: function (resp) {
                    if (settled) return; settled = true; clearTimeout(guardTimer);
                    let info = '网络错误';
                    if (resp) {
                        if (resp.status) info += '(status=' + resp.status + ')';
                        if (resp.statusText) info += ' ' + resp.statusText;
                        if (resp.error) info += ' ' + resp.error;
                        try {
                            if (resp.responseText) info += ' ' + String(resp.responseText).slice(0, 150);
                        } catch (e) {}
                    }
                    if (!resp || (!resp.status && !resp.statusText && !resp.error)) {
                        info += ' [' + getGmDiag() + '] 请求未到达服务器,可能是@connect未生效或网络代理拦截';
                    }
                    log(reqId, 'onerror:', info, '| resp:', resp);
                    reject(new Error(info));
                },
                ontimeout: function () {
                    if (settled) return; settled = true; clearTimeout(guardTimer);
                    log(reqId, 'ontimeout(15s)');
                    reject(new Error('请求超时(15s)'));
                }
            };
            try {
                log(reqId, '发起请求 POST ' + url);
                log(reqId, 'postData(前120字符):', data.slice(0, 120));
                log(reqId, 'GM_xmlhttpRequest类型:', typeof GM_xmlhttpRequest, '长度:', GM_xmlhttpRequest.length);
                const ret = GM_xmlhttpRequest(opts);
                log(reqId, 'GM_xmlhttpRequest返回值:', typeof ret, ret);
            } catch (e) {
                if (settled) return; settled = true; clearTimeout(guardTimer);
                log(reqId, 'GM_xmlhttpRequest抛异常:', e.message, e.stack);
                reject(new Error('GM_xmlhttpRequest异常: ' + e.message));
            }
        });
    }

    // 节流:链式队列确保请求真正串行(百度标准版 QPS=1)
    let requestChain = Promise.resolve();
    function throttle() {
        const run = () => {
            const now = Date.now();
            const wait = Math.max(0, REQUEST_INTERVAL - (now - lastRequestTime));
            log('throttle 等待=' + wait + 'ms (距上次请求=' + (now - lastRequestTime) + 'ms)');
            return new Promise(resolve => {
                setTimeout(() => {
                    lastRequestTime = Date.now();
                    log('throttle 等待结束,放行');
                    resolve();
                }, wait);
            });
        };
        // 排到链尾,前一个完成后才执行下一个,彻底避免并发竞态
        requestChain = requestChain.then(() => run());
        return requestChain;
    }

    // 百度翻译签名生成: sign = MD5(appid + q + salt + secretKey)
    function generateSign(appid, q, salt, secretKey) {
        return md5(appid + q + salt + secretKey);
    }

    // 百度翻译 API 错误码映射(供 translateText 和 testBaiduApi 共用)
    const BAIDU_ERROR_MSGS = {
        '52000': '成功',
        '52001': '请求超时',
        '52002': '系统错误',
        '52003': '未授权用户,请检查 APPID 和密钥',
        '52004': '账号已欠费',
        '52005': '翻译语言方向不支持',
        '52006': '接口已关闭',
        '54000': '参数错误',
        '54001': '签名错误',
        '54003': '调用频率过高',
        '54004': '余额不足',
        '54005': '长文本翻译请求过于频繁',
        '58000': '客户端 IP 非法'
    };

    // 百度→Google 语言代码映射(Google 免费接口用)
    function toGoogleLang(lang) {
        const m = { 'zh': 'zh-CN', 'cht': 'zh-TW', 'jp': 'ja', 'kor': 'ko', 'ru': 'ru', 'en': 'en', 'fr': 'fr', 'de': 'de' };
        return m[lang] || lang;
    }

    // Google 翻译免费接口(优先GM_xmlhttpRequest,失败则fetch)
    async function translateViaGoogle(text, targetLang) {
        const gLang = toGoogleLang(targetLang);
        const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
            encodeURIComponent(gLang) + '&dt=t&q=' + encodeURIComponent(text);

        // 优先用 GM_xmlhttpRequest(GET方式)
        if (typeof GM_xmlhttpRequest === 'function') {
            try {
                log('Google翻译: GM_xmlhttpRequest GET');
                const raw = await new Promise((resolve, reject) => {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url,
                        timeout: 10000,
                        onload: r => resolve(r.responseText),
                        onerror: r => reject(new Error('GM onerror')),
                        ontimeout: () => reject(new Error('GM timeout'))
                    });
                });
                log('Google翻译响应(前200字符):', raw.slice(0, 200));
                const data = JSON.parse(raw);
                return parseGoogleResult(data);
            } catch (e) {
                log('Google翻译 GM方式失败:', e.message, '尝试fetch兜底');
            }
        }

        // fetch 兜底
        log('Google翻译: fetch GET');
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('Google翻译 HTTP ' + resp.status);
        const data = await resp.json();
        log('Google翻译 fetch成功');
        return parseGoogleResult(data);
    }

    function parseGoogleResult(data) {
        let result = '';
        if (Array.isArray(data) && Array.isArray(data[0])) {
            for (const seg of data[0]) {
                if (seg && seg[0]) result += seg[0];
            }
        }
        log('Google翻译解析结果:', result.slice(0, 50));
        return result;
    }

    // 百度翻译核心请求
    async function translateViaBaidu(text, targetLang) {
        if (!config.baiduAppId || !config.baiduSecretKey) {
            throw new Error('请先在管理面板中配置百度翻译 APPID 和密钥');
        }
        const queryText = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
        const salt = String(Date.now()) + String(Math.floor(Math.random() * 10000));
        const sign = generateSign(config.baiduAppId, queryText, salt, config.baiduSecretKey);
        const postData = 'q=' + encodeURIComponent(queryText) +
            '&from=auto&to=' + encodeURIComponent(targetLang) +
            '&appid=' + encodeURIComponent(config.baiduAppId) +
            '&salt=' + salt + '&sign=' + sign;

        log('百度翻译: 文本长度=' + queryText.length + ' 目标=' + targetLang + ' appid=' + config.baiduAppId);
        await throttle();
        const raw = await gmPost(BAIDU_ENDPOINT, postData);
        log('百度翻译响应: 长度=' + (raw ? raw.length : 0), '前200字符:', raw ? raw.slice(0, 200) : '');
        const data = JSON.parse(raw);
        if (data.error_code && data.error_code !== '52000') {
            throw new Error(BAIDU_ERROR_MSGS[data.error_code] || ('错误码: ' + data.error_code));
        }
        let result = '';
        if (Array.isArray(data.trans_result)) {
            for (const item of data.trans_result) {
                if (result) result += '\n';
                result += item.dst;
            }
        }
        return result;
    }

    // 翻译入口:优先百度,失败自动降级Google
    let baiduAvailable = true; // 百度是否可用(连续失败后标记为不可用,定期重试)
    let baiduFailCount = 0;
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

        // 优先百度翻译
        if (baiduAvailable && config.baiduAppId && config.baiduSecretKey) {
            try {
                const result = await translateViaBaidu(trimmed, targetLang);
                if (result) {
                    baiduFailCount = 0; // 重置失败计数
                    setCachedTranslation(trimmed, targetLang, result);
                    stats.translated++;
                    updateStatsDisplay();
                    return result;
                }
            } catch (e) {
                log('百度翻译失败,尝试Google兜底:', e.message);
                baiduFailCount++;
                addErrorLog('百度失败→Google兜底: ' + e.message, trimmed);
                // 连续失败3次,暂时标记百度不可用(60秒后重试)
                if (baiduFailCount >= 3) {
                    baiduAvailable = false;
                    log('百度翻译连续失败' + baiduFailCount + '次,暂时切换到Google,60秒后重试百度');
                    setTimeout(() => { baiduAvailable = true; baiduFailCount = 0; log('百度翻译重试已重新启用'); }, 60000);
                }
                // 继续走 Google 兜底
            }
        }

        // Google 翻译兜底
        try {
            const result = await translateViaGoogle(trimmed, targetLang);
            if (result) {
                setCachedTranslation(trimmed, targetLang, result);
                stats.translated++;
                updateStatsDisplay();
                return result;
            }
        } catch (e) {
            log('Google翻译也失败:', e.message);
            throw new Error('百度和Google翻译均失败: ' + e.message);
        }
        return '';
    }

    // 测试百度翻译密钥是否有效(用短文本发一次请求)
    async function testBaiduApi(appId, secretKey) {
        const testText = 'hello';
        const salt = String(Date.now());
        const sign = generateSign(appId, testText, salt, secretKey);
        const postData = 'q=' + encodeURIComponent(testText) +
            '&from=auto&to=zh' +
            '&appid=' + encodeURIComponent(appId) +
            '&salt=' + salt +
            '&sign=' + sign;
        try {
            const raw = await gmPost(BAIDU_ENDPOINT, postData);
            const data = JSON.parse(raw);
            if (data.error_code && data.error_code !== '52000') {
                const errMsg = BAIDU_ERROR_MSGS[data.error_code] || ('错误码: ' + data.error_code);
                return { ok: false, message: errMsg };
            }
            return { ok: true, message: '验证成功' };
        } catch (e) {
            return { ok: false, message: e.message || '网络错误' };
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
        reviews: [
            '.apphub_CardTextContent',
            '.apphub_CardContentMainText',
            '.responsive_review_body',
            '.review_box .content'
        ],
        workshop: [
            '.workshopItemDescription',
            '.workshopItemTitle',
            '.workshopBrowseItems .workshopItemTitle'
        ],
        comments: [
            '.commentthread_comment_text',
            '.commentthread_comment .content'
        ],
        gameDesc: [
            '.game_area_description',
            '.game_description_snippet'
        ]
    };

    // 新版 Steam 商店页评测正文结构检测(类名随机,用结构特征识别)
    function detectNewReviewContent(el) {
        if (!el || el.nodeType !== 1) return false;
        const text = (el.textContent || '').trim();
        if (text.length < 50 || text.length > 5000) return false;

        // 特征 1: 在 app_reviews_hash 区域内
        const inReviews = el.closest && el.closest('#app_reviews_hash');
        if (!inReviews) return false;

        // 特征 2: 是 .Panel 的子节点
        const panelParent = el.closest && el.closest('.Panel');
        if (!panelParent) return false;

        // 特征 3: 父级面板包含"Recommended"或"Not Recommended"标识
        const panelText = panelParent.textContent || '';
        if (panelText.indexOf('Recommended') < 0 && panelText.indexOf('Not Recommended') < 0) {
            return false;
        }

        // 特征 4: 元素直接包含可读文本(不是按钮/链接容器)
        const childCount = el.children ? el.children.length : 0;
        if (childCount > 5) return false;

        // 特征 5: 文本密度高(文本长度 / 子元素数)
        const textDensity = text.length / Math.max(childCount, 1);
        if (textDensity < 30) return false;

        return true;
    }

    // 检测元素是否为新版 Steam 商店页游戏描述
    function detectNewGameDesc(el) {
        if (!el || el.nodeType !== 1) return false;
        const text = (el.textContent || '').trim();
        if (text.length < 200 || text.length > 10000) return false;
        // 在 About This Game / 游戏描述区域附近
        const pageContent = el.closest && el.closest('.game_description_column, .page_content_ctn, #game_area_description');
        return !!pageContent;
    }

    // 判断元素是否属于某作用域
    function getScope(el) {
        if (!el || !el.matches) return null;

        for (const sel of SELECTORS.reviews) {
            if (el.matches(sel)) return 'reviews';
        }
        for (const sel of SELECTORS.workshop) {
            if (el.matches(sel)) return 'workshop';
        }
        for (const sel of SELECTORS.comments) {
            if (el.matches(sel)) return 'comments';
        }
        for (const sel of SELECTORS.gameDesc) {
            if (el.matches(sel)) return 'gameDesc';
        }

        // 新版 Steam 商店页结构检测
        if (detectNewReviewContent(el)) return 'reviews';
        if (detectNewGameDesc(el)) return 'gameDesc';

        return null;
    }

    // 判断该作用域是否启用
    function isScopeEnabled(scope) {
        if (scope === 'reviews') return config.translateReviews;
        if (scope === 'workshop') return config.translateWorkshop;
        if (scope === 'comments') return config.translateComments;
        if (scope === 'gameDesc') return config.translateGameDesc;
        return false;
    }

    // 获取当前页面所有目标元素
    function getAllTargetElements() {
        const all = [];
        const scopes = ['reviews', 'workshop', 'comments', 'gameDesc'];
        for (const scope of scopes) {
            if (!isScopeEnabled(scope)) continue;
            for (const sel of (SELECTORS[scope] || [])) {
                try {
                    document.querySelectorAll(sel).forEach(el => all.push(el));
                } catch (e) { /* 忽略无效选择器 */ }
            }
        }

        // 额外扫描新版商店页的评测内容
        if (config.translateReviews && document.getElementById('app_reviews_hash')) {
            document.querySelectorAll('#app_reviews_hash .Panel div').forEach(el => {
                if (detectNewReviewContent(el) && all.indexOf(el) < 0) {
                    all.push(el);
                }
            });
        }

        // 额外扫描新版商店页的游戏描述
        if (config.translateGameDesc) {
            document.querySelectorAll('.game_description_column div').forEach(el => {
                if (detectNewGameDesc(el) && all.indexOf(el) < 0) {
                    all.push(el);
                }
            });
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
            const errMsg = e && e.message ? e.message : '未知错误';
            resultNode.querySelector('.steam-translate-text').textContent = '翻译失败: ' + errMsg;
            resultNode.classList.remove('steam-translate-loading');
            resultNode.classList.add('steam-translate-error');
            addErrorLog(errMsg, text);
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
                    const scopes = ['reviews', 'workshop', 'comments', 'gameDesc'];
                    for (const sc of scopes) {
                        if (!isScopeEnabled(sc)) continue;
                        const sels = SELECTORS[sc] || [];
                        for (const sel of sels) {
                            try {
                                if (node.matches && node.matches(sel)) {
                                    pending.push(node);
                                } else if (node.querySelectorAll) {
                                    node.querySelectorAll(sel).forEach(el => pending.push(el));
                                }
                            } catch (e) { /* 忽略 */ }
                        }
                    }
                    // 新版 Steam 商店页:在 app_reviews_hash 内额外扫描
                    if (isScopeEnabled('reviews') && node.closest && node.closest('#app_reviews_hash')) {
                        if (node.querySelectorAll) {
                            node.querySelectorAll('.Panel div').forEach(el => {
                                if (detectNewReviewContent(el)) pending.push(el);
                            });
                        }
                    }
                    if (isScopeEnabled('gameDesc') && node.closest && node.closest('.game_description_column')) {
                        if (node.querySelectorAll) {
                            node.querySelectorAll('div').forEach(el => {
                                if (detectNewGameDesc(el)) pending.push(el);
                            });
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
        #steam-translate-panel .stp-input {
            background: #2a475e;
            color: #c7d5e0;
            border: 1px solid #345e7a;
            padding: 3px 6px;
            border-radius: 3px;
            font-size: 11px;
            width: 120px;
        }
        #steam-translate-panel .stp-section {
            border-top: 1px solid #2a475e;
            padding-top: 8px;
            margin-top: 4px;
            font-weight: bold;
            color: #66c0f4;
            font-size: 11px;
            margin-bottom: 6px;
        }
        #steam-translate-panel .stp-api-row {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 6px;
            font-size: 11px;
        }
        #steam-translate-panel .stp-api-row label {
            flex: 0 0 60px;
        }
        #steam-translate-panel .stp-api-row input {
            flex: 1;
        }
        #steam-translate-panel .stp-api-hint {
            font-size: 10px;
            color: #8f98a0;
            margin-bottom: 6px;
            line-height: 1.4;
        }
        #steam-translate-panel .stp-api-status {
            font-size: 11px;
            margin-bottom: 6px;
            min-height: 14px;
            -webkit-user-select: text;
            user-select: text;
        }
        #steam-translate-panel .stp-api-status-ok { color: #588a18; }
        #steam-translate-panel .stp-api-status-error { color: #c9302c; }
        #steam-translate-panel .stp-api-status-info { color: #66c0f4; }
        #steam-translate-panel .stp-error-section {
            border-top: 1px solid #2a475e;
            padding-top: 6px;
            margin-top: 6px;
        }
        #steam-translate-panel .stp-error-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            color: #66c0f4;
            font-weight: bold;
            margin-bottom: 4px;
        }
        #steam-translate-panel .stp-error-list {
            max-height: 120px;
            overflow-y: auto;
            font-size: 10px;
            -webkit-user-select: text;
            user-select: text;
        }
        #steam-translate-panel .stp-error-empty {
            color: #8f98a0;
            font-style: italic;
        }
        #steam-translate-panel .stp-error-item {
            border-bottom: 1px solid #2a475e;
            padding: 3px 0;
            color: #c7d5e0;
        }
        #steam-translate-panel .stp-error-time {
            color: #8f98a0;
        }
        #steam-translate-panel .stp-error-msg {
            color: #c9302c;
        }
        #steam-translate-panel .stp-error-text {
            color: #8f98a0;
            font-style: italic;
            margin-top: 2px;
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
    const errorLog = []; // {time: number, message: string, textExcerpt: string}
    const MAX_ERROR_LOG = 20;

    function addErrorLog(message, textExcerpt) {
        errorLog.unshift({
            time: Date.now(),
            message: message,
            textExcerpt: (textExcerpt || '').slice(0, 60)
        });
        if (errorLog.length > MAX_ERROR_LOG) errorLog.pop();
        updateErrorLogDisplay();
    }

    function clearErrorLog() {
        errorLog.length = 0;
        updateErrorLogDisplay();
    }

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
            <div class="stp-section">翻译内容</div>
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
                <label>游戏描述</label>
                <input type="checkbox" class="stp-checkbox" id="stp-gamedesc" ${config.translateGameDesc ? 'checked' : ''}>
            </div>
            <div class="stp-section">百度翻译 API</div>
            <div class="stp-api-hint">
                在 fanyi-api.baidu.com 申请通用翻译 API,填入下方 APP ID 和密钥。
            </div>
            <div class="stp-api-row">
                <label>APP ID</label>
                <input type="text" class="stp-input" id="stp-baidu-appid" placeholder="请输入 APP ID" value="${config.baiduAppId || ''}">
            </div>
            <div class="stp-api-row">
                <label>密钥</label>
                <input type="password" class="stp-input" id="stp-baidu-key" placeholder="请输入密钥" value="${config.baiduSecretKey || ''}">
            </div>
            <div class="stp-row">
                <button class="stp-btn" id="stp-save-api">保存 API 设置</button>
            </div>
            <div class="stp-api-status" id="stp-api-status"></div>
            <div class="stp-row">
                <button class="stp-btn" id="stp-translate-now">立即翻译当前页</button>
            </div>
            <div class="stp-row">
                <button class="stp-btn danger" id="stp-clear-cache">清除缓存</button>
                <button class="stp-btn" id="stp-clear-page">清除本页译文</button>
            </div>
            <div class="stp-stats" id="stp-stats">已翻译: 0 | 缓存命中: 0</div>
            <div class="stp-error-section">
                <div class="stp-error-header">
                    <span>错误日志</span>
                    <button class="stp-btn" id="stp-clear-errors" style="font-size:10px;padding:2px 6px;">清除</button>
                </div>
                <div class="stp-error-list" id="stp-error-list">
                    <div class="stp-error-empty">暂无错误</div>
                </div>
            </div>
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
        document.getElementById('stp-gamedesc').addEventListener('change', e => {
            setConfig('translateGameDesc', e.target.checked);
        });
        // 百度 API 保存(含校验 + 测试)
        async function saveBaiduApi(showFeedback) {
            const appidInput = document.getElementById('stp-baidu-appid');
            const keyInput = document.getElementById('stp-baidu-key');
            const appid = appidInput.value.trim();
            const key = keyInput.value.trim();
            const btn = document.getElementById('stp-save-api');
            const statusEl = document.getElementById('stp-api-status');

            // 非空校验
            if (!appid || !key) {
                if (statusEl) { statusEl.textContent = 'APP ID 和密钥不能为空'; statusEl.className = 'stp-api-status stp-api-status-error'; }
                return;
            }

            // 保存
            setConfig('baiduAppId', appid);
            setConfig('baiduSecretKey', key);

            if (!showFeedback) return; // 自动保存时静默

            // 测试密钥
            if (btn) { btn.textContent = '验证中...'; btn.disabled = true; }
            if (statusEl) { statusEl.textContent = '正在验证密钥...'; statusEl.className = 'stp-api-status stp-api-status-info'; }

            const result = await testBaiduApi(appid, key);
            if (result.ok) {
                if (btn) { btn.textContent = '已保存 ✓'; setTimeout(() => { btn.textContent = '保存 API 设置'; btn.disabled = false; }, 1500); }
                if (statusEl) { statusEl.textContent = '密钥验证成功 ✓'; statusEl.className = 'stp-api-status stp-api-status-ok'; }
            } else {
                if (btn) { btn.textContent = '保存 API 设置'; btn.disabled = false; }
                if (statusEl) { statusEl.textContent = '验证失败: ' + result.message; statusEl.className = 'stp-api-status stp-api-status-error'; }
                addErrorLog('API 验证失败: ' + result.message, '');
            }
        }

        // 按钮点击 → 带反馈保存
        document.getElementById('stp-save-api').addEventListener('click', () => saveBaiduApi(true));
        // 输入框失焦 → 静默保存
        document.getElementById('stp-baidu-appid').addEventListener('blur', () => saveBaiduApi(false));
        document.getElementById('stp-baidu-key').addEventListener('blur', () => saveBaiduApi(false));
        // 回车键 → 带反馈保存
        document.getElementById('stp-baidu-appid').addEventListener('keydown', e => { if (e.key === 'Enter') saveBaiduApi(true); });
        document.getElementById('stp-baidu-key').addEventListener('keydown', e => { if (e.key === 'Enter') saveBaiduApi(true); });
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
        // 清除错误日志
        document.getElementById('stp-clear-errors').addEventListener('click', clearErrorLog);
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

    function updateErrorLogDisplay() {
        const listEl = document.getElementById('stp-error-list');
        if (!listEl) return;
        if (errorLog.length === 0) {
            listEl.innerHTML = '<div class="stp-error-empty">暂无错误</div>';
            return;
        }
        listEl.innerHTML = errorLog.map(entry => {
            const time = new Date(entry.time).toLocaleTimeString();
            const escapedMsg = entry.message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const escapedText = entry.textExcerpt.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            return '<div class="stp-error-item">' +
                '<span class="stp-error-time">' + time + '</span> ' +
                '<span class="stp-error-msg">' + escapedMsg + '</span>' +
                (escapedText ? '<div class="stp-error-text">「' + escapedText + '」</div>' : '') +
                '</div>';
        }).join('');
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
