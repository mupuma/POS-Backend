#!/usr/bin/env node
/*
 * HTTP concurrency load tester.
 *
 * Logs in once, then fires many concurrent requests at a chosen endpoint and
 * reports throughput, latency percentiles and error breakdown so you can find
 * the point where the running server starts to time out / error / fall over.
 *
 * Requires the backend to be running (npm run dev) and Node 18+ (global fetch).
 *
 * Usage:
 *   node scripts/stressLoad.js --user=admin --pass=secret --mode=salesList --requests=500 --concurrency=50
 *   node scripts/stressLoad.js --user=admin --pass=secret --mode=report --requests=200 --concurrency=20
 *   node scripts/stressLoad.js --user=admin --pass=secret --mode=createSale --requests=300 --concurrency=20 --productId=12
 *
 * Modes (read path = best for finding query/sort breaking points):
 *   salesList   GET  /sales?page&limit                 (ORDER BY sale_date filesort)
 *   report      GET  /reports/sales?startDate&endDate
 *   dashboard   GET  /reports/dashboard
 *   products    GET  /products
 *   createSale  POST /sales   (writes; also hits ZRA per request)
 *
 * Flags:
 *   --base=URL         API base               default http://127.0.0.1:3000/api
 *   --user=NAME        login username         (required)
 *   --pass=PASS        login password         (required)
 *   --mode=MODE        see list above         default salesList
 *   --requests=N       total requests         default 500
 *   --concurrency=N    in-flight at once      default 50
 *   --limit=N          page size (list modes) default 20
 *   --timeout=MS       per-request timeout    default 30000
 *   --productId=ID     product to sell        (createSale; else auto-picked)
 *   --ramp             run a 1x/2x/4x/8x concurrency ramp and report each step
 */

