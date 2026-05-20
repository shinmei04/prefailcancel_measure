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

const PREFAIL_TIMELINE_HEADERS = [
    'Prefail_Click_ms',
    'Prefail_First_PR_Attach_ms',
    'Prefail_Last_PR_Detach_ms',
    'Prefail_First_PR_Request_ms',
    'Prefail_Last_PR_Event_ms',
    'Prefail_Last_PR_End_ms',
    'Prefail_PostClick_PR_Tail_ms',
    'Prefail_PostClick_PR_Active_ms',
    'Prefail_PostClick_PR_Transfer_KB',
    'Prefail_Open_PR_Request_Count',
    'Prefail_Normal_Nav_Start_ms',
    'Prefail_Normal_Nav_End_ms',
    'Prefail_PR_Normal_Overlap_ms',
    'Prefail_PR_Event_Count',
    'Prefail_Normal_Event_Count',
    'Prefail_Timeline_JSON'
];
const PREFAIL_FIELD_COUNT = PREFAIL_TIMELINE_HEADERS.length;

const createPrefailTimelineState = () => ({
    clickAt: null,
    prRequests: new Map(), // key: sessionId:requestId
    normalRequests: new Map(), // key: sessionId:requestId
    prerenderTargets: new Map(), // sessionId -> { attachAt, detachAt, ... }
    events: []
});

const isFiniteTime = (value) => typeof value === 'number' && Number.isFinite(value);

const minTime = (values) => {
    const filtered = values.filter(isFiniteTime);
    return filtered.length > 0 ? Math.min(...filtered) : null;
};

const maxTime = (values) => {
    const filtered = values.filter(isFiniteTime);
    return filtered.length > 0 ? Math.max(...filtered) : null;
};

const relTime = (trial, timestamp) => {
    if (!trial || !isFiniteTime(trial.trialStart) || !isFiniteTime(timestamp)) return '';
    return timestamp - trial.trialStart;
};

const pushPrefailTimelineEvent = (trial, payload) => {
    if (!trial || !trial.prefailTimeline || !isFiniteTime(trial.trialStart)) return;
    const timestamp = payload.timestamp || Date.now();
    const event = {
        t: relTime(trial, timestamp),
        event: payload.event,
        category: payload.category
    };
    if (isFiniteTime(trial.clickedAt)) {
        event.rel_click_ms = timestamp - trial.clickedAt;
    }
    [
        'sessionId',
        'requestId',
        'prIndex',
        'sessionType',
        'url',
        'resourceType',
        'status',
        'prerenderStatus',
        'httpStatus',
        'bytes',
        'canceled',
        'errorText'
    ].forEach((key) => {
        if (payload[key] !== undefined && payload[key] !== null) {
            event[key] = payload[key];
        }
    });
    trial.prefailTimeline.events.push(event);
};

const getTimelineRequestKey = (sessionId, requestId) => `${sessionId}:${requestId}`;

const ensureTimelineRequest = (trial, mapName, fields) => {
    if (!trial || !trial.prefailTimeline || !fields.sessionId || !fields.requestId) return null;
    const requests = trial.prefailTimeline[mapName];
    const key = getTimelineRequestKey(fields.sessionId, fields.requestId);
    if (!requests.has(key)) {
        requests.set(key, {
            sessionId: fields.sessionId,
            requestId: fields.requestId,
            prIndex: fields.prIndex,
            sessionType: fields.sessionType || '',
            url: fields.url || '',
            resourceType: fields.resourceType || '',
            requestAt: null,
            responseAt: null,
            lastDataAt: null,
            finishAt: null,
            failAt: null,
            endAt: null,
            lastEventAt: null,
            bytes: 0,
            postClickBytes: 0,
            dataEvents: 0,
            httpStatus: null,
            canceled: false,
            errorText: null
        });
    }
    const req = requests.get(key);
    ['prIndex', 'sessionType', 'url', 'resourceType'].forEach((name) => {
        if (fields[name] !== undefined && fields[name] !== null && fields[name] !== '') {
            req[name] = fields[name];
        }
    });
    return req;
};

const getTimelineRequest = (trial, mapName, sessionId, requestId) => {
    if (!trial || !trial.prefailTimeline || !sessionId || !requestId) return null;
    return trial.prefailTimeline[mapName].get(getTimelineRequestKey(sessionId, requestId)) || null;
};

