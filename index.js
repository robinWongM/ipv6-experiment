//@ts-check
const { chromium } = require('playwright');
const { Client: PostgresClient } = require('pg');
const logger = require('pino')();
require('dotenv').config();

const REFRESH_THRESHOLD = 233;
const PAGE_URL = 'https://www.weibo.com/hot/';

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
        storageState: './weibo.json',
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
    const height = await page.evaluate('window.innerHeight');

    while (true) {
        try {
            logger.info('[Refresh] start');
            await page.goto(PAGE_URL);
            logger.info('[Refresh] done');
        } catch (e) {
            // If the navigation is timeout, retry
            logger.warn('[Refresh] timeout');
            continue;
        }
        
        for (let i = 0; i < REFRESH_THRESHOLD; i++) {
            const images = page.locator(`.woo-picture-slot:visible:below([role="navigation"], ${height})`);
            const firstImage = images.first();

            await firstImage.click({
                timeout: 500,
            })
            .then(() => page.waitForSelector('svg[class^="CircleProgress"]', {
                state: 'attached',
                timeout: 1000,
            }))
            .then(() => page.waitForSelector('svg[class^="CircleProgress"]', {
                state: 'detached',
                timeout: 30000,
            }))
            .then(() => page.waitForTimeout(1000))
            .then(() => logger.info(`[ClickImage] ${i}/${REFRESH_THRESHOLD} clicked`))
            .catch(() => logger.info(`[ClickImage] ${i}/${REFRESH_THRESHOLD} timeout`));

            await page.keyboard.press('Escape');

            await page.waitForTimeout(500);

            await page.keyboard.press("PageDown");

            await page.waitForTimeout(1000);

            logger.info(`[Scrolling] ${i}/${REFRESH_THRESHOLD} done`);
        }
    }
}

(async () => {
    const dbClient = await initDatabase();
    const page = await launchBrowser();

    observeNetworkActivities(page, dbClient);

    await runTest(page);
})();