const args = (() => {
    const out = {};
    for (const raw of process.argv.slice(2)) {
        const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
        if (m) out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
})();

const BASE = (args.base || 'http://127.0.0.1:3000/api').replace(/\/$/, '');
const MODE = args.mode || 'salesList';
const TIMEOUT = parseInt(args.timeout, 10) || 30000;
const LIMIT = parseInt(args.limit, 10) || 20;

function pct(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}

async function timedFetch(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    const start = performance.now();
    try {
        const res = await fetch(url, { ...opts, signal: ctrl.signal });
        // Drain the body so the socket can be reused and timing is realistic.
        await res.text();
        return { ok: res.ok, status: res.status, ms: performance.now() - start };
    } catch (e) {
        return { ok: false, status: e.name === 'AbortError' ? 'timeout' : 'neterr', ms: performance.now() - start };
    } finally {
        clearTimeout(timer);
    }
}

async function login() {
    if (!args.user || !args.pass) throw new Error('--user and --pass are required');
    const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: args.user, password: args.pass }),
    });
    if (!res.ok) throw new Error(`Login failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    return { token: data.token, user: data.user };
}

async function pickProduct(headers) {
    if (args.productId) return parseInt(args.productId, 10);
    const res = await fetch(`${BASE}/products?limit=50`, { headers });
    if (!res.ok) throw new Error('Could not fetch products to auto-pick one; pass --productId');
    const data = await res.json();
    const list = data.products || data.data || data.items || (Array.isArray(data) ? data : []);
    const found = list.find((p) => p && (p.id != null));
    if (!found) throw new Error('No products available; pass --productId');
    return found.id;
}

function buildRequest(ctx, i) {
    const headers = { Authorization: `Bearer ${ctx.token}` };
    switch (MODE) {
        case 'salesList': {
            const page = 1 + (i % 25);
            return { url: `${BASE}/sales?page=${page}&limit=${LIMIT}`, opts: { headers } };
        }
        case 'report': {
            const end = new Date();
            const start = new Date(Date.now() - 90 * 86400000);
            const fmt = (d) => d.toISOString().slice(0, 10);
            return { url: `${BASE}/reports/sales?startDate=${fmt(start)}&endDate=${fmt(end)}`, opts: { headers } };
        }
        case 'dashboard':
            return { url: `${BASE}/reports/dashboard`, opts: { headers } };
        case 'products':
            return { url: `${BASE}/products?page=${1 + (i % 10)}&limit=${LIMIT}`, opts: { headers } };
        case 'createSale': {
            const body = {
                items: [{ product_id: ctx.productId, quantity: 1 }],
                payment_method: 'cash',
                amount_paid: 100000,
                tax_rate: 16,
                notes: 'STRESS_LOAD',
            };
            return {
                url: `${BASE}/sales`,
                opts: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
            };
        }
        default:
            throw new Error(`Unknown --mode=${MODE}`);
    }
}

async function runWave(ctx, totalRequests, concurrency) {
    const latencies = [];
    const statuses = {};
    let dispatched = 0;
    let completed = 0;
    const t0 = performance.now();

    async function worker() {
        while (true) {
            const i = dispatched++;
            if (i >= totalRequests) return;
            const { url, opts } = buildRequest(ctx, i);
            const r = await timedFetch(url, opts);
            latencies.push(r.ms);
            statuses[r.status] = (statuses[r.status] || 0) + 1;
            completed++;
            if (completed % 50 === 0 || completed === totalRequests) {
                process.stdout.write(`\r  ${completed}/${totalRequests} done   `);
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, totalRequests) }, worker));
    process.stdout.write('\n');

    const wall = (performance.now() - t0) / 1000;
    const sorted = [...latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    const ok = Object.entries(statuses)
        .filter(([k]) => k >= '200' && k < '400')
        .reduce((s, [, v]) => s + v, 0);

    return {
        concurrency,
        totalRequests,
        wall,
        throughput: totalRequests / wall,
        ok,
        errors: totalRequests - ok,
        statuses,
        avg: sum / (sorted.length || 1),
        min: sorted[0] || 0,
        p50: pct(sorted, 50),
        p90: pct(sorted, 90),
        p95: pct(sorted, 95),
        p99: pct(sorted, 99),
        max: sorted[sorted.length - 1] || 0,
    };
}

function printResult(r) {
    console.log('');
    console.log(`  concurrency      : ${r.concurrency}`);
    console.log(`  requests         : ${r.totalRequests}`);
    console.log(`  wall time        : ${r.wall.toFixed(2)}s`);
    console.log(`  throughput       : ${r.throughput.toFixed(1)} req/s`);
    console.log(`  success / errors : ${r.ok} / ${r.errors}`);
    console.log(`  status codes     : ${JSON.stringify(r.statuses)}`);
    console.log(`  latency ms       : min=${r.min.toFixed(0)} avg=${r.avg.toFixed(0)} p50=${r.p50.toFixed(0)} p90=${r.p90.toFixed(0)} p95=${r.p95.toFixed(0)} p99=${r.p99.toFixed(0)} max=${r.max.toFixed(0)}`);
}

async function main() {
    const totalRequests = parseInt(args.requests, 10) || 500;
    const concurrency = parseInt(args.concurrency, 10) || 50;

    console.log('HTTP load tester');
    console.log('================');
    console.log(`Base      : ${BASE}`);
    console.log(`Mode      : ${MODE}`);
    console.log(`Requests  : ${totalRequests}  Concurrency: ${concurrency}  Timeout: ${TIMEOUT}ms`);

    const { token, user } = await login();
    console.log(`Logged in as ${user?.username} (store_id=${user?.store_id})`);

    const ctx = { token };
    if (MODE === 'createSale') {
        ctx.productId = await pickProduct({ Authorization: `Bearer ${token}` });
        console.log(`createSale will sell product_id=${ctx.productId}`);
        console.log('NOTE: each createSale also calls the ZRA VSDC endpoint synchronously.');
    }

    if (args.ramp) {
        const steps = [concurrency, concurrency * 2, concurrency * 4, concurrency * 8];
        const summary = [];
        for (const c of steps) {
            console.log(`\n--- ramp step: concurrency=${c} ---`);
            const r = await runWave(ctx, totalRequests, c);
            printResult(r);
            summary.push(r);
        }
        console.log('\nRamp summary (concurrency -> throughput req/s, p99 ms, errors):');
        for (const r of summary) {
            console.log(`  ${String(r.concurrency).padStart(4)} -> ${r.throughput.toFixed(1).padStart(7)} req/s   p99=${r.p99.toFixed(0).padStart(6)}ms   errors=${r.errors}`);
        }
    } else {
        const r = await runWave(ctx, totalRequests, concurrency);
        printResult(r);
    }
}

main().catch((err) => {
    console.error('\nLoad tester error:', err.message);
    process.exitCode = 1;
});