const getObservedRequestEndAt = (req) =>
    req.endAt || req.lastDataAt || req.responseAt || req.requestAt || null;

const getIntervalsAfterClick = (requests, clickAt) => {
    if (!isFiniteTime(clickAt)) return [];
    return requests
        .map((req) => {
            const start = req.requestAt;
            const end = getObservedRequestEndAt(req);
            if (!isFiniteTime(start) || !isFiniteTime(end) || end < clickAt) return null;
            const clippedStart = Math.max(start, clickAt);
            if (end <= clippedStart) return null;
            return { start: clippedStart, end };
        })
        .filter(Boolean);
};

const mergeIntervals = (intervals) => {
    const sorted = intervals
        .filter((item) => isFiniteTime(item.start) && isFiniteTime(item.end) && item.end > item.start)
        .slice()
        .sort((a, b) => a.start - b.start);
    const merged = [];
    sorted.forEach((item) => {
        const last = merged[merged.length - 1];
        if (!last || item.start > last.end) {
            merged.push({ start: item.start, end: item.end });
            return;
        }
        last.end = Math.max(last.end, item.end);
    });
    return merged;
};

const getUnionDuration = (intervals) =>
    mergeIntervals(intervals).reduce((sum, item) => sum + item.end - item.start, 0);

const getOverlapDuration = (leftIntervals, rightIntervals) => {
    const left = mergeIntervals(leftIntervals);
    const right = mergeIntervals(rightIntervals);
    let i = 0;
    let j = 0;
    let overlap = 0;
    while (i < left.length && j < right.length) {
        const start = Math.max(left[i].start, right[j].start);
        const end = Math.min(left[i].end, right[j].end);
        if (end > start) overlap += end - start;
        if (left[i].end < right[j].end) {
            i++;
        } else {
            j++;
        }
    }
    return overlap;
};

const buildPrefailTimelineSummary = (trial) => {
    const empty = {
        clickMs: '',
        firstPrAttachMs: '',
        lastPrDetachMs: '',
        firstPrRequestMs: '',
        lastPrEventMs: '',
        lastPrEndMs: '',
        postClickPrTailMs: '',
        postClickPrActiveMs: '',
        postClickPrTransferKB: '',
        openPrRequestCount: '',
        normalNavStartMs: '',
        normalNavEndMs: '',
        prNormalOverlapMs: '',
        prEventCount: '',
        normalEventCount: '',
        timelineJson: ''
    };
    if (!trial || !trial.prefailTimeline) return empty;

    const timeline = trial.prefailTimeline;
    const clickAt = timeline.clickAt || trial.clickedAt || null;
    const prRequests = Array.from(timeline.prRequests.values());
    const normalRequests = Array.from(timeline.normalRequests.values());
    const prTargets = Array.from(timeline.prerenderTargets.values());
    const prIntervals = getIntervalsAfterClick(prRequests, clickAt);
    const normalIntervals = getIntervalsAfterClick(normalRequests, clickAt);
    const lastPrObservedAt = maxTime([
        ...prRequests.map((req) => req.lastEventAt),
        ...prTargets.map((target) => target.attachAt),
        ...prTargets.map((target) => target.detachAt)
    ]);
    const lastPrIntervalEndAt = maxTime(prIntervals.map((item) => item.end));
    const normalStartAt = minTime(normalIntervals.map((item) => item.start));
    const normalEndAt = maxTime(normalIntervals.map((item) => item.end));
    const postClickBytes = prRequests.reduce((sum, req) => sum + (req.postClickBytes || 0), 0);
    const events = timeline.events.slice().sort((a, b) => (a.t || 0) - (b.t || 0));

    return {
        clickMs: relTime(trial, clickAt),
        firstPrAttachMs: relTime(trial, minTime(prTargets.map((target) => target.attachAt))),
        lastPrDetachMs: relTime(trial, maxTime(prTargets.map((target) => target.detachAt))),
        firstPrRequestMs: relTime(trial, minTime(prRequests.map((req) => req.requestAt))),
        lastPrEventMs: relTime(trial, lastPrObservedAt),
        lastPrEndMs: relTime(trial, maxTime(prRequests.map((req) => req.endAt))),
        postClickPrTailMs: isFiniteTime(clickAt) && isFiniteTime(lastPrIntervalEndAt) ? lastPrIntervalEndAt - clickAt : '',
        postClickPrActiveMs: isFiniteTime(clickAt) ? getUnionDuration(prIntervals) : '',
        postClickPrTransferKB: isFiniteTime(clickAt) ? (postClickBytes / 1024).toFixed(2) : '',
        openPrRequestCount: prRequests.filter((req) => req.requestAt && !req.endAt).length,
        normalNavStartMs: relTime(trial, normalStartAt),
        normalNavEndMs: relTime(trial, normalEndAt),
        prNormalOverlapMs: isFiniteTime(clickAt) ? getOverlapDuration(prIntervals, normalIntervals) : '',
        prEventCount: events.filter((evt) => evt.category === 'prerender').length,
        normalEventCount: events.filter((evt) => evt.category === 'normal').length,
        timelineJson: events.length > 0 ? JSON.stringify(events) : ''
    };
};

