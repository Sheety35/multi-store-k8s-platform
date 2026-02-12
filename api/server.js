const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { exec } = require("child_process");
const { promisify } = require("util");
const path = require("path");
const fs = require("fs").promises;

const execAsync = promisify(exec);
const app = express();
app.use(express.json());

// Configuration
const CONFIG = {
    STORE_REGISTRY_FILE: path.join(__dirname, "store-registry.json"),
    MAX_STORES: 100,
    PROVISIONING_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
    READINESS_CHECK_INTERVAL_MS: 5000, // 5 seconds
    MAX_READINESS_CHECKS: 60, // 5 minutes max
};

let stores = {};

// 3️⃣ Persistent store registry
async function loadStoreRegistry() {
    try {
        const data = await fs.readFile(CONFIG.STORE_REGISTRY_FILE, "utf8");
        stores = JSON.parse(data);
        console.log(`Loaded ${Object.keys(stores).length} stores from registry`);
    } catch (error) {
        if (error.code === "ENOENT") {
            console.log("No existing store registry found, starting fresh");
            stores = {};
        } else {
            console.error("Error loading store registry:", error);
            stores = {};
        }
    }
}

async function saveStoreRegistry() {
    try {
        await fs.writeFile(
            CONFIG.STORE_REGISTRY_FILE,
            JSON.stringify(stores, null, 2),
            "utf8"
        );
    } catch (error) {
        console.error("Error saving store registry:", error);
    }
}

// 1️⃣ Real readiness detection
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

            // 5️⃣ Provisioning timeout
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

// 6️⃣ Basic guardrails
function validateStoreCreation() {
    const activeStores = Object.values(stores).filter(
        (s) => s.status !== "Deleted" && s.status !== "Failed"
    );

    if (activeStores.length >= CONFIG.MAX_STORES) {
        return {
            valid: false,
            error: `Maximum store limit (${CONFIG.MAX_STORES}) reached`,
        };
    }

    return { valid: true };
}

// Create Store
app.post("/stores", async (req, res) => {
    // 6️⃣ Guardrails
    const validation = validateStoreCreation();
    if (!validation.valid) {
        return res.status(429).json({ error: validation.error });
    }

    const storeId = `store-${uuidv4().slice(0, 8)}`;
    const namespace = storeId;
    const host = `${storeId}.127.0.0.1.nip.io`;

    // 2️⃣ Idempotency - check if store with same characteristics exists
    const existingStore = Object.values(stores).find(
        (s) =>
            s.host === host &&
            (s.status === "Provisioning" || s.status === "Ready")
    );

    if (existingStore) {
        return res.json({
            ...existingStore,
            message: "Store already exists or is being provisioned",
        });
    }

    stores[storeId] = {
        id: storeId,
        namespace,
        host,
        status: "Provisioning",
        createdAt: new Date().toISOString(),
        failureReason: null, // 4️⃣ Failure reason tracking
        provisioningStartedAt: new Date().toISOString(),
    };

    await saveStoreRegistry(); // 3️⃣ Persist immediately

    res.json(stores[storeId]);

    // Async provisioning
    (async () => {
        try {
            const chartPath = path.join(__dirname, "../charts/store");
            const command = `helm install ${storeId} "${chartPath}" --namespace ${namespace} --create-namespace --set ingress.host=${host}`;

            console.log(`[${storeId}] Starting Helm installation...`);
            const { stdout, stderr } = await execAsync(command);

            console.log(`[${storeId}] Helm install output:`, stdout);
            if (stderr) console.log(`[${storeId}] Helm stderr:`, stderr);

            // 1️⃣ Wait for real readiness
            console.log(`[${storeId}] Waiting for readiness...`);
            const readinessResult = await waitForStoreReadiness(
                storeId,
                namespace,
                host
            );

            if (readinessResult.ready) {
                stores[storeId].status = "Ready";
                stores[storeId].readyAt = new Date().toISOString();
                console.log(`[${storeId}] Store is ready!`);
            } else {
                stores[storeId].status = "Failed";
                stores[storeId].failureReason = readinessResult.reason; // 4️⃣
                console.error(`[${storeId}] Failed: ${readinessResult.reason}`);
            }
        } catch (error) {
            stores[storeId].status = "Failed";
            stores[storeId].failureReason = error.message; // 4️⃣
            console.error(`[${storeId}] Provisioning error:`, error.message);
        } finally {
            await saveStoreRegistry(); // 3️⃣ Persist final state
        }
    })();
});

// List Stores
app.get("/stores", (req, res) => {
    res.json(Object.values(stores));
});

// Get Single Store
app.get("/stores/:id", (req, res) => {
    const storeId = req.params.id;

    if (!stores[storeId]) {
        return res.status(404).json({ error: "Store not found" });
    }

    res.json(stores[storeId]);
});

// Delete Store
app.delete("/stores/:id", async (req, res) => {
    const storeId = req.params.id;

    if (!stores[storeId]) {
        return res.status(404).json({ error: "Store not found" });
    }

    // 2️⃣ Idempotency - already deleted
    if (stores[storeId].status === "Deleted") {
        return res.json({
            message: "Store already deleted",
            store: stores[storeId],
        });
    }

    // 2️⃣ Idempotency - already deleting
    if (stores[storeId].status === "Deleting") {
        return res.json({
            message: "Store deletion already in progress",
            store: stores[storeId],
        });
    }

    stores[storeId].status = "Deleting";
    stores[storeId].deletionStartedAt = new Date().toISOString();
    await saveStoreRegistry(); // 3️⃣

    res.json({ message: "Store deletion initiated", store: stores[storeId] });

    // Async deletion
    (async () => {
        try {
            const command = `helm uninstall ${storeId} -n ${storeId} && kubectl delete namespace ${storeId}`;

            const { stdout, stderr } = await execAsync(command);
            console.log(`[${storeId}] Deleted successfully:`, stdout);
            if (stderr) console.log(`[${storeId}] Delete stderr:`, stderr);

            stores[storeId].status = "Deleted";
            stores[storeId].deletedAt = new Date().toISOString();
        } catch (error) {
            stores[storeId].status = "Failed";
            stores[storeId].failureReason = `Deletion failed: ${error.message}`; // 4️⃣
            console.error(`[${storeId}] Deletion error:`, error.message);
        } finally {
            await saveStoreRegistry(); // 3️⃣
        }
    })();
});

// Initialize and start server
(async () => {
    await loadStoreRegistry(); // 3️⃣ Load existing stores on startup

    app.listen(3000, () => {
        console.log("Provisioning API running on port 3000");
        console.log(`Max stores: ${CONFIG.MAX_STORES}`);
        console.log(
            `Provisioning timeout: ${CONFIG.PROVISIONING_TIMEOUT_MS / 1000}s`
        );
    });
})();