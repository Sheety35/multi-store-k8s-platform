const express = require("express");
const { v4: uuidv4 } = require("uuid");
const { exec } = require("child_process");
const path = require("path");

const app = express();
app.use(express.json());

const stores = {};

// Create Store
app.post("/stores", async (req, res) => {
    const storeId = `store-${uuidv4().slice(0, 8)}`;
    const namespace = storeId;
    const host = `${storeId}.127.0.0.1.nip.io`;

    stores[storeId] = {
        id: storeId,
        namespace,
        host,
        status: "Provisioning",
        createdAt: new Date().toISOString(),
    };

    const chartPath = path.join(__dirname, "../charts/store");
    const command = `helm install ${storeId} "${chartPath}" --namespace ${namespace} --create-namespace --set ingress.host=${host}`;

    exec(command, (error, stdout, stderr) => {
        if (error) {
            stores[storeId].status = "Failed";
            console.error("Helm Error:", error.message);
            console.error("STDERR:", stderr);
            console.log("STDOUT:", stdout);
            return;
        }

        stores[storeId].status = "Ready";
        console.log(`Store ${storeId} installed successfully:\n`, stdout);
    });

    res.json(stores[storeId]);
});

// List Stores
app.get("/stores", (req, res) => {
    res.json(Object.values(stores));
});

// Delete Store
app.delete("/stores/:id", (req, res) => {
    const storeId = req.params.id;

    if (!stores[storeId]) {
        return res.status(404).json({ error: "Store not found" });
    }

    stores[storeId].status = "Deleting";

    const command = `helm uninstall ${storeId} -n ${storeId} && kubectl delete namespace ${storeId}`;

    exec(command, (error, stdout, stderr) => {
        if (error) {
            stores[storeId].status = "Failed";
            console.error("Delete Error:", stderr);
            return res.status(500).json({ error: "Deletion failed" });
        }

        stores[storeId].status = "Deleted";
        console.log(`Store ${storeId} deleted successfully:\n`, stdout);
        return res.json({ message: "Store deleted successfully" });
    });
});


app.listen(3000, () => {
    console.log("Provisioning API running on port 3000");
});
