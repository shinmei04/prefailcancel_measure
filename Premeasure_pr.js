const puppeteer = require('puppeteer');
const fs = require('fs');

// ==========================================
// tc コマンドで帯域を制御する前提の通常遷移計測スクリプト（Prerender裏通信ログ付き）
// 追加列:
//  PR_Target{1,2}_URL, PR_T{1,2}_ReqStarted, PR_T{1,2}_Result, PR_T{1,2}_HTTPStatus,
//  PR_T{1,2}_Error, PR_T{1,2}_Duration_ms, PR_T{1,2}_Transfer_KB
// ==========================================

const TRIAL_COUNT = 100; // 各ターゲットでの計測回数
const OUTPUT_FILE = 'raw.csv'; // 保存ファイル名
const SKIP_THRESHOLD = 5; // 5回連続失敗でスキップ
const WAIT_TIME = 2000; // Home滞在時間 (ms)
const TRIAL_TIMEOUT_MS = 120000; // 1試行の上限時間
const HOME_URL = 'https://home.lab-ish.com/index.html';
const PR_MONITOR_MODE = (process.env.PR_MONITOR_MODE || 'full').toLowerCase(); // 'full' or 'status-only'

// Condition は tc 側のプロファイル名ラベルとして使用（必要に応じて追加）
const NETWORK_CONDITIONS = {
    tc_profile: null
};

const TARGETS = [
    { name: 'Light', url: 'https://victim.lab-ish.com/', id: '#link-light' },
    { name: 'Medium', url: 'https://depth.lab-ish.com/', id: '#link-medium' },
    { name: 'Heavy', url: 'https://attack.lab-ish.com/', id: '#link-heavy' }
];

// CLI/TARGETS env で Light/Medium/Heavy を絞り込み
const targetsToMeasure = (() => {
    const cliArgs = process.argv.slice(2).filter(Boolean);
    const raw = cliArgs.length ? cliArgs.join(',') : (process.env.TARGETS || process.env.TARGET || '');
    if (!raw.trim()) return TARGETS;
    const set = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
    const filtered = TARGETS.filter((t) => set.has(t.name.toLowerCase()));
    return filtered.length ? filtered : TARGETS;
})();

// 監視候補（裏通信）: 計測対象以外の2サイトを監視する
const PR_TARGET_CANDIDATES = [
    'https://victim.lab-ish.com/',
    'https://depth.lab-ish.com/',
    'https://attack.lab-ish.com/'
];

const applyThrottle = async (page) => {
    if (!page) return;
    await page.setCacheEnabled(false);
};

const toCsvValue = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return value;
    return `"${String(value).replace(/"/g, '""')}"`;
};

const createPrState = (url) => ({
    url,
    started: false,
    result: 'none',
    httpStatus: null,
    error: null,
    startTime: null,
    endTime: null,
    bytes: 0
});

const createPrStatusState = (url) => ({
    url,
    status: 'none', // success / failed / canceled / none
    detectSource: 'none',
    note: '',
    failReason: null // e.g., DevToolsDisabled
});

