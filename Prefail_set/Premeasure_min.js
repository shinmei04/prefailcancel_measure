const puppeteer = require('puppeteer');
const fs = require('fs');

// README:
// 1. slow3g を適用
//    sudo ./tc_profiles.sh slow3g
//
// 2. 最小計測を実行
//    node Premeasure_min.js 10
//
// 3. 結果確認
//    cat raw_min.csv

const HOME_URL = 'https://home.lab-ish.com/index.html';
const MEDIUM_CLICK_SELECTOR = '#link-medium';
const WAIT_TIME = 2000;
const DEFAULT_TRIAL_COUNT = 100;
const OUTPUT_FILE = 'raw_min.csv';
const NAVIGATION_TIMEOUT_MS = 120000;
const LCP_WAIT_MS = 5000;

const parsePositiveInt = (raw) => {
    const value = Number.parseInt(raw || '', 10);
    return Number.isInteger(value) && value > 0 ? value : null;
};

const TRIAL_COUNT =
    parsePositiveInt(process.argv[2]) ||
    parsePositiveInt(process.env.TRIAL_COUNT) ||
    DEFAULT_TRIAL_COUNT;

const CSV_HEADERS = [
    'Trial_No',
    'LCP_ms',
    'FCP_ms',
    'Transfer_MB',
    'Navigation_Start_ms',
    'LoadEventEnd_ms',
    'DOMContentLoaded_ms',
    'ActivationStart_ms',
    'IsPrerendered',
    'Error'
];

const toCsvValue = (value) => {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return value;
    return `"${String(value).replace(/"/g, '""')}"`;
};

const appendCsvRow = (fields) => {
    fs.appendFileSync(OUTPUT_FILE, fields.map(toCsvValue).join(',') + '\n');
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createTrialPage = async (browser) => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setCacheEnabled(false);

    return { context, page };
};

const getPageMetrics = async (page) =>
    page.evaluate(async (lcpWaitMs) => {
        const getLCP = () =>
            new Promise((resolve) => {
                let latest = null;
                let observer = null;

                try {
                    observer = new PerformanceObserver((list) => {
                        const entries = list.getEntries();
                        latest = entries[entries.length - 1] || latest;
                    });
                    observer.observe({
                        type: 'largest-contentful-paint',
                        buffered: true
                    });
                } catch {
                    resolve(null);
                    return;
                }

                setTimeout(() => {
                    if (observer) observer.disconnect();
                    resolve(latest);
                }, lcpWaitMs);
            });

        const [nav] = performance.getEntriesByType('navigation');
        const [fcp] = performance.getEntriesByName('first-contentful-paint');
        const lcpEntry = await getLCP();
        const resources = performance.getEntriesByType('resource');
        const resourceTransferSize = resources.reduce((sum, item) => sum + item.transferSize, 0);
        const activationStart = nav ? nav.activationStart || 0 : 0;
        const lcp = lcpEntry ? lcpEntry.startTime : 0;
        const fcpTime = fcp ? fcp.startTime : 0;

        return {
            lcp: Math.max(0, lcp - activationStart),
            fcp: Math.max(0, fcpTime - activationStart),
            transferBytes: (nav ? nav.transferSize || 0 : 0) + resourceTransferSize,
            navigationStart: nav ? nav.startTime || 0 : 0,
            loadEventEnd: nav ? nav.loadEventEnd || 0 : 0,
            domContentLoaded: nav ? nav.domContentLoadedEventEnd || 0 : 0,
            activationStart,
            isPrerendered: activationStart > 0
        };
    }, LCP_WAIT_MS);

const createSuccessRow = (trialNo, metrics) => [
    trialNo,
    metrics.lcp.toFixed(2),
    metrics.fcp.toFixed(2),
    (metrics.transferBytes / 1024 / 1024).toFixed(2),
    metrics.navigationStart.toFixed(2),
    metrics.loadEventEnd.toFixed(2),
    metrics.domContentLoaded.toFixed(2),
    metrics.activationStart.toFixed(2),
    metrics.isPrerendered,
    ''
];

const createErrorRow = (trialNo, error) => [
    trialNo,
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    false,
    error.message || String(error)
];

(async () => {
    fs.writeFileSync(OUTPUT_FILE, `${CSV_HEADERS.join(',')}\n`);

    const browser = await puppeteer.launch({
        headless: 'new',
        ignoreHTTPSErrors: true,
        args: ['--ignore-certificate-errors']
    });

    const chromePath = browser.process() ? browser.process().spawnfile : 'unknown';
    const chromeVersion = await browser.version().catch(() => 'unknown');

    console.log(`Chrome path: ${chromePath}`);
    console.log(`Chrome version: ${chromeVersion}`);
    console.log(`Trials: ${TRIAL_COUNT}`);
    console.log(`Output: ${OUTPUT_FILE}`);

    try {
        for (let trialNo = 1; trialNo <= TRIAL_COUNT; trialNo++) {
            let context = null;
            let page = null;

            try {
                ({ context, page } = await createTrialPage(browser));

                await page.goto(HOME_URL, {
                    waitUntil: 'networkidle0',
                    timeout: NAVIGATION_TIMEOUT_MS
                });

                await wait(WAIT_TIME);

                await Promise.all([
                    page.waitForNavigation({
                        waitUntil: 'load',
                        timeout: NAVIGATION_TIMEOUT_MS
                    }),
                    page.click(MEDIUM_CLICK_SELECTOR)
                ]);

                const metrics = await getPageMetrics(page);
                appendCsvRow(createSuccessRow(trialNo, metrics));
                process.stdout.write('.');
            } catch (error) {
                appendCsvRow(createErrorRow(trialNo, error));
                console.error(`\n[Error] Trial ${trialNo}: ${error.message}`);
            } finally {
                if (page) await page.close().catch(() => { });
                if (context) await context.close().catch(() => { });
            }
        }
    } finally {
        await browser.close();
    }

    console.log('\nDone');
})();
