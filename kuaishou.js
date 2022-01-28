//@ts-check
const { chromium, errors } = require('playwright');
const { Client: PostgresClient } = require('pg');
const logger = require('pino')();
require('dotenv').config();

const RESTART_THRESHOLD = parseInt(process.env.RESTART_THRESHOLD, 10) || 60;
const PAGE_URL = process.env.PAGE_URL || 'https://www.kuaishou.com/short-video/3xss4pn476pxzze';

async function initDatabase() {
    const client = new PostgresClient({
        host: process.env.POSTGRES_HOST,
        user: process.env.POSTGRES_USER,
        password: process.env.POSTGRES_PASSWORD,
        database: process.env.POSTGRES_DATABASE,
    });
    await client.connect();
    logger.info('[Database] connected');
    return client;
}

async function launchBrowser() {
    const browser = await chromium.launch({
        headless: false,
        channel: 'msedge',
        args: ['--start-maximized']
    });
    const context = await browser.newContext({
        viewport: null,
    });
    const page = await context.newPage();

    context.on('page', page => {
        page.close();
    })
    page.once('close', () => {
        browser.close();
    });

    logger.info('[Browser] launched');

    return page;
}

function observeNetworkActivities(page, dbClient) {
    page.on('requestfinished', async (req) => {
        const res = await req.response();
        const { requestBodySize, requestHeadersSize, responseBodySize, responseHeadersSize } = await req.sizes();
        const { startTime, domainLookupStart, domainLookupEnd, connectStart, secureConnectionStart, connectEnd, requestStart, responseStart, responseEnd } = req.timing();

        await dbClient.query(`
            INSERT INTO ipv6.request (url, resource_type, request_headers_size, request_body_size, 
                response_headers_size, response_body_size, ip, start_time, domain_lookup_start, 
                domain_lookup_end, connect_start, secure_connection_start, connect_end, 
                request_start, response_start, response_end, environment, domain)
            VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8 / 1000.0), $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        `, [
            req.url(),
            req.resourceType(),
            requestHeadersSize,
            requestBodySize,
            responseHeadersSize,
            responseBodySize,
            (await res.serverAddr())?.ipAddress,
            startTime,
            domainLookupStart,
            domainLookupEnd,
            connectStart,
            secureConnectionStart,
            connectEnd,
            requestStart,
            responseStart,
            responseEnd,
            process.env.IPV6_ENVIRONMENT,
            new URL(req.url()).hostname,
        ]);
        logger.debug(`[Request] ${req.url()}`);
    });
}

async function runTest(page) {
    try {
        logger.info('[Refresh] start');
        await page.goto(PAGE_URL);
        logger.info('[Refresh] done');
        await page.waitForTimeout(1000 * 60 * RESTART_THRESHOLD);
    } catch (e) {
        // If the navigation is timeout, retry
        if (e instanceof errors.TimeoutError) {
            logger.warn('[Refresh] timeout');
            return;
        } else {
            throw e;
        }
    }
}

(async function loop() {
    const dbClient = await initDatabase();
    const page = await launchBrowser();

    observeNetworkActivities(page, dbClient);

    let testStartTime = +new Date();

    for (;;) {
        try {
            if (+new Date() - testStartTime > 1000 * 60 * RESTART_THRESHOLD) {
                throw new Error('[Test] threshold reached');
            }
            await runTest(page);
        } catch (e) {
            await page.context().browser().close().catch(() => { });
            await dbClient.end().catch(() => { });
            logger.info('[Test] restarting browser');
            setTimeout(loop, 0);
            break;
        }
    }
})();