(async () => {
    const header = [
        'Condition',
        'Page',
        'Trial_No',
        'LCP_ms',
        'FCP_ms',
        'Transfer_MB',
        'Prerendered',
        'PR_Target1_URL',
        'PR_T1_ReqStarted',
        'PR_T1_Result',
        'PR_T1_HTTPStatus',
        'PR_T1_Error',
        'PR_T1_Duration_ms',
        'PR_T1_Transfer_KB',
        'PR_Target2_URL',
        'PR_T2_ReqStarted',
        'PR_T2_Result',
        'PR_T2_HTTPStatus',
        'PR_T2_Error',
        'PR_T2_Duration_ms',
        'PR_T2_Transfer_KB'
    ].join(',');
    fs.writeFileSync(OUTPUT_FILE, `${header}\n`);

    const browser = await puppeteer.launch({
        headless: 'new',
        ignoreHTTPSErrors: true,
        args: ['--ignore-certificate-errors']
    });
    const browserSession = await browser.target().createCDPSession();
    const connection = browserSession.connection();
    const statusOnly = PR_MONITOR_MODE === 'status-only';
    await browserSession.send('Target.setAutoAttach', {
        autoAttach: true,
        flatten: true,
        waitForDebuggerOnStart: false
    });

    console.log(`=== tc帯域制御 前提の通常遷移計測開始(Prerender裏通信ログ付): ${TRIAL_COUNT}回計測 (Wait: ${WAIT_TIME}ms) ===`);
    console.log(`データは ${OUTPUT_FILE} に順次書き込まれます...\n`);

    let currentTrial = null;
    const sessionIdToReqMap = new Map(); // sessionId -> { reqMap: Map }
    const prerenderSessionIds = new Set();

    const findTargetIndex = (url = '') => {
        if (!currentTrial) return -1;
        return currentTrial.prUrls.findIndex((t) => url.startsWith(t));
    };

    // Resolve which prerender target this session belongs to, based on target URL and current trial state.
    const resolvePrIndexForTarget = (targetUrl = '') => {
        if (!currentTrial) return -1;
        const direct = findTargetIndex(targetUrl);
        if (direct !== -1) return direct;
        // Try origin match as a looser fallback.
        try {
            const targetOrigin = new URL(targetUrl).origin;
            const originIdx = currentTrial.prUrls.findIndex((u) => {
                try {
                    return new URL(u).origin === targetOrigin;
                } catch {
                    return false;
                }
            });
            if (originIdx !== -1) return originIdx;
        } catch {
            // ignore parse failure
        }
        // As a last resort, pick the first unused slot to avoid dropping the session entirely.
        const used = new Set(
            Array.from(sessionIdToReqMap.values())
                .map((v) => v.prIndex)
                .filter((v) => v !== null && v !== undefined && v !== -1)
        );
        for (let i = 0; i < currentTrial.prUrls.length; i++) {
            if (!used.has(i)) return i;
        }
        return 0;
    };

    const attachNetworkListenersForSession = (session, forcedPrIndex = null) => {
        const reqMap = new Map();
        sessionIdToReqMap.set(session.id(), { reqMap, prIndex: forcedPrIndex });

        const handleRequestWillBeSent = (params) => {
            if (!currentTrial) return;
            const url = params.request?.url || '';
            const idx = forcedPrIndex !== null ? forcedPrIndex : findTargetIndex(url);
            if (idx === -1) return;
            const pr = currentTrial.prStates[idx];
            if (!pr.started) {
                pr.started = true;
                pr.startTime = Date.now();
                pr.result = 'pending';
            }
            reqMap.set(params.requestId, idx);
        };

        const handleResponseReceived = (params) => {
            if (!currentTrial) return;
            const data = sessionIdToReqMap.get(session.id());
            if (!data) return;
            const idx = data.reqMap.get(params.requestId);
            if (idx === undefined) return;
            const pr = currentTrial.prStates[idx];
            if (pr.httpStatus === null && params.response?.status) {
                pr.httpStatus = params.response.status;
            }
        };

        const handleDataReceived = (params) => {
            if (!currentTrial) return;
            const data = sessionIdToReqMap.get(session.id());
            if (!data) return;
            const idx = data.reqMap.get(params.requestId);
            if (idx === undefined) return;
            const pr = currentTrial.prStates[idx];
            pr.bytes += params.dataLength || 0;
        };

        const handleLoadingFinished = (params) => {
            if (!currentTrial) return;
            const data = sessionIdToReqMap.get(session.id());
            if (!data) return;
            const idx = data.reqMap.get(params.requestId);
            if (idx === undefined) return;
            const pr = currentTrial.prStates[idx];
            pr.bytes = Math.max(pr.bytes, params.encodedDataLength || 0);
            pr.endTime = Date.now();
            pr.result = 'finished';
        };

        const handleLoadingFailed = (params) => {
            if (!currentTrial) return;
            const data = sessionIdToReqMap.get(session.id());
            if (!data) return;
            const idx = data.reqMap.get(params.requestId);
            if (idx === undefined) return;
            const pr = currentTrial.prStates[idx];
            pr.endTime = Date.now();
            pr.result = params.canceled ? 'canceled' : 'failed';
            pr.error = params.errorText || null;
        };

        session.on('Network.requestWillBeSent', handleRequestWillBeSent);
        session.on('Network.responseReceived', handleResponseReceived);
        session.on('Network.dataReceived', handleDataReceived);
        session.on('Network.loadingFinished', handleLoadingFinished);
        session.on('Network.loadingFailed', handleLoadingFailed);

        return () => {
            session.off('Network.requestWillBeSent', handleRequestWillBeSent);
            session.off('Network.responseReceived', handleResponseReceived);
            session.off('Network.dataReceived', handleDataReceived);
            session.off('Network.loadingFinished', handleLoadingFinished);
            session.off('Network.loadingFailed', handleLoadingFailed);
            sessionIdToReqMap.delete(session.id());
        };
    };

    const handleAttachedToTarget = async (params) => {
        if (params.targetInfo?.subtype !== 'prerender') return;
        const session = connection.session(params.sessionId);
        if (!session) return;
        const targetUrl = params.targetInfo?.url || '';
        const prIndex = resolvePrIndexForTarget(targetUrl);
        prerenderSessionIds.add(params.sessionId);
        try {
            await session.send('Network.enable');
            await session.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
            await session.send('Preload.enable').catch(() => {});
            await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
        } catch (e) {
            // ignore
        }
        const cleanup = statusOnly ? null : attachNetworkListenersForSession(session, prIndex === -1 ? null : prIndex);
        session.on('Target.detachedFromTarget', () => cleanup && cleanup());
    };

    const handleDetachedFromTarget = (params) => {
        if (statusOnly) return;
        if (!prerenderSessionIds.has(params.sessionId)) return;
        const data = sessionIdToReqMap.get(params.sessionId);
        if (currentTrial && data) {
            // If still pending and no explicit status, mark canceled.
            currentTrial.prStates.forEach((pr) => {
                if (pr.result === 'pending') {
                    pr.result = 'canceled';
                    pr.endTime = pr.endTime || Date.now();
                }
            });
            currentTrial.prStatus.forEach((st) => {
                if (st.status === 'none') {
                    st.status = 'canceled';
                    st.detectSource = 'Target.detachedFromTarget';
                    st.note = 'detached';
                }
            });
        }
        sessionIdToReqMap.delete(params.sessionId);
        prerenderSessionIds.delete(params.sessionId);
    };

    browserSession.on('Target.attachedToTarget', handleAttachedToTarget);
    browserSession.on('Target.detachedFromTarget', handleDetachedFromTarget);

    for (const [conditionName] of Object.entries(NETWORK_CONDITIONS)) {
        for (const target of targetsToMeasure) {
            console.log(`[${conditionName}] - ${target.name} 測定中...`);
            let consecutiveFailures = 0;

            // 新規ターゲット（プリレンダなど）にもキャッシュ無効化を適用
            const handleTargetCreated = async (targetObj) => {
                if (targetObj.type() !== 'page') return;
                const newPage = await targetObj.page();
                await applyThrottle(newPage);
            };
            browser.on('targetcreated', handleTargetCreated);

            for (let i = 1; i <= TRIAL_COUNT; i++) {
                if (consecutiveFailures >= SKIP_THRESHOLD) {
                    console.log(`\n   ⚠️  ${SKIP_THRESHOLD}回連続失敗のため残りをTimeOutとします。`);
                    for (let k = i; k <= TRIAL_COUNT; k++) {
                        const skipFields = [
                            conditionName,
                            target.name,
                            k,
                            'TimeOut',
                            'TimeOut',
                            0,
                            'FALSE',
                            ...Array(14).fill('')
                        ];
                        fs.appendFileSync(OUTPUT_FILE, skipFields.map(toCsvValue).join(',') + '\n');
                    }
                    break;
                }

                const page = await browser.newPage();
                await page.setViewport({ width: 1280, height: 20000 });
                await applyThrottle(page);
                const prUrls = PR_TARGET_CANDIDATES.filter((u) => u !== target.url).slice(0, 2);
                currentTrial = {
                    prUrls,
                    prStates: prUrls.map((url) => createPrState(url)),
                    prStatus: prUrls.map((url) => createPrStatusState(url))
                };

                // Prerender target logging state
                const trialStart = Date.now();

                const session = await page.target().createCDPSession();
                await session.send('Network.enable');
                // Clear caches/cookies each trial so transfer size reflects actual fetch
                await session.send('Network.clearBrowserCache').catch(() => {});
                await session.send('Network.clearBrowserCookies').catch(() => {});
                await session.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
                await session.send('Preload.enable').catch(() => {});
                await session.send('Runtime.runIfWaitingForDebugger').catch(() => {});
                // Also watch network on top-level page (in case prerender requests leak here)
                // Top-level page: still attach with URL-based fallback to catch leaks, but prerender sessions are keyed by session.
                const cleanupTopNetwork = statusOnly ? null : attachNetworkListenersForSession(session);

                const handlePreloadStatus = (params) => {
                    if (!currentTrial) return;
                    const url = params.key?.url || '';
                    const idx = findTargetIndex(url);
                    if (idx === -1) return;
                    const st = currentTrial.prStatus[idx];
                    const status = params.status || '';
                    const final = params.prerenderStatus || '';
                    if (status === 'Success' || final === 'Activated') {
                        st.status = 'success';
                        st.detectSource = 'Preload.prerenderStatusUpdated';
                        st.note = final || status;
                    } else if (final === 'PrerenderingDisabledByDevTools') {
                        st.status = 'failed';
                        st.detectSource = 'Preload.prerenderStatusUpdated';
                        st.note = final;
                        st.failReason = 'DevToolsDisabled';
                    } else if (status === 'Failure') {
                        st.status = 'failed';
                        st.detectSource = 'Preload.prerenderStatusUpdated';
                        st.note = final || 'Failure';
                    } else if (status === 'Running' || status === 'Pending') {
                        // keep as none but note running
                        if (st.status === 'none') {
                            st.note = 'running';
                            st.detectSource = 'Preload.prerenderStatusUpdated';
                        }
                    }
                };

                session.on('Preload.prerenderStatusUpdated', handlePreloadStatus);

                let timeoutId;
                const trialTimeout = new Promise((_, rej) => {
                    timeoutId = setTimeout(() => rej(new Error('Trial timeout')), TRIAL_TIMEOUT_MS);
                });

                try {
                    const metrics = await Promise.race([
                        (async () => {
                            await page.goto(HOME_URL, { waitUntil: 'networkidle0', timeout: 120000 });
                            // Give prerender target time to be created before navigation/activation
                            await new Promise((r) => setTimeout(r, 200));

                            await new Promise((r) => setTimeout(r, WAIT_TIME));

                            await Promise.all([
                                page.waitForNavigation({ waitUntil: 'load', timeout: TRIAL_TIMEOUT_MS }),
                                page.click(target.id)
                            ]);

                            const metrics = await page.evaluate(async () => {
                                const getLCP = () =>
                                    new Promise((r) => {
                                        new PerformanceObserver((l) => r(l.getEntries().pop())).observe({
                                            type: 'largest-contentful-paint',
                                            buffered: true
                                        });
                                        setTimeout(() => r(null), 5000);
                                    });

                                const [nav] = performance.getEntriesByType('navigation');
                                const [fcp] = performance.getEntriesByName('first-contentful-paint');
                                const lcpEntry = await getLCP();
                                const resources = performance.getEntriesByType('resource');
                                const resSize = resources.reduce((sum, r) => sum + r.transferSize, 0);

                                const actStart = nav.activationStart || 0;
                                const lcp = lcpEntry ? lcpEntry.startTime : 0;
                                const fcpTime = fcp ? fcp.startTime : 0;

                                return {
                                    lcp: Math.max(0, lcp - actStart),
                                    fcp: Math.max(0, fcpTime - actStart),
                                    size: (nav.transferSize || 0) + resSize,
                                    isPrerender: actStart > 0
                                };
                            });

                            return metrics;
                        })(),
                        trialTimeout
                    ]);

                    clearTimeout(timeoutId);

                    // finalize pending PR states
                    if (!statusOnly) {
                        currentTrial.prStates.forEach((pr) => {
                            if (pr.result === 'pending') {
                                pr.result = 'failed';
                                pr.endTime = pr.endTime || Date.now();
                            }
                        });
                    }

                    // infer overall prerender status
                    const overall = (() => {
                        const st = currentTrial.prStatus;
                        const hasSuccess = st.some((s) => s.status === 'success');
                        if (hasSuccess) return { status: 'success', detect: 'Preload.prerenderStatusUpdated', note: 'Activated' };
                        const canceled = st.find((s) => s.status === 'canceled');
                        if (canceled) return { status: 'canceled', detect: canceled.detectSource || 'Target.detach', note: canceled.note || '' };
                        const failed = st.find((s) => s.status === 'failed');
                        if (failed) return { status: 'failed', detect: failed.detectSource || 'unknown', note: failed.note || '' };
                        const anyReq = currentTrial.prStates.some((pr) => pr.started);
                        if (anyReq) return { status: 'unknown', detect: 'NetworkOnly', note: 'no Preload event' };
                        return { status: 'none', detect: 'NoEvent', note: 'no prerender seen' };
                    })();

                        const prFields = currentTrial.prStates.flatMap((pr) => {
                            const duration = pr.startTime && pr.endTime ? pr.endTime - pr.startTime : null;
                            const transferKB =
                                pr.started && pr.bytes !== null && pr.bytes !== undefined
                                    ? (pr.bytes / 1024).toFixed(2)
                                    : null;
                            return [
                                pr.url,
                                pr.started,
                            pr.result,
                            pr.httpStatus,
                            pr.error,
                            duration !== null ? duration : '',
                            transferKB !== null ? transferKB : ''
                        ];
                    });

                    const csvLine = [
                        conditionName,
                        target.name,
                        i,
                        metrics.lcp.toFixed(2),
                        metrics.fcp.toFixed(2),
                        (metrics.size / 1024 / 1024).toFixed(2),
                        overall.status === 'success',
                        ...prFields
                    ]
                        .map(toCsvValue)
                        .join(',') + '\n';

                    fs.appendFileSync(OUTPUT_FILE, csvLine);

                    consecutiveFailures = 0;
                    process.stdout.write(`.`);
                } catch (e) {
                    clearTimeout(timeoutId);
                    consecutiveFailures++;
                    console.error(`\n[Error] Trial ${i}: ${e.message}`);

                    // finalize pending PR states
                    if (!statusOnly) {
                        currentTrial.prStates.forEach((pr) => {
                            if (pr.result === 'pending') {
                                pr.result = 'failed';
                                pr.endTime = pr.endTime || Date.now();
                            }
                        });
                    }
                    const overall = (() => {
                        const st = currentTrial.prStatus;
                        const hasSuccess = st.some((s) => s.status === 'success');
                        if (hasSuccess) return { status: 'success', detect: 'Preload.prerenderStatusUpdated', note: 'Activated' };
                        const canceled = st.find((s) => s.status === 'canceled');
                        if (canceled) return { status: 'canceled', detect: canceled.detectSource || 'Target.detach', note: canceled.note || '' };
                        const failed = st.find((s) => s.status === 'failed');
                        if (failed) return { status: 'failed', detect: failed.detectSource || 'unknown', note: failed.note || '' };
                        const anyReq = currentTrial.prStates.some((pr) => pr.started);
                        if (anyReq) return { status: 'unknown', detect: 'NetworkOnly', note: 'no Preload event' };
                        return { status: 'none', detect: 'NoEvent', note: 'no prerender seen' };
                    })();

                    const prFields = currentTrial.prStates.flatMap((pr) => {
                        const duration = pr.startTime && pr.endTime ? pr.endTime - pr.startTime : null;
                        const transferKB =
                            pr.started && pr.bytes !== null && pr.bytes !== undefined
                                ? (pr.bytes / 1024).toFixed(2)
                                : null;
                        return [
                            pr.url,
                            pr.started,
                            pr.result,
                            pr.httpStatus,
                            pr.error,
                            duration !== null ? duration : '',
                            transferKB !== null ? transferKB : ''
                        ];
                    });

                    const errorFields = [
                        conditionName,
                        target.name,
                        i,
                        'TimeOut',
                        'TimeOut',
                        0,
                        false,
                        ...prFields
                    ];
                    fs.appendFileSync(OUTPUT_FILE, errorFields.map(toCsvValue).join(',') + '\n');
                } finally {
                    cleanupTopNetwork && cleanupTopNetwork();
                    session.off('Preload.prerenderStatusUpdated', handlePreloadStatus);
                    await page.close();
                    currentTrial = null;
                }
            }
            browser.off('targetcreated', handleTargetCreated);
            console.log(' 完了');
        }
    }

    console.log(`\n=== 全計測終了 ===`);
    browserSession.off('Target.attachedToTarget', handleAttachedToTarget);
    browserSession.off('Target.detachedFromTarget', handleDetachedFromTarget);
    await browser.close();
})();
