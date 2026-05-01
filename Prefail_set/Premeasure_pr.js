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
// 計測シナリオ切り替え: default は従来計測、cancel_delay は depth click 後の attack 停止遅延を計測
const SCENARIO = (process.env.SCENARIO || 'default').toLowerCase(); // default | cancel_delay
const CLICK_SELECTOR_DEPTH = process.env.CLICK_SELECTOR_DEPTH || '#link-medium';
const ATTACK_URL_PREFIX = 'https://attack.lab-ish.com/';
const ATTACK_ORIGIN = new URL(ATTACK_URL_PREFIX).origin;

const parsePositiveInt = (raw) => {
    const value = Number.parseInt(raw || '', 10);
    return Number.isInteger(value) && value > 0 ? value : null;
};

// デバッグ用: 試行回数を環境変数で上書き可能
const TRIAL_COUNT_OVERRIDE = parsePositiveInt(process.env.TRIAL_COUNT_OVERRIDE);
const ONE_TRIAL_ONLY = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.ONE_TRIAL_ONLY || process.env.TRIAL_ONE_SHOT || '').toLowerCase()
);
const EFFECTIVE_TRIAL_COUNT = ONE_TRIAL_ONLY ? 1 : (TRIAL_COUNT_OVERRIDE || TRIAL_COUNT);
const TIMELINE_TRIAL_NO = parsePositiveInt(process.env.TIMELINE_TRIAL_NO) || 1;

// Condition は tc 側のプロファイル名ラベルとして使用（必要に応じて追加）
const NETWORK_CONDITIONS = {
    tc_profile: null
};

const TARGETS = [
    { name: 'Light', url: 'https://victim.lab-ish.com/', id: '#link-light' },
    { name: 'Medium', url: 'https://depth.lab-ish.com/', id: '#link-medium' },
    { name: 'Heavy', url: 'https://attack.lab-ish.com/', id: '#link-heavy' }
];
const CANCEL_DELAY_CLICK_TARGET = {
    name: 'Depth',
    url: 'https://depth.lab-ish.com/',
    id: CLICK_SELECTOR_DEPTH
};

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

// attack 側通信の識別は prefix 優先 + origin fallback で行う
const isAttackUrl = (url = '') => {
    if (!url) return false;
    if (url.startsWith(ATTACK_URL_PREFIX)) return true;
    try {
        return new URL(url).origin === ATTACK_ORIGIN;
    } catch {
        return false;
    }
};

const createAttackMonitorState = () => ({
    requests: new Map(), // key: sessionId:requestId
    sessionRequestKeys: new Map(), // sessionId -> Map(requestId -> key)
    clickDetectedAt: null,
    cancelObservationStartedAt: null,
    explicitCancelIssuedAt: null,
    firstStopDetectedAt: null,
    firstStopReason: null,
    firstStopRequestId: null,
    postClickDataEvents: 0,
    postClickDataBytes: 0,
    detachAt: null,
    events: []
});

