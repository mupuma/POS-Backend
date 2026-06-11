#!/usr/bin/env node
/*
 * Stress / volume seeder.
 *
 * Bulk-inserts large numbers of rows DIRECTLY via the Sequelize models so you can
 * push tables (sales, sale_items, customers, products, audit_logs) to the point
 * where read paths (sales list, reports, ORDER BY ... filesort) start to strain.
 *
 * Everything it creates is tagged so it can be removed again with --clean.
 *
 * Usage:
 *   node scripts/stressSeed.js --sales=1000
 *   node scripts/stressSeed.js --sales=50000 --customers=2000 --products=200 --auditlogs=20000 --batch=1000
 *   node scripts/stressSeed.js --clean          # delete everything this seeder created
 *
 * Flags:
 *   --sales=N        number of sales (each with 1-5 line items)        default 1000
 *   --customers=N    number of customers to create/reuse               default ceil(sales/20)
 *   --products=N     number of stress products (with inventory)        default 50
 *   --auditlogs=N    number of audit_log rows                          default 0
 *   --batch=N        rows per insert batch                             default 1000
 *   --days=N         spread sale_date over the last N days             default 90
 *   --store=ID       store id to attach data to        (default: first store / auto-create)
 *   --user=ID        user id to attach sales to         (default: first user in that store)
 *   --clean          remove previously seeded stress data and exit
 *   --yes            skip the confirmation prompt
 */

require('dotenv').config();

const readline = require('readline');
const db = require('../models');
const { sale, saleitem, product, productinventory, customer, store, user, auditLog, sequelize } = db;

// Silence per-statement SQL logging; bulk inserts otherwise dump megabytes.
sequelize.options.logging = false;

// ---- tags so we can always find/remove what we created -------------------
const RUN_ID = Date.now().toString(36);
const RECEIPT_PREFIX = 'ST';            // sales.receipt_number LIKE 'ST%'
const PRODUCT_CODE_PREFIX = 'STP-';     // products.product_code  LIKE 'STP-%'
const CUSTOMER_TAG = '[stress]';        // customers.name LIKE '%[stress]%'
const SALE_NOTE_TAG = 'STRESS_TEST';    // sales.notes = 'STRESS_TEST'
const AUDIT_ACTION = 'stress.test';     // audit_logs.action = 'stress.test'

function parseArgs() {
    const out = {};
    for (const raw of process.argv.slice(2)) {
        const m = raw.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;
        out[m[1]] = m[2] === undefined ? true : m[2];
    }
    return out;
}

const args = parseArgs();
const num = (v, d) => (v === undefined ? d : Math.max(0, parseInt(v, 10) || 0));

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const money = (n) => Math.round(n * 100) / 100;

function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function getOrCreateStore() {
    if (args.store) {
        const s = await store.findByPk(parseInt(args.store, 10));
        if (!s) throw new Error(`--store=${args.store} not found`);
        return s;
    }
    let s = await store.findOne({ order: [['id', 'ASC']] });
    if (!s) s = await store.create({});
    return s;
}

async function getOrCreateUser(storeId) {
    if (args.user) {
        const u = await user.findByPk(parseInt(args.user, 10));
        if (!u) throw new Error(`--user=${args.user} not found`);
        return u;
    }
    let u = await user.findOne({ where: { store_id: storeId }, order: [['id', 'ASC']] });
    if (!u) u = await user.findOne({ order: [['id', 'ASC']] });
    if (!u) {
        // bcrypt hash of "password" — only used so seeded sales have a valid FK.
        const password_hash = '$2a$10$N9qo8uLOickgx2ZMRZoMy.MrkqkVjQ0Wrk0kQ7eQ6kq6kq6kq6kq';
        u = await user.create({
            username: `stress_user_${RUN_ID}`,
            password_hash,
            full_name: 'Stress Test User',
            role: 'cashier',
            is_active: true,
            store_id: storeId,
        });
    }
    return u;
}

async function ensureProducts(storeId, count) {
    const existing = await product.findAll({
        where: { product_code: { [db.Sequelize.Op.like]: `${PRODUCT_CODE_PREFIX}%` } },
        order: [['id', 'ASC']],
    });
    const products = [...existing];
    const toCreate = Math.max(0, count - existing.length);
    if (toCreate > 0) {
        const base = existing.length;
        const rows = [];
        for (let i = 0; i < toCreate; i++) {
            const n = base + i + 1;
            rows.push({
                name: `Stress Product ${n}`,
                description: 'Auto-generated stress test product',
                price: money(rand(5, 500) + Math.random()),
                cost: money(rand(1, 100)),
                product_class_code: `STPC-${RUN_ID}-${n}`,
                stock_quantity: 1_000_000,
                min_stock_level: 0,
                is_active: true,
                product_code: `${PRODUCT_CODE_PREFIX}${RUN_ID}-${n}`,
                formatted_product_code: `${PRODUCT_CODE_PREFIX}${RUN_ID}-${n}`,
            });
        }
        const created = await product.bulkCreate(rows);
        products.push(...created);
    }

    // Make sure each product has inventory with huge stock for this store.
    for (const p of products) {
        await productinventory.findOrCreate({
            where: { product_id: p.id, store_id: storeId },
            defaults: {
                product_id: p.id,
                store_id: storeId,
                stock_quantity: 1_000_000,
                min_stock_level: 0,
                is_active: true,
            },
        });
    }
    return products;
}