const toPrefailCsvFields = (trial) => {
    const summary = buildPrefailTimelineSummary(trial);
    return [
        summary.clickMs,
        summary.firstPrAttachMs,
        summary.lastPrDetachMs,
        summary.firstPrRequestMs,
        summary.lastPrEventMs,
        summary.lastPrEndMs,
        summary.postClickPrTailMs,
        summary.postClickPrActiveMs,
        summary.postClickPrTransferKB,
        summary.openPrRequestCount,
        summary.normalNavStartMs,
        summary.normalNavEndMs,
        summary.prNormalOverlapMs,
        summary.prEventCount,
        summary.normalEventCount,
        summary.timelineJson
    ];
};

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
        'PR_Attack_Timeline_JSON',
        ...PREFAIL_TIMELINE_HEADERS
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
        const getSessionType = () => (prerenderSessionIds.has(session.id()) ? 'prerender' : 'top-level');

        const handleRequestWillBeSent = (params) => {
            if (!currentTrial) return;
            const url = params.request?.url || '';
            const idx = forcedPrIndex !== null ? forcedPrIndex : findTargetIndex(url);
            if (idx === -1) return;
            const pr = currentTrial.prStates[idx];
            const now = Date.now();
            if (!pr.started) {
                pr.started = true;
                pr.startTime = now;
                pr.result = 'pending';
            }
            reqMap.set(params.requestId, idx);

            const timelineReq = ensureTimelineRequest(currentTrial, 'prRequests', {
                sessionId: session.id(),
                requestId: params.requestId,
                prIndex: idx,
                sessionType: getSessionType(),
                url,
                resourceType: params.type
            });
            if (timelineReq) {
                timelineReq.requestAt = timelineReq.requestAt || now;
                timelineReq.lastEventAt = now;
            }
            pushPrefailTimelineEvent(currentTrial, {
                timestamp: now,
                event: 'pr_request',
                category: 'prerender',
                sessionId: session.id(),
                requestId: params.requestId,
                prIndex: idx,
                sessionType: getSessionType(),
                url,
                resourceType: params.type
            });
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
            const now = Date.now();
            const url = params.response?.url || pr.url;
            const timelineReq = ensureTimelineRequest(currentTrial, 'prRequests', {
                sessionId: session.id(),
                requestId: params.requestId,
                prIndex: idx,
                sessionType: getSessionType(),
                url
            });
            if (timelineReq) {
                timelineReq.responseAt = timelineReq.responseAt || now;
                timelineReq.lastEventAt = now;
                timelineReq.httpStatus = params.response?.status || timelineReq.httpStatus;
            }
            pushPrefailTimelineEvent(currentTrial, {
                timestamp: now,
                event: 'pr_response',
                category: 'prerender',
                sessionId: session.id(),
                requestId: params.requestId,
                prIndex: idx,
                sessionType: getSessionType(),
                url,
                httpStatus: params.response?.status
            });
        };

        const handleDataReceived = (params) => {
            if (!currentTrial) return;
            const data = sessionIdToReqMap.get(session.id());
            if (!data) return;
            const idx = data.reqMap.get(params.requestId);
            if (idx === undefined) return;
            const pr = currentTrial.prStates[idx];
            pr.bytes += params.dataLength || 0;
            const now = Date.now();
            const timelineReq = getTimelineRequest(currentTrial, 'prRequests', session.id(), params.requestId);
            if (timelineReq) {
                const bytes = params.dataLength || 0;
                timelineReq.bytes += bytes;
                timelineReq.dataEvents += 1;
                timelineReq.lastDataAt = now;
                timelineReq.lastEventAt = now;
                if (currentTrial.clickedAt && now >= currentTrial.clickedAt) {
                    timelineReq.postClickBytes += bytes;
                }
                pushPrefailTimelineEvent(currentTrial, {
                    timestamp: now,
                    event: 'pr_data',
                    category: 'prerender',
                    sessionId: session.id(),
                    requestId: params.requestId,
                    prIndex: timelineReq.prIndex,
                    sessionType: timelineReq.sessionType,
                    url: timelineReq.url,
                    resourceType: timelineReq.resourceType,
                    bytes: timelineReq.bytes
                });
            }
        };

        const handleLoadingFinished = (params) => {
            if (!currentTrial) return;
            const data = sessionIdToReqMap.get(session.id());
            if (!data) return;
            const idx = data.reqMap.get(params.requestId);
            if (idx === undefined) return;
            const pr = currentTrial.prStates[idx];
            pr.bytes = Math.max(pr.bytes, params.encodedDataLength || 0);
            const now = Date.now();
            pr.endTime = now;
            pr.result = 'finished';
            const timelineReq = getTimelineRequest(currentTrial, 'prRequests', session.id(), params.requestId);
            if (timelineReq) {
                timelineReq.bytes = Math.max(timelineReq.bytes, params.encodedDataLength || 0);
                timelineReq.finishAt = now;
                timelineReq.endAt = now;
                timelineReq.lastEventAt = now;
                pushPrefailTimelineEvent(currentTrial, {
                    timestamp: now,
                    event: 'pr_finish',
                    category: 'prerender',
                    sessionId: session.id(),
                    requestId: params.requestId,
                    prIndex: timelineReq.prIndex,
                    sessionType: timelineReq.sessionType,
                    url: timelineReq.url,
                    resourceType: timelineReq.resourceType,
                    bytes: timelineReq.bytes,
                    canceled: false
                });
            }
        };

        const handleLoadingFailed = (params) => {
            if (!currentTrial) return;
            const data = sessionIdToReqMap.get(session.id());
            if (!data) return;
            const idx = data.reqMap.get(params.requestId);
            if (idx === undefined) return;
            const pr = currentTrial.prStates[idx];
            const now = Date.now();
            pr.endTime = now;
            pr.result = params.canceled ? 'canceled' : 'failed';
            pr.error = params.errorText || null;
            const timelineReq = getTimelineRequest(currentTrial, 'prRequests', session.id(), params.requestId);
            if (timelineReq) {
                timelineReq.failAt = now;
                timelineReq.endAt = now;
                timelineReq.lastEventAt = now;
                timelineReq.canceled = !!params.canceled;
                timelineReq.errorText = params.errorText || null;
                pushPrefailTimelineEvent(currentTrial, {
                    timestamp: now,
                    event: params.canceled ? 'pr_cancel' : 'pr_fail',
                    category: 'prerender',
                    sessionId: session.id(),
                    requestId: params.requestId,
                    prIndex: timelineReq.prIndex,
                    sessionType: timelineReq.sessionType,
                    url: timelineReq.url,
                    resourceType: timelineReq.resourceType,
                    bytes: timelineReq.bytes,
                    canceled: !!params.canceled,
                    errorText: params.errorText || null
                });
            }
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

    const attachNormalNavigationTimelineListeners = (session, trialRef) => {
        const sessionId = session.id();
        const isActiveTrial = () => currentTrial && currentTrial === trialRef && isFiniteTime(trialRef.clickedAt);

        const handleRequestWillBeSent = (params) => {
            if (!isActiveTrial()) return;
            const now = Date.now();
            if (now < trialRef.clickedAt) return;
            const url = params.request?.url || '';
            const req = ensureTimelineRequest(trialRef, 'normalRequests', {
                sessionId,
                requestId: params.requestId,
                sessionType: 'top-level',
                url,
                resourceType: params.type
            });
            if (!req) return;
            req.requestAt = req.requestAt || now;
            req.lastEventAt = now;
            pushPrefailTimelineEvent(trialRef, {
                timestamp: now,
                event: 'normal_request',
                category: 'normal',
                sessionId,
                requestId: params.requestId,
                sessionType: 'top-level',
                url,
                resourceType: params.type
            });
        };

        const handleResponseReceived = (params) => {
            if (!isActiveTrial()) return;
            const req = getTimelineRequest(trialRef, 'normalRequests', sessionId, params.requestId);
            if (!req) return;
            const now = Date.now();
            req.responseAt = req.responseAt || now;
            req.lastEventAt = now;
            req.httpStatus = params.response?.status || req.httpStatus;
            pushPrefailTimelineEvent(trialRef, {
                timestamp: now,
                event: 'normal_response',
                category: 'normal',
                sessionId,
                requestId: params.requestId,
                sessionType: 'top-level',
                url: params.response?.url || req.url,
                resourceType: req.resourceType,
                httpStatus: params.response?.status
            });
        };

        const handleDataReceived = (params) => {
            if (!isActiveTrial()) return;
            const req = getTimelineRequest(trialRef, 'normalRequests', sessionId, params.requestId);
            if (!req) return;
            const now = Date.now();
            const bytes = params.dataLength || 0;
            req.bytes += bytes;
            req.dataEvents += 1;
            req.lastDataAt = now;
            req.lastEventAt = now;
            pushPrefailTimelineEvent(trialRef, {
                timestamp: now,
                event: 'normal_data',
                category: 'normal',
                sessionId,
                requestId: params.requestId,
                sessionType: 'top-level',
                url: req.url,
                resourceType: req.resourceType,
                bytes: req.bytes
            });
        };

        const handleLoadingFinished = (params) => {
            if (!isActiveTrial()) return;
            const req = getTimelineRequest(trialRef, 'normalRequests', sessionId, params.requestId);
            if (!req) return;
            const now = Date.now();
            req.bytes = Math.max(req.bytes, params.encodedDataLength || 0);
            req.finishAt = now;
            req.endAt = now;
            req.lastEventAt = now;
            pushPrefailTimelineEvent(trialRef, {
                timestamp: now,
                event: 'normal_finish',
                category: 'normal',
                sessionId,
                requestId: params.requestId,
                sessionType: 'top-level',
                url: req.url,
                resourceType: req.resourceType,
                bytes: req.bytes,
                canceled: false
            });
        };

        const handleLoadingFailed = (params) => {
            if (!isActiveTrial()) return;
            const req = getTimelineRequest(trialRef, 'normalRequests', sessionId, params.requestId);
            if (!req) return;
            const now = Date.now();
            req.failAt = now;
            req.endAt = now;
            req.lastEventAt = now;
            req.canceled = !!params.canceled;
            req.errorText = params.errorText || null;
            pushPrefailTimelineEvent(trialRef, {
                timestamp: now,
                event: params.canceled ? 'normal_cancel' : 'normal_fail',
                category: 'normal',
                sessionId,
                requestId: params.requestId,
                sessionType: 'top-level',
                url: req.url,
                resourceType: req.resourceType,
                bytes: req.bytes,
                canceled: !!params.canceled,
                errorText: params.errorText || null
            });
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
        pushPrefailTimelineEvent(trialRef, {
            timestamp: monitor.explicitCancelIssuedAt,
            event: 'explicit_cancel_requested',
            category: 'prerender',
            url: ATTACK_URL_PREFIX,
            canceled: true
        });

        const stopTasks = Array.from(prerenderSessions.entries()).map(([sessionId, prSession]) =>
            prSession.send('Page.stopLoading').then(() => {
                pushPrefailTimelineEvent(trialRef, {
                    timestamp: Date.now(),
                    event: 'pr_stop_loading_requested',
                    category: 'prerender',
                    sessionId,
                    canceled: true
                });
            }).catch(() => { })
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
        if (currentTrial && currentTrial.prefailTimeline) {
            const now = Date.now();
            currentTrial.prefailTimeline.prerenderTargets.set(params.sessionId, {
                sessionId: params.sessionId,
                prIndex,
                targetUrl,
                attachAt: now,
                detachAt: null
            });
            pushPrefailTimelineEvent(currentTrial, {
                timestamp: now,
                event: 'pr_target_attach',
                category: 'prerender',
                sessionId: params.sessionId,
                prIndex,
                sessionType: 'prerender',
                url: targetUrl
            });
        }
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
        if (currentTrial && currentTrial.prefailTimeline) {
            const target = currentTrial.prefailTimeline.prerenderTargets.get(params.sessionId) || {
                sessionId: params.sessionId,
                prIndex: null,
                targetUrl: params.targetInfo?.url || '',
                attachAt: null,
                detachAt: null
            };
            target.detachAt = Date.now();
            currentTrial.prefailTimeline.prerenderTargets.set(params.sessionId, target);
            pushPrefailTimelineEvent(currentTrial, {
                timestamp: target.detachAt,
                event: 'pr_target_detach',
                category: 'prerender',
                sessionId: params.sessionId,
                prIndex: target.prIndex,
                sessionType: 'prerender',
                url: params.targetInfo?.url || target.targetUrl
            });
        }
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
                            ...Array(ATTACK_FIELD_COUNT - 1).fill(''),
                            ...Array(PREFAIL_FIELD_COUNT).fill('')
                        ];
                        fs.appendFileSync(OUTPUT_FILE, skipFields.map(toCsvValue).join(',') + '\n');
                    }
                    break;
                }

                const page = await browser.newPage();
                await page.setViewport({ width: 1280, height: 20000 });
                await applyThrottle(page);
                const prUrls = PR_TARGET_CANDIDATES.filter((u) => u !== target.url).slice(0, 2);
                // 追加ログはこの時点を原点にして相対 ms で出力する
                const trialStart = Date.now();
                currentTrial = {
                    trialStart,
                    prUrls,
                    prStates: prUrls.map((url) => createPrState(url)),
                    prStatus: prUrls.map((url) => createPrStatusState(url)),
                    clickedAt: null,
                    attackMonitor: createAttackMonitorState(),
                    prefailTimeline: createPrefailTimelineState()
                };

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
                const cleanupNormalTimeline = attachNormalNavigationTimelineListeners(session, currentTrial);

                const handlePreloadStatus = (params) => {
                    if (!currentTrial) return;
                    const url = params.key?.url || '';
                    const idx = findTargetIndex(url);
                    if (idx === -1) return;
                    const st = currentTrial.prStatus[idx];
                    const status = params.status || '';
                    const final = params.prerenderStatus || '';
                    pushPrefailTimelineEvent(currentTrial, {
                        timestamp: Date.now(),
                        event: 'pr_status',
                        category: 'prerender',
                        prIndex: idx,
                        url,
                        status,
                        prerenderStatus: final
                    });
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
                            currentTrial.prefailTimeline.clickAt = currentTrial.clickedAt;
                            pushPrefailTimelineEvent(currentTrial, {
                                timestamp: currentTrial.clickedAt,
                                event: 'click',
                                category: 'click',
                                url: target.url
                            });
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
                    const prefailFields = toPrefailCsvFields(currentTrial);

                    const csvLine = [
                        conditionName,
                        target.name,
                        i,
                        metrics.lcp.toFixed(2),
                        metrics.fcp.toFixed(2),
                        (metrics.size / 1024 / 1024).toFixed(2),
                        overall.status === 'success',
                        ...prFields,
                        ...attackFields,
                        ...prefailFields
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
                    const prefailFields = toPrefailCsvFields(currentTrial);

                    const errorFields = [
                        conditionName,
                        target.name,
                        i,
                        'TimeOut',
                        'TimeOut',
                        0,
                        false,
                        ...prFields,
                        ...attackFields,
                        ...prefailFields
                    ];
                    fs.appendFileSync(OUTPUT_FILE, errorFields.map(toCsvValue).join(',') + '\n');

                    if (SCENARIO === 'cancel_delay' && i === TIMELINE_TRIAL_NO) {
                        printTrialTimeline(currentTrial, i, target.name);
                    }
                } finally {
                    cleanupTopNetwork && cleanupTopNetwork();
                    cleanupNormalTimeline && cleanupNormalTimeline();
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