const buildAttackSummary = (trial) => {
    if (!trial || !trial.attackMonitor) {
        return {
            scenario: SCENARIO,
            clickedAt: '',
            observationStartedAt: '',
            stoppedAt: '',
            stopReason: '',
            canceled: '',
            result: 'none',
            error: '',
            cancelDelay: '',
            transferKB: '',
            postClickDataEvents: '',
            postClickDataKB: '',
            failureClass: 'no_attack_monitor',
            eventsJson: '',
            timelineJson: ''
        };
    }

    const clickedAt = trial.clickedAt;
    const monitor = trial.attackMonitor;
    const requests = Array.from(monitor.requests.values());
    const filterAfterClick = (ts) => (clickedAt ? ts >= clickedAt : true);
    const byTs = (a, b, key) => (a[key] || Number.MAX_SAFE_INTEGER) - (b[key] || Number.MAX_SAFE_INTEGER);

    // 停止時刻の優先順位: canceled loadingFailed > loadingFinished > prerender target detach
    const canceledCandidates = requests
        .filter((r) => r.canceled === true && r.failed_at && filterAfterClick(r.failed_at))
        .sort((a, b) => byTs(a, b, 'failed_at'));
    const finishedCandidates = requests
        .filter((r) => r.finished_at && filterAfterClick(r.finished_at))
        .sort((a, b) => byTs(a, b, 'finished_at'));
    const failedCandidates = requests
        .filter((r) => r.failed_at && filterAfterClick(r.failed_at))
        .sort((a, b) => byTs(a, b, 'failed_at'));

    let stoppedAt = monitor.firstStopDetectedAt || null;
    let stopReason = monitor.firstStopReason || '';
    let canceled = '';
    let result = 'none';
    let error = '';

    if (canceledCandidates.length > 0) {
        stoppedAt = canceledCandidates[0].failed_at;
        stopReason = stopReason || 'loadingFailed_canceled';
        canceled = true;
        result = 'canceled';
        error = canceledCandidates[0].errorText || '';
    } else if (finishedCandidates.length > 0) {
        stoppedAt = finishedCandidates[0].finished_at;
        stopReason = stopReason || 'loadingFinished';
        canceled = false;
        result = 'finished';
        error = finishedCandidates[0].errorText || '';
    } else if (failedCandidates.length > 0) {
        stoppedAt = failedCandidates[0].failed_at;
        stopReason = stopReason || 'loadingFailed';
        canceled = failedCandidates[0].canceled === true ? true : false;
        result = 'failed';
        error = failedCandidates[0].errorText || '';
    } else if (monitor.detachAt && filterAfterClick(monitor.detachAt)) {
        stoppedAt = monitor.detachAt;
        stopReason = stopReason || 'Target.detachedFromTarget';
        canceled = '';
        result = 'detached';
        error = '';
    }

    const cancelDelay = clickedAt && stoppedAt ? stoppedAt - clickedAt : '';
    const transferBytes = requests.reduce((sum, r) => sum + (r.bytes || 0), 0);
    const transferKB = requests.length > 0 ? (transferBytes / 1024).toFixed(2) : '';
    const postClickDataKB = monitor.postClickDataEvents > 0 ? (monitor.postClickDataBytes / 1024).toFixed(2) : '';

    const timelineEvents = monitor.events
        .slice()
        .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
        .map((evt) => ({
            t: evt.timestamp,
            event: evt.event_type,
            requestId: evt.requestId || null,
            canceled: evt.canceled,
            bytes: evt.bytes,
            url: evt.url || null
        }));

    const failureClass = (() => {
        if (!clickedAt) return 'implementation_click_not_detected';
        if (!monitor.cancelObservationStartedAt) return 'implementation_cancel_observation_not_started';
        if (result === 'none') return 'network_or_timing_no_stop_after_click';
        if (result === 'finished') return 'not_canceled_finished';
        if (result === 'canceled') return 'canceled';
        if (result === 'failed') return canceled === true ? 'canceled' : 'failed_non_canceled';
        if (result === 'detached') return 'detached_without_network_stop';
        return `unknown_${result}`;
    })();

    const eventsJson = monitor.events.length > 0 ? JSON.stringify(monitor.events) : '';

    return {
        scenario: SCENARIO,
        clickedAt: clickedAt || '',
        observationStartedAt: monitor.cancelObservationStartedAt || '',
        stoppedAt: stoppedAt || '',
        stopReason,
        canceled,
        result,
        error,
        cancelDelay,
        transferKB,
        postClickDataEvents: monitor.postClickDataEvents || '',
        postClickDataKB,
        failureClass,
        eventsJson,
        timelineJson: timelineEvents.length > 0 ? JSON.stringify(timelineEvents) : ''
    };
};

const toAttackCsvFields = (trial) => {
    const summary = buildAttackSummary(trial);

    return [
        summary.scenario,
        summary.clickedAt,
        summary.observationStartedAt,
        summary.stoppedAt,
        summary.stopReason,
        summary.canceled,
        summary.result,
        summary.error,
        summary.cancelDelay,
        summary.transferKB,
        summary.postClickDataEvents,
        summary.postClickDataKB,
        summary.failureClass,
        summary.eventsJson,
        summary.timelineJson
    ];
};

const ATTACK_FIELD_COUNT = toAttackCsvFields(null).length;

