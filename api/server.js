require('dotenv').config();
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const { exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");

const execAsync = promisify(exec);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../dashboard')));

// MariaDB connection pool (shared across all API pods)
const pool = mysql.createPool({
    host: process.env.DB_HOST || "mariadb-control-plane",
    port: process.env.DB_PORT || 3306,
    database: process.env.DB_NAME || "store_control_plane",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "rootpassword",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// Configuration
const CONFIG = {
    MAX_STORES_GLOBAL: 100,
    MAX_STORES_PER_TENANT: 10,
    MAX_STORES_PER_HOUR: 5,
    PROVISIONING_TIMEOUT_MS: 5 * 60 * 1000,
    READINESS_CHECK_INTERVAL_MS: 5000,
    MAX_READINESS_CHECKS: 60,
    IDEMPOTENCY_WINDOW_MS: 5 * 60 * 1000,
};

// Initialize database schema
async function initDatabase() {
    const connection = await pool.getConnection();
    try {
        await connection.query(`
            CREATE TABLE IF NOT EXISTS stores (
                id VARCHAR(255) PRIMARY KEY,
                tenant_id VARCHAR(255) NOT NULL,
                namespace VARCHAR(255) NOT NULL,
                host VARCHAR(255) NOT NULL UNIQUE,
                status VARCHAR(50) NOT NULL,
                failure_reason TEXT,
                created_at DATETIME(3) NOT NULL,
                provisioning_started_at DATETIME(3),
                ready_at DATETIME(3),
                deletion_started_at DATETIME(3),
                deleted_at DATETIME(3),
                INDEX idx_tenant_id (tenant_id),
                INDEX idx_status (status),
                INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS idempotency_keys (
                \`key\` VARCHAR(255) PRIMARY KEY,
                store_id VARCHAR(255) NOT NULL,
                created_at DATETIME(3) NOT NULL,
                INDEX idx_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS rate_limits (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id VARCHAR(255) NOT NULL,
                store_id VARCHAR(255) NOT NULL,
                created_at DATETIME(3) NOT NULL,
                INDEX idx_tenant_created (tenant_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        await connection.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tenant_id VARCHAR(255) NOT NULL,
                action VARCHAR(50) NOT NULL,
                resource_type VARCHAR(50) NOT NULL,
                resource_id VARCHAR(255) NOT NULL,
                status VARCHAR(50) NOT NULL,
                details TEXT,
                ip_address VARCHAR(45),
                created_at DATETIME(3) NOT NULL,
                INDEX idx_tenant_created (tenant_id, created_at),
                INDEX idx_resource (resource_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        console.log("Database schema initialized");
    } finally {
        connection.release();
    }
}

// Clean up old data
async function cleanupOldData() {
    try {
        const idempotencyCutoff = new Date(Date.now() - CONFIG.IDEMPOTENCY_WINDOW_MS);
        const rateLimitCutoff = new Date(Date.now() - 60 * 60 * 1000);

        await pool.execute(
            "DELETE FROM idempotency_keys WHERE created_at < ?",
            [idempotencyCutoff]
        );
        await pool.execute(
            "DELETE FROM rate_limits WHERE created_at < ?",
            [rateLimitCutoff]
        );
    } catch (error) {
        console.error("Cleanup error:", error);
    }
}

// Helper functions
function getTenantId(req) {
    return req.headers['x-tenant-id'] || req.headers['x-user-id'] || 'default';
}

function generateIdempotencyKey(req) {
    // If no key is provided, assume it's a new request and generate a random one
    return uuidv4();
}

async function logAudit(tenantId, action, resourceType, resourceId, status, details = {}, ip = null) {
    try {
        await pool.execute(
            `INSERT INTO audit_logs 
            (tenant_id, action, resource_type, resource_id, status, details, ip_address, created_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                tenantId,
                action,
                resourceType,
                resourceId,
                status,
                JSON.stringify(details),
                ip,
                new Date()
            ]
        );
    } catch (error) {
        console.error("Audit logging failed:", error);
    }
}

// Readiness checks (keep your existing functions)
async function checkPodReadiness(namespace) {
    try {
        const { stdout } = await execAsync(
            `kubectl get pods -n ${namespace} -o json`
        );
        const pods = JSON.parse(stdout);

        if (!pods.items || pods.items.length === 0) {
            return { ready: false, reason: "No pods found" };
        }

        const allReady = pods.items.every((pod) => {
            const conditions = pod.status.conditions || [];
            const readyCondition = conditions.find((c) => c.type === "Ready");
            return readyCondition && readyCondition.status === "True";
        });

        if (!allReady) {
            const notReadyPods = pods.items
                .filter((pod) => {
                    const conditions = pod.status.conditions || [];
                    const readyCondition = conditions.find((c) => c.type === "Ready");
                    return !readyCondition || readyCondition.status !== "True";
                })
                .map((pod) => pod.metadata.name);

            return {
                ready: false,
                reason: `Pods not ready: ${notReadyPods.join(", ")}`,
            };
        }

        return { ready: true, reason: null };
    } catch (error) {
        return { ready: false, reason: `Check failed: ${error.message}` };
    }
}

async function checkIngressReadiness(host) {
    try {
        const { stdout } = await execAsync(
            `kubectl get ingress --all-namespaces -o json`
        );
        const ingresses = JSON.parse(stdout);

        const matchingIngress = ingresses.items.find((ing) =>
            ing.spec.rules?.some((rule) => rule.host === host)
        );

        if (!matchingIngress) {
            return { ready: false, reason: "Ingress not found" };
        }

        const hasLoadBalancer =
            matchingIngress.status?.loadBalancer?.ingress?.length > 0;

        if (!hasLoadBalancer) {
            return { ready: false, reason: "Ingress has no load balancer IP" };
        }

        return { ready: true, reason: null };
    } catch (error) {
        return { ready: false, reason: `Ingress check failed: ${error.message}` };
    }
}

async function waitForStoreReadiness(storeId, namespace, host) {
    const startTime = Date.now();
    let attempts = 0;

    return new Promise((resolve) => {
        const checkInterval = setInterval(async () => {
            attempts++;

            if (Date.now() - startTime > CONFIG.PROVISIONING_TIMEOUT_MS) {
                clearInterval(checkInterval);
                resolve({
                    ready: false,
                    reason: "Provisioning timeout exceeded",
                });
                return;
            }

            if (attempts > CONFIG.MAX_READINESS_CHECKS) {
                clearInterval(checkInterval);
                resolve({
                    ready: false,
                    reason: "Maximum readiness checks exceeded",
                });
                return;
            }

            const podCheck = await checkPodReadiness(namespace);
            if (!podCheck.ready) {
                console.log(
                    `[${storeId}] Attempt ${attempts}: ${podCheck.reason}`
                );
                return;
            }

            const ingressCheck = await checkIngressReadiness(host);
            if (!ingressCheck.ready) {
                console.log(
                    `[${storeId}] Attempt ${attempts}: ${ingressCheck.reason}`
                );
                return;
            }

            clearInterval(checkInterval);
            resolve({ ready: true, reason: null });
        }, CONFIG.READINESS_CHECK_INTERVAL_MS);
    });
}

// Validation functions
async function validateRateLimit(tenantId) {
    try {
        // Check global limit
        const [globalResult] = await pool.execute(
            "SELECT COUNT(*) as count FROM stores WHERE status != 'Deleted'"
        );
        if (globalResult[0].count >= CONFIG.MAX_STORES_GLOBAL) {
            return {
                valid: false,
                error: `Global store limit (${CONFIG.MAX_STORES_GLOBAL}) reached`,
            };
        }

        // Check per-tenant limit
        const [tenantResult] = await pool.execute(
            "SELECT COUNT(*) as count FROM stores WHERE tenant_id = ? AND status != 'Deleted'",
            [tenantId]
        );
        if (tenantResult[0].count >= CONFIG.MAX_STORES_PER_TENANT) {
            return {
                valid: false,
                error: `Tenant store limit (${CONFIG.MAX_STORES_PER_TENANT}) reached`,
            };
        }

        // Check time-based rate limit
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const [rateResult] = await pool.execute(
            "SELECT COUNT(*) as count FROM rate_limits WHERE tenant_id = ? AND created_at > ?",
            [tenantId, oneHourAgo]
        );

        if (rateResult[0].count >= CONFIG.MAX_STORES_PER_HOUR) {
            const [oldestResult] = await pool.execute(
                "SELECT created_at FROM rate_limits WHERE tenant_id = ? AND created_at > ? ORDER BY created_at LIMIT 1",
                [tenantId, oneHourAgo]
            );
            const retryAfter = Math.ceil((oldestResult[0].created_at.getTime() + 60 * 60 * 1000 - Date.now()) / 1000);

            return {
                valid: false,
                error: `Rate limit exceeded: max ${CONFIG.MAX_STORES_PER_HOUR} stores per hour`,
                retryAfter,
            };
        }

        return { valid: true };
    } catch (error) {
        console.error("Rate limit validation error:", error);
        return { valid: false, error: "Internal error" };
    }
}

async function checkIdempotency(idempotencyKey) {
    const cutoff = new Date(Date.now() - CONFIG.IDEMPOTENCY_WINDOW_MS);
    const [rows] = await pool.execute(
        `SELECT i.store_id, s.* 
         FROM idempotency_keys i 
         JOIN stores s ON i.store_id = s.id 
         WHERE i.key = ? AND i.created_at > ?`,
        [idempotencyKey, cutoff]
    );

    if (rows.length === 0) {
        return { exists: false };
    }

    return {
        exists: true,
        storeId: rows[0].store_id,
        store: rows[0],
    };
}

// Create Store
app.post("/stores", async (req, res) => {
    const tenantId = getTenantId(req);
    const idempotencyKey = req.headers['idempotency-key'] || generateIdempotencyKey(req);

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        // Check idempotency
        const idempotencyCheck = await checkIdempotency(idempotencyKey);
        if (idempotencyCheck.exists) {
            await connection.commit();
            return res.json({
                ...idempotencyCheck.store,
                idempotent: true,
                message: "Store already exists (idempotent request)",
            });
        }

        // Validate rate limits
        const rateLimitCheck = await validateRateLimit(tenantId);
        if (!rateLimitCheck.valid) {
            await connection.commit();
            const response = { error: rateLimitCheck.error };
            if (rateLimitCheck.retryAfter) {
                res.set('Retry-After', rateLimitCheck.retryAfter);
                response.retryAfter = rateLimitCheck.retryAfter;
            }
            return res.status(429).json(response);
        }

        const storeId = `store-${uuidv4().slice(0, 8)}`;
        const namespace = storeId;
        const host = `${storeId}.127.0.0.1.nip.io`;
        const now = new Date();

        // Insert store
        await connection.execute(
            `INSERT INTO stores (id, tenant_id, namespace, host, status, created_at, provisioning_started_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [storeId, tenantId, namespace, host, 'Provisioning', now, now]
        );

        // Record idempotency key
        await connection.execute(
            "INSERT INTO idempotency_keys (`key`, store_id, created_at) VALUES (?, ?, ?)",
            [idempotencyKey, storeId, now]
        );

        // Record rate limit
        await connection.execute(
            "INSERT INTO rate_limits (tenant_id, store_id, created_at) VALUES (?, ?, ?)",
            [tenantId, storeId, now]
        );

        await connection.commit();

        const store = {
            id: storeId,
            tenant_id: tenantId,
            namespace,
            host,
            status: 'Provisioning',
            created_at: now.toISOString(),
            provisioning_started_at: now.toISOString(),
        };

        res.status(202).json(store);

        // Audit Log
        logAudit(tenantId, 'CREATE_STORE', 'STORE', storeId, 'INITIATED', { host, namespace }, req.ip);

        // Async provisioning
        (async () => {
            try {
                const chartPath = path.join(__dirname, "../charts/store");
                const command = `helm install ${storeId} "${chartPath}" --namespace ${namespace} --create-namespace --set ingress.host=${host}`;

                console.log(`[${storeId}] Starting Helm installation...`);
                const { stdout, stderr } = await execAsync(command);
                console.log(`[${storeId}] Helm install output:`, stdout);

                console.log(`[${storeId}] Waiting for readiness...`);
                const readinessResult = await waitForStoreReadiness(storeId, namespace, host);

                if (readinessResult.ready) {
                    await pool.execute(
                        "UPDATE stores SET status = ?, ready_at = ? WHERE id = ?",
                        ['Ready', new Date(), storeId]
                    );
                    console.log(`[${storeId}] Store is ready!`);
                } else {
                    await pool.execute(
                        "UPDATE stores SET status = ?, failure_reason = ? WHERE id = ?",
                        ['Failed', readinessResult.reason, storeId]
                    );
                    console.error(`[${storeId}] Failed: ${readinessResult.reason}`);
                }
            } catch (error) {
                await pool.execute(
                    "UPDATE stores SET status = ?, failure_reason = ? WHERE id = ?",
                    ['Failed', error.message, storeId]
                );
                console.error(`[${storeId}] Provisioning error:`, error.message);
            }
        })();

    } catch (error) {
        await connection.rollback();
        console.error("Store creation error:", error);
        res.status(500).json({ error: "Internal server error" });
    } finally {
        connection.release();
    }
});

// List Stores
app.get("/stores", async (req, res) => {
    const tenantId = getTenantId(req);

    try {
        const [rows] = await pool.execute(
            "SELECT * FROM stores WHERE tenant_id = ? AND status != 'Deleted' ORDER BY created_at DESC",
            [tenantId]
        );
        res.json(rows);
    } catch (error) {
        console.error("List stores error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Get Single Store
app.get("/stores/:id", async (req, res) => {
    const storeId = req.params.id;
    const tenantId = getTenantId(req);

    try {
        const [rows] = await pool.execute(
            "SELECT * FROM stores WHERE id = ? AND tenant_id = ?",
            [storeId, tenantId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ error: "Store not found" });
        }

        res.json(rows[0]);
    } catch (error) {
        console.error("Get store error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

// Delete Store
app.delete("/stores/:id", async (req, res) => {
    const storeId = req.params.id;
    const tenantId = getTenantId(req);

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            "SELECT * FROM stores WHERE id = ? AND tenant_id = ? FOR UPDATE",
            [storeId, tenantId]
        );

        if (rows.length === 0) {
            await connection.commit();
            return res.status(404).json({ error: "Store not found" });
        }

        const store = rows[0];

        if (store.status === 'Deleted') {
            await connection.commit();
            return res.json({ message: "Store already deleted", store });
        }

        if (store.status === 'Deleting') {
            await connection.commit();
            return res.json({ message: "Store deletion already in progress", store });
        }

        await connection.execute(
            "UPDATE stores SET status = ?, deletion_started_at = ? WHERE id = ?",
            ['Deleting', new Date(), storeId]
        );

        await connection.commit();

        res.json({ message: "Store deletion initiated", store: { ...store, status: 'Deleting' } });

        // Audit Log
        logAudit(tenantId, 'DELETE_STORE', 'STORE', storeId, 'INITIATED', {}, req.ip);

        // Async deletion
        (async () => {
            try {
                // Try helm uninstall, but ensure namespace is deleted regardless
                const command = `helm uninstall ${storeId} -n ${storeId} || true && kubectl delete namespace ${storeId} --wait=false`;
                const { stdout } = await execAsync(command);
                console.log(`[${storeId}] Deleted successfully:`, stdout);

                await pool.execute(
                    "UPDATE stores SET status = ?, deleted_at = ? WHERE id = ?",
                    ['Deleted', new Date(), storeId]
                );
            } catch (error) {
                await pool.execute(
                    "UPDATE stores SET status = ?, failure_reason = ? WHERE id = ?",
                    ['Failed', `Deletion failed: ${error.message}`, storeId]
                );
                console.error(`[${storeId}] Deletion error:`, error.message);
            }
        })();

    } catch (error) {
        await connection.rollback();
        console.error("Delete store error:", error);
        res.status(500).json({ error: "Internal server error" });
    } finally {
        connection.release();
    }
});

// Health check
app.get("/health", async (req, res) => {
    try {
        await pool.execute('SELECT 1');
        res.json({ status: "healthy", database: "connected" });
    } catch (error) {
        res.status(503).json({ status: "unhealthy", database: "disconnected" });
    }
});

// Initialize and start server
(async () => {
    await initDatabase();

    // Clean up old data every 5 minutes
    setInterval(cleanupOldData, 5 * 60 * 1000);

    app.listen(3000, () => {
        console.log("Provisioning API running on port 3000");
        console.log(`Max stores (global): ${CONFIG.MAX_STORES_GLOBAL}`);
        console.log(`Max stores (per tenant): ${CONFIG.MAX_STORES_PER_TENANT}`);
        console.log(`Max stores (per hour): ${CONFIG.MAX_STORES_PER_HOUR}`);
    });
})();