async function ensureCustomers(count) {
    if (count <= 0) return [];
    const existing = await customer.findAll({
        where: { name: { [db.Sequelize.Op.like]: `%${CUSTOMER_TAG}%` } },
        order: [['id', 'ASC']],
    });
    const customers = [...existing];
    const toCreate = Math.max(0, count - existing.length);
    if (toCreate > 0) {
        const base = existing.length;
        const rows = [];
        for (let i = 0; i < toCreate; i++) {
            const n = base + i + 1;
            rows.push({
                name: `Customer ${n} ${CUSTOMER_TAG}`,
                phone: `09${rand(10000000, 99999999)}`,
                lookup_status: 'resolved',
            });
        }
        const created = await customer.bulkCreate(rows);
        customers.push(...created);
    }
    return customers;
}

function buildSaleRow(seq, userId, customerId, products, daysBack) {
    const itemCount = rand(1, 5);
    const items = [];
    let totalIncl = 0;
    for (let i = 0; i < itemCount; i++) {
        const p = pick(products);
        const qty = rand(1, 3);
        const unit = Number(p.price);
        const lineIncl = money(unit * qty);
        totalIncl += lineIncl;
        items.push({ product_id: p.id, quantity: qty, unit_price: unit, total_price: lineIncl });
    }
    totalIncl = money(totalIncl);
    const subtotal = money(totalIncl / 1.16);     // tax-exclusive
    const tax = money(totalIncl - subtotal);
    const saleDate = new Date(Date.now() - rand(0, daysBack) * 86400000 - rand(0, 86399) * 1000);

    return {
        row: {
            receipt_number: `${RECEIPT_PREFIX}${RUN_ID}${seq}`,
            user_id: userId,
            customer_id: customerId,
            subtotal,
            discount_amount: 0,
            tax_amount: tax,
            total_amount: totalIncl,
            payment_method: pick(['cash', 'card', 'mobile_money']),
            amount_paid: totalIncl,
            change_amount: 0,
            sale_date: saleDate,
            notes: SALE_NOTE_TAG,
            zra_status: pick(['sent', 'sent', 'sent', 'pending', 'failed']),
            retry_count: 0,
            created_at: saleDate,
            updated_at: saleDate,
        },
        items,
    };
}

async function seedSales({ salesCount, batchSize, daysBack, userId, customers, products }) {
    let done = 0;
    let seq = 0;
    const t0 = Date.now();

    while (done < salesCount) {
        const thisBatch = Math.min(batchSize, salesCount - done);
        const saleRows = [];
        const itemsPerSale = [];

        for (let i = 0; i < thisBatch; i++) {
            seq++;
            const customerId = customers.length && Math.random() < 0.5 ? pick(customers).id : null;
            const { row, items } = buildSaleRow(seq, userId, customerId, products, daysBack);
            saleRows.push(row);
            itemsPerSale.push(items);
        }

        await sequelize.transaction(async (tx) => {
            const createdSales = await sale.bulkCreate(saleRows, { transaction: tx });
            const itemRows = [];
            createdSales.forEach((s, idx) => {
                for (const it of itemsPerSale[idx]) {
                    itemRows.push({
                        sale_id: s.id,
                        product_id: it.product_id,
                        quantity: it.quantity,
                        unit_price: it.unit_price,
                        total_price: it.total_price,
                    });
                }
            });
            await saleitem.bulkCreate(itemRows, { transaction: tx });
        });

        done += thisBatch;
        const rate = Math.round(done / ((Date.now() - t0) / 1000));
        process.stdout.write(`\r  sales: ${done}/${salesCount}  (${rate}/s)   `);
    }
    process.stdout.write('\n');
    return Date.now() - t0;
}

async function seedAuditLogs(count, batchSize, userId, storeId) {
    if (count <= 0) return 0;
    let done = 0;
    const t0 = Date.now();
    while (done < count) {
        const thisBatch = Math.min(batchSize, count - done);
        const rows = [];
        for (let i = 0; i < thisBatch; i++) {
            const when = new Date(Date.now() - rand(0, 90) * 86400000);
            rows.push({
                action: AUDIT_ACTION,
                entity_type: 'sale',
                outcome: pick(['success', 'success', 'failure']),
                actor_user_id: userId,
                actor_identifier: 'stress',
                store_id: storeId,
                details: { seq: done + i, note: 'stress test row' },
                occurred_at: when,
                created_at: when,
                updated_at: when,
            });
        }
        await auditLog.bulkCreate(rows);
        done += thisBatch;
        const rate = Math.round(done / ((Date.now() - t0) / 1000));
        process.stdout.write(`\r  audit_logs: ${done}/${count}  (${rate}/s)   `);
    }
    process.stdout.write('\n');
    return Date.now() - t0;
}