const printTrialTimeline = (trial, trialNo, targetName) => {
    const summary = buildAttackSummary(trial);
    const timeline = summary.timelineJson ? JSON.parse(summary.timelineJson) : [];
    const rows = timeline.map((evt) => ({
        time: evt.t,
        rel_from_click_ms: summary.clickedAt ? evt.t - summary.clickedAt : '',
        event: evt.event,
        requestId: evt.requestId || '',
        canceled: evt.canceled === null || evt.canceled === undefined ? '' : evt.canceled,
        bytes: evt.bytes === null || evt.bytes === undefined ? '' : evt.bytes
    }));

    console.log(`\n--- cancel_delay timeline: trial=${trialNo}, target=${targetName} ---`);
    console.log(`click detected at: ${summary.clickedAt || 'N/A'}`);
    console.log(`cancel observation started at: ${summary.observationStartedAt || 'N/A'}`);
    console.log(`attack request stopped at: ${summary.stoppedAt || 'N/A'}`);
    console.log(`stop reason: ${summary.stopReason || 'N/A'}, result: ${summary.result}, failure_class: ${summary.failureClass}`);
    if (rows.length > 0) {
        console.table(rows);
    } else {
        console.log('timeline events: none');
    }
};

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
        'PR_T2_Transfer_KB',
        'Scenario',
        'Clicked_At',
        'Cancel_Observation_Started_At',
        'PR_Attack_Stopped_At',
        'PR_Attack_Stop_Reason',
        'PR_Attack_Canceled',
        'PR_Attack_Result',
        'PR_Attack_Error',
        'PR_Attack_CancelDelay_ms',
        'PR_Attack_Transfer_KB',
        'PR_Attack_PostClick_DataEvents',
        'PR_Attack_PostClick_Data_KB',
        'PR_Attack_Failure_Class',
        'PR_Attack_Events_JSON',
        'PR_Attack_Timeline_JSON'
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

    console.log(`=== tc帯域制御 前提の通常遷移計測開始(Prerender裏通信ログ付): ${EFFECTIVE_TRIAL_COUNT}回計測 (Wait: ${WAIT_TIME}ms, Scenario: ${SCENARIO}) ===`);
    console.log(`データは ${OUTPUT_FILE} に順次書き込まれます...\n`);

    let currentTrial = null;
    const sessionIdToReqMap = new Map(); // sessionId -> { reqMap: Map }
    const prerenderSessionIds = new Set();
    const prerenderSessions = new Map(); // sessionId -> CDP session
    const attackSessionCleanupMap = new Map(); // sessionId -> cleanup fn

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

    const attachAttackListenersForPrerenderSession = (session, sessionId) => {
        if (!currentTrial || !currentTrial.attackMonitor) return null;

        const trialRef = currentTrial;
        const monitor = trialRef.attackMonitor;
        const reqKeyMap = new Map();
        monitor.sessionRequestKeys.set(sessionId, reqKeyMap);

        // JSON保存用の時系列イベントログ
        const pushAttackEvent = (payload) => {
            if (!currentTrial || currentTrial !== trialRef) return;
            monitor.events.push({
                timestamp: Date.now(),
                clicked_at: trialRef.clickedAt || null,
                ...payload
            });
        };

        // requestId 単位で attack 通信の生存期間と転送量を保持
        const ensureRequestState = ({ requestId, url, resourceType }) => {
            const key = `${sessionId}:${requestId}`;
            if (!monitor.requests.has(key)) {
                monitor.requests.set(key, {
                    requestId,
                    url: url || '',
                    resourceType: resourceType || 'Unknown',
                    started_at: null,
                    finished_at: null,
                    failed_at: null,
                    canceled: false,
                    errorText: null,
                    bytes: 0,
                    sessionId
                });
            }
            reqKeyMap.set(requestId, key);
            return monitor.requests.get(key);
        };

        const getRequestState = (requestId) => {
            const key = reqKeyMap.get(requestId);
            if (!key) return null;
            return monitor.requests.get(key) || null;
        };

        const onRequestWillBeSent = (params) => {
            if (!currentTrial || currentTrial !== trialRef) return;
            const url = params.request?.url || '';
            if (!isAttackUrl(url)) return;
            const req = ensureRequestState({ requestId: params.requestId, url, resourceType: params.type });
            if (!req.started_at) req.started_at = Date.now();
            pushAttackEvent({
                event_type: 'requestWillBeSent',
                requestId: params.requestId,
                sessionId,
                url,
                resourceType: req.resourceType,
                canceled: null,
                bytes: req.bytes
            });
        };

        const onDataReceived = (params) => {
            if (!currentTrial || currentTrial !== trialRef) return;
            const req = getRequestState(params.requestId);
            if (!req) return;
            req.bytes += params.dataLength || 0;
            const now = Date.now();
            if (trialRef.clickedAt && now >= trialRef.clickedAt) {
                monitor.postClickDataEvents += 1;
                monitor.postClickDataBytes += params.dataLength || 0;
            }
            pushAttackEvent({
                event_type: 'dataReceived',
                requestId: params.requestId,
                sessionId,
                url: req.url,
                resourceType: req.resourceType,
                canceled: null,
                bytes: req.bytes
            });
        };

        const onLoadingFinished = (params) => {
            if (!currentTrial || currentTrial !== trialRef) return;
            const req = getRequestState(params.requestId);
            if (!req) return;
            const now = Date.now();
            req.finished_at = now;
            req.bytes = Math.max(req.bytes, params.encodedDataLength || 0);
            pushAttackEvent({
                event_type: 'loadingFinished',
                requestId: params.requestId,
                sessionId,
                url: req.url,
                resourceType: req.resourceType,
                canceled: false,
                bytes: req.bytes
            });
            if (trialRef.clickedAt && now >= trialRef.clickedAt && !monitor.firstStopDetectedAt) {
                monitor.firstStopDetectedAt = now;
                monitor.firstStopReason = 'loadingFinished';
                monitor.firstStopRequestId = params.requestId;
                pushAttackEvent({
                    event_type: 'attack_request_stopped',
                    requestId: params.requestId,
                    sessionId,
                    url: req.url,
                    resourceType: req.resourceType,
                    canceled: false,
                    bytes: req.bytes
                });
            }
        };

        const onLoadingFailed = (params) => {
            if (!currentTrial || currentTrial !== trialRef) return;
            const req = getRequestState(params.requestId);
            if (!req) return;
            const now = Date.now();
            req.failed_at = now;
            req.canceled = !!params.canceled;
            req.errorText = params.errorText || null;
            pushAttackEvent({
                event_type: 'loadingFailed',
                requestId: params.requestId,
                sessionId,
                url: req.url,
                resourceType: req.resourceType,
                canceled: req.canceled,
                bytes: req.bytes
            });
            if (trialRef.clickedAt && now >= trialRef.clickedAt && !monitor.firstStopDetectedAt) {
                monitor.firstStopDetectedAt = now;
                monitor.firstStopReason = req.canceled ? 'loadingFailed_canceled' : 'loadingFailed';
                monitor.firstStopRequestId = params.requestId;
                pushAttackEvent({
                    event_type: 'attack_request_stopped',
                    requestId: params.requestId,
                    sessionId,
                    url: req.url,
                    resourceType: req.resourceType,
                    canceled: req.canceled,
                    bytes: req.bytes
                });
            }
        };

        // 明示キャンセル: click 後に attack URL の新規リクエストを abort する
        const onFetchRequestPaused = async (params) => {
            const requestId = params.requestId;
            const url = params.request?.url || '';
            const clickedAt = trialRef.clickedAt;
            const shouldCancelNow = SCENARIO === 'cancel_delay' && !!clickedAt && isAttackUrl(url);

            if (shouldCancelNow) {
                await session.send('Fetch.failRequest', {
                    requestId,
                    errorReason: 'Aborted'
                }).catch(() => { });
                pushAttackEvent({
                    event_type: 'Fetch.failRequest',
                    requestId,
                    sessionId,
                    url,
                    resourceType: params.resourceType || null,
                    canceled: true,
                    bytes: null
                });
                return;
            }

            await session.send('Fetch.continueRequest', { requestId }).catch(() => { });
        };

        session.on('Network.requestWillBeSent', onRequestWillBeSent);
        session.on('Network.dataReceived', onDataReceived);
        session.on('Network.loadingFinished', onLoadingFinished);
        session.on('Network.loadingFailed', onLoadingFailed);
        session.on('Fetch.requestPaused', onFetchRequestPaused);
        session.send('Fetch.enable', {
            patterns: [{ urlPattern: `${ATTACK_URL_PREFIX}*` }]
        }).catch(() => { });

        return () => {
            session.off('Network.requestWillBeSent', onRequestWillBeSent);
            session.off('Network.dataReceived', onDataReceived);
            session.off('Network.loadingFinished', onLoadingFinished);
            session.off('Network.loadingFailed', onLoadingFailed);
            session.off('Fetch.requestPaused', onFetchRequestPaused);
            session.send('Fetch.disable').catch(() => { });
            monitor.sessionRequestKeys.delete(sessionId);
        };
    };

    const requestExplicitAttackCancel = async (trialRef) => {
        if (!trialRef || !trialRef.attackMonitor) return;
        if (SCENARIO !== 'cancel_delay') return;

        const monitor = trialRef.attackMonitor;
        if (!monitor.explicitCancelIssuedAt) {
            monitor.explicitCancelIssuedAt = Date.now();
            monitor.events.push({
                timestamp: monitor.explicitCancelIssuedAt,
                event_type: 'explicitCancelRequested',
                requestId: null,
                sessionId: null,
                url: ATTACK_URL_PREFIX,
                resourceType: null,
                canceled: true,
                bytes: null,
                clicked_at: trialRef.clickedAt || null
            });
        }

        const stopTasks = Array.from(prerenderSessions.values()).map((prSession) =>
            prSession.send('Page.stopLoading').catch(() => { })
        );
        await Promise.all(stopTasks);
    };

    const handleAttachedToTarget = async (params) => {
        if (params.targetInfo?.subtype !== 'prerender') return;
        const session = connection.session(params.sessionId);
        if (!session) return;
        prerenderSessions.set(params.sessionId, session);
        const targetUrl = params.targetInfo?.url || '';
        const prIndex = resolvePrIndexForTarget(targetUrl);
        prerenderSessionIds.add(params.sessionId);
        try {
            await session.send('Network.enable');
            await session.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => { });
            await session.send('Preload.enable').catch(() => { });
            await session.send('Runtime.runIfWaitingForDebugger').catch(() => { });
        } catch (e) {
            // ignore
        }
        const cleanup = statusOnly ? null : attachNetworkListenersForSession(session, prIndex === -1 ? null : prIndex);
        const attackCleanup = attachAttackListenersForPrerenderSession(session, params.sessionId);
        if (attackCleanup) {
            attackSessionCleanupMap.set(params.sessionId, attackCleanup);
        }
        session.on('Target.detachedFromTarget', () => cleanup && cleanup());
    };

    const handleDetachedFromTarget = (params) => {
        prerenderSessions.delete(params.sessionId);
        const shouldCaptureAttackDetach =
            !!(currentTrial && currentTrial.attackMonitor && currentTrial.attackMonitor.sessionRequestKeys.has(params.sessionId));

        if (shouldCaptureAttackDetach) {
            // stop event が取れなかった場合の補助時刻として detach を残す
            const monitor = currentTrial.attackMonitor;
            monitor.detachAt = Date.now();
            monitor.events.push({
                timestamp: monitor.detachAt,
                event_type: 'Target.detachedFromTarget',
                requestId: null,
                sessionId: params.sessionId,
                url: params.targetInfo?.url || '',
                resourceType: null,
                canceled: null,
                bytes: null,
                clicked_at: currentTrial.clickedAt || null
            });
        }

        const attackCleanup = attackSessionCleanupMap.get(params.sessionId);
        if (attackCleanup) {
            attackCleanup();
            attackSessionCleanupMap.delete(params.sessionId);
        }

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

    // cancel_delay は「depth を実クリック先」に固定し、attack 側 prerender 通信停止を観測
    const runTargets = SCENARIO === 'cancel_delay' ? [CANCEL_DELAY_CLICK_TARGET] : targetsToMeasure;

    for (const [conditionName] of Object.entries(NETWORK_CONDITIONS)) {
        for (const target of runTargets) {
            console.log(`[${conditionName}] - ${target.name} 測定中...`);
            let consecutiveFailures = 0;

            // 新規ターゲット（プリレンダなど）にもキャッシュ無効化を適用
            const handleTargetCreated = async (targetObj) => {
                if (targetObj.type() !== 'page') return;
                const newPage = await targetObj.page();
                await applyThrottle(newPage);
            };
            browser.on('targetcreated', handleTargetCreated);

            for (let i = 1; i <= EFFECTIVE_TRIAL_COUNT; i++) {
                if (consecutiveFailures >= SKIP_THRESHOLD) {
                    console.log(`\n   ⚠️  ${SKIP_THRESHOLD}回連続失敗のため残りをTimeOutとします。`);
                    for (let k = i; k <= EFFECTIVE_TRIAL_COUNT; k++) {
                        const skipFields = [
                            conditionName,
                            target.name,
                            k,
                            'TimeOut',
                            'TimeOut',
                            0,
                            'FALSE',
                            ...Array(14).fill(''),
                            SCENARIO,
                            ...Array(ATTACK_FIELD_COUNT - 1).fill('')
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
                    prStatus: prUrls.map((url) => createPrStatusState(url)),
                    clickedAt: null,
                    attackMonitor: createAttackMonitorState()
                };

                // Prerender target logging state
                const trialStart = Date.now();

                const session = await page.target().createCDPSession();
                await session.send('Network.enable');
                // Clear caches/cookies each trial so transfer size reflects actual fetch
                await session.send('Network.clearBrowserCache').catch(() => { });
                await session.send('Network.clearBrowserCookies').catch(() => { });
                await session.send('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => { });
                await session.send('Preload.enable').catch(() => { });
                await session.send('Runtime.runIfWaitingForDebugger').catch(() => { });
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

                            // cancel_delay シナリオでは depth 実クリック時刻を主指標として保存
                            currentTrial.clickedAt = Date.now();
                            currentTrial.attackMonitor.clickDetectedAt = currentTrial.clickedAt;
                            currentTrial.attackMonitor.events.push({
                                timestamp: currentTrial.clickedAt,
                                event_type: 'click_detected',
                                requestId: null,
                                sessionId: null,
                                url: target.url,
                                resourceType: null,
                                canceled: null,
                                bytes: null,
                                clicked_at: currentTrial.clickedAt
                            });
                            currentTrial.attackMonitor.cancelObservationStartedAt = Date.now();
                            currentTrial.attackMonitor.events.push({
                                timestamp: currentTrial.attackMonitor.cancelObservationStartedAt,
                                event_type: 'cancel_observation_started',
                                requestId: null,
                                sessionId: null,
                                url: ATTACK_URL_PREFIX,
                                resourceType: null,
                                canceled: null,
                                bytes: null,
                                clicked_at: currentTrial.clickedAt
                            });
                            await Promise.all([
                                page.waitForNavigation({ waitUntil: 'load', timeout: TRIAL_TIMEOUT_MS }),
                                (async () => {
                                    await page.click(target.id);
                                    await requestExplicitAttackCancel(currentTrial);
                                })()
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

                    const attackFields = toAttackCsvFields(currentTrial);

                    const csvLine = [
                        conditionName,
                        target.name,
                        i,
                        metrics.lcp.toFixed(2),
                        metrics.fcp.toFixed(2),
                        (metrics.size / 1024 / 1024).toFixed(2),
                        overall.status === 'success',
                        ...prFields,
                        ...attackFields
                    ]
                        .map(toCsvValue)
                        .join(',') + '\n';

                    fs.appendFileSync(OUTPUT_FILE, csvLine);

                    if (SCENARIO === 'cancel_delay' && i === TIMELINE_TRIAL_NO) {
                        printTrialTimeline(currentTrial, i, target.name);
                    }

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

                    const attackFields = toAttackCsvFields(currentTrial);

                    const errorFields = [
                        conditionName,
                        target.name,
                        i,
                        'TimeOut',
                        'TimeOut',
                        0,
                        false,
                        ...prFields,
                        ...attackFields
                    ];
                    fs.appendFileSync(OUTPUT_FILE, errorFields.map(toCsvValue).join(',') + '\n');

                    if (SCENARIO === 'cancel_delay' && i === TIMELINE_TRIAL_NO) {
                        printTrialTimeline(currentTrial, i, target.name);
                    }
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
    attackSessionCleanupMap.forEach((cleanup) => cleanup && cleanup());
    attackSessionCleanupMap.clear();
    prerenderSessions.clear();
    await browser.close();
})();