async function clean() {
    const Op = db.Sequelize.Op;
    console.log('Cleaning previously seeded stress data...');

    const seededSales = await sale.findAll({
        attributes: ['id'],
        where: { receipt_number: { [Op.like]: `${RECEIPT_PREFIX}%` }, notes: SALE_NOTE_TAG },
    });
    const saleIds = seededSales.map((s) => s.id);

    let items = 0;
    if (saleIds.length) {
        items = await saleitem.destroy({ where: { sale_id: { [Op.in]: saleIds } } });
    }
    const sales = await sale.destroy({ where: { notes: SALE_NOTE_TAG, receipt_number: { [Op.like]: `${RECEIPT_PREFIX}%` } } });

    const seededProducts = await product.findAll({
        attributes: ['id'],
        where: { product_code: { [Op.like]: `${PRODUCT_CODE_PREFIX}%` } },
    });
    const productIds = seededProducts.map((p) => p.id);
    let inv = 0;
    if (productIds.length) {
        inv = await productinventory.destroy({ where: { product_id: { [Op.in]: productIds } } });
    }
    const products = await product.destroy({ where: { product_code: { [Op.like]: `${PRODUCT_CODE_PREFIX}%` } } });
    const customers = await customer.destroy({ where: { name: { [Op.like]: `%${CUSTOMER_TAG}%` } } });
    const audits = await auditLog.destroy({ where: { action: AUDIT_ACTION } });

    console.log(`Removed: ${sales} sales, ${items} sale_items, ${products} products, ${inv} inventory rows, ${customers} customers, ${audits} audit_logs.`);
}

async function main() {
    await sequelize.authenticate();
    const dbName = sequelize.config.database;
    const dbHost = sequelize.config.host;

    if (args.clean) {
        console.log(`Target DB: ${dbName} @ ${dbHost}`);
        await clean();
        return;
    }

    const salesCount = num(args.sales, 1000);
    const productsCount = num(args.products, 50);
    const customersCount = args.customers !== undefined ? num(args.customers, 0) : Math.ceil(salesCount / 20);
    const auditCount = num(args.auditlogs, 0);
    const batchSize = Math.max(50, num(args.batch, 1000));
    const daysBack = Math.max(0, num(args.days, 90));

    console.log('Stress seeder');
    console.log('=============');
    console.log(`Target DB    : ${dbName} @ ${dbHost}`);
    console.log(`Sales        : ${salesCount}`);
    console.log(`Customers    : ${customersCount}`);
    console.log(`Products     : ${productsCount}`);
    console.log(`Audit logs   : ${auditCount}`);
    console.log(`Batch size   : ${batchSize}`);
    console.log(`Date spread  : last ${daysBack} days`);
    console.log('');

    if (!args.yes) {
        const a = (await ask(`This will INSERT real rows into "${dbName}". Continue? (yes/no) `)).trim().toLowerCase();
        if (a !== 'yes' && a !== 'y') {
            console.log('Aborted.');
            return;
        }
    }

    const s = await getOrCreateStore();
    const u = await getOrCreateUser(s.id);
    console.log(`Using store_id=${s.id}, user_id=${u.id}`);

    console.log('Ensuring products + inventory...');
    const products = await ensureProducts(s.id, productsCount);
    console.log(`  products available: ${products.length}`);

    console.log('Ensuring customers...');
    const customers = await ensureCustomers(customersCount);
    console.log(`  customers available: ${customers.length}`);

    console.log('Seeding sales...');
    const salesMs = await seedSales({ salesCount, batchSize, daysBack, userId: u.id, customers, products });

    let auditMs = 0;
    if (auditCount > 0) {
        console.log('Seeding audit logs...');
        auditMs = await seedAuditLogs(auditCount, batchSize, u.id, s.id);
    }

    const totalSales = await sale.count({ where: { notes: SALE_NOTE_TAG, receipt_number: { [db.Sequelize.Op.like]: `${RECEIPT_PREFIX}%` } } });

    console.log('');
    console.log('Done.');
    console.log(`  sales inserted this run : ${salesCount} in ${(salesMs / 1000).toFixed(1)}s`);
    if (auditCount > 0) console.log(`  audit logs this run     : ${auditCount} in ${(auditMs / 1000).toFixed(1)}s`);
    console.log(`  total stress sales in DB: ${totalSales}`);
    console.log('');
    console.log('Now stress the read path with:');
    console.log(`  node scripts/stressLoad.js --mode=salesList --requests=500 --concurrency=50 --user=<username> --pass=<password>`);
    console.log('Clean up later with:');
    console.log('  node scripts/stressSeed.js --clean');
}

main()
    .catch((err) => {
        console.error('\nSeeder error:', err.message);
        if (err.original) console.error('  SQL:', err.original.sqlMessage || err.original.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        try { await sequelize.close(); } catch (_) {}
    });
