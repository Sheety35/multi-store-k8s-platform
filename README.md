# 🚀 Multi-Store Kubernetes Platform

A robust, Kubernetes-native platform for provisioning and orchestrating multiple e-commerce stores (WordPress + WooCommerce) with strong isolation, automation, and observability.

## ✨ Key Features

*   **One-Click Provisioning**: Instantly deploy a full E-Commerce stack (WordPress + MariaDB) using Helm.
*   **Automated Setup**: Automatically installs **WooCommerce** and **Storefront** theme upon provisioning.
*   **Strong Isolation**:
    *   **Namespace per Tenant**: Each store gets its own namespace.
    *   **Network Policies**: Blocks cross-namespace traffic for security.
    *   **Resource Quotas**: Limits CPU/RAM usage per store to prevent noisy neighbors.
*   **Security**:
    *   Generates **unique, secure credentials** for every store.
    *   RBAC-ready for in-cluster deployment.
*   **Observability**:
    *   **Audit Logging**: Tracks store creation, deletion, and product updates.
    *   **Webhooks**: Captures real-time events from WooCommerce (e.g., `product.created`).
*   **Environment Agnostic**: Ready for Local (Docker Desktop/Minikube) and Production (AWS/VPS) via Helm values.

---

## 🏗️ Architecture

1.  **Dashboard**: A lightweight UI (HTML/JS) for managing stores.
2.  **Orchestrator (API)**: Node.js service that talks to the Kubernetes API and Helm to manage resources.
3.  **Control Plane DB**: A shared MariaDB instance storing tenant metadata and audit logs.
4.  **Store Pods**: Isolated deployments of WordPress and MariaDB for each tenant.

---

## 🛠️ Prerequisites

*   **Node.js** (v18+)
*   **Docker Desktop** (with Kubernetes enabled) OR **Minikube** / **k3s**
*   **Helm** (v3+)
*   **kubectl**

---

## 🚀 Getting Started

### 1. Setup Control Plane Database
First, we need the database that stores the list of stores and audit logs.

```bash
# In the project root
cd charts/store
kubectl apply -f mariadb-control-plane.yaml
```
*Wait for the pod to be ready:*
```bash
kubectl get pods -w
```

### 2. Configure Local Environment
Ensure you have the API dependencies installed and configured.

```bash
cd ../../api
npm install
```

Create a `.env` file in `api/.env`:
```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=rootpassword
IN_CLUSTER=false
```

### 3. Start the Platform
You need to forward the database port so the local Node.js API can reach it.

**Terminal 1 (Port Forward):**
```bash
kubectl port-forward svc/mariadb-control-plane 3306:3306
```

**Terminal 2 (Start API):**
```bash
cd api
node server.js
```

### 4. Access the Dashboard
Open your browser to: **[http://localhost:3000](http://localhost:3000)**

---

## 🛒 Usage Guide

### Provisioning a Store
1.  Enter a name (e.g., `my-shop`) in the dashboard.
2.  Click **Provision**.
3.  Wait for the status to change to **Ready**.
4.  A unique URL will be generated (e.g., `my-shop-a1b2c.127.0.0.1.nip.io`).

### Managing the Store (Admin Panel)
1.  Click **Manage Store** on the dashboard card.
2.  Use the **Credentials** displayed on the card (e.g., `admin` / `x8z9...`).
3.  **WooCommerce** is already installed! Go to **Products > Add New** to start selling.

---

## 🏗️ System Design & Implementation

### Components
1.  **Orchestrator (Node.js)**:
    *   **Responsibilities**: Validates requests, enforces quotas, generates credentials, interacts with Kubernetes API/Helm.
    *   **Scalability**: Stateless; can be horizontally scaled behind a LoadBalancer.
2.  **Dashboard (Frontend)**:
    *   **Responsibilities**: User interface for provisioning and monitoring.
3.  **Control Plane Database (MariaDB)**:
    *   **Responsibilities**: Stores tenant metadata, audit logs, and rate limits.
4.  **Tenant Workloads**:
    *   **IsolationUnit**: 1 Namespace per Store.
    *   **Components**: WordPress Deployment, MariaDB StatefulSet, Services, Ingress, Secrets.

### End-to-End Flow
1.  **Create**: User clicks "Provision". orchestrator checks quota -> generates credentials -> creates Namespace -> Install Helm Chart.
2.  **Resources**: K8s creates Pods, PVCs, Services.
3.  **Startup**: WordPress pod starts -> Init Script runs -> Installs WooCommerce/Storefront -> Registers Webhook.
4.  **Ready**: API probes readiness -> Updates DB status -> Dashboard shows "Ready".
5.  **Usage**: User logs in -> Adds Product -> Webhook fires -> Orchestrator logs audit event.
6.  **Delete**: User clicks "Delete" -> Helm Uninstall -> Namespace Deletion -> DB status updated.

---

## 🔒 Isolation, Resources & Reliability

### Isolation Layers (Defense-in-Depth)
*   **Namespaces**: Logical isolation for every store.
*   **RBAC**: ServiceAccounts have scoped permissions.
*   **Network Policies**: Deny-all ingress by default; only allow necessary traffic (Ingress Controller -> WP).
*   **Secrets**: Database passwords are generated per-store and mounted as K8s Secrets.

### Quotas & Guardrails
*   **ResourceQuota**: Hard limit of **2 CPU / 4Gi RAM** per namespace.
*   **LimitRange**: Enforces default requests/limits for rogue pods.
*   **PVC Quota**: Limits storage consumption per tenant.

### Reliability
*   **Idempotency**: API generates unique IDs and deduplicates requests using `Idempotency-Key` header.
*   **Recovery**: If orchestration fails, the DB tracks "Failed" state. Retry logic creates/updates resources safely via Helm's idempotent design.
*   **Cleanup**: Robust deletion ensures all resources (including PVCs) are removed by deleting the entire Namespace.

---

## �️ Security Posture

*   **Secret Handling**: Passwords (DB, WP Admin) are cryptographically generated (random 16+ chars) and injected directly into K8s Secrets. Never stored in plain text in the repo.
*   **RBAC / Least Privilege**:
    *   The Provisioner ServiceAccount has specific permissions (create namespace, manage helm releases).
    *   Tenant pods run with restrictive SecurityContexts.
*   **Public vs Internal**:
    *   **Public**: Only port 80/443 via Ingress.
    *   **Internal**: Database ports (3306) are blocked from outside the cluster.

---

## ⚖️ Scalability & Performance

### Horizontal Scaling
*   **API/Dashboard**: Can run `N` replicas behind a Service.
*   **Orchestrator**: Stateless design allows multiple instances to handle provisioning requests concurrently.
*   **Provisioning Throughput**: Limited only by the K8s API server and underlying infrastructure capacity.

### State Handling
*   **Audit Logs**: Stored in a highly-available MariaDB (Control Plane).
*   **Tenant Data**: Persisted in PVCs (backed by cloud storage like EBS/GP2 in prod).

---

## 🚫 Abuse Prevention

*   **Rate Limiting**:
    *   **Per Tenant**: Max 10 stores.
    *   **Time-Based**: Max 5 stores per hour.
    *   **Global**: Hard cap of 100 stores platform-wide.
*   **Blast Radius**: ResourceQuotas ensure one tenant cannot starve the cluster.
*   **Audit Trail**: Every action (Create, Delete, Product Update) is logged with IP, timestamp, and metadata in `audit_logs`.

---

## 🌍 Local-to-VPS Production Story

We use **Helm** to manage environment differences seamlessly.

| Feature | Local (`values-local.yaml`) | Production (`values-prod.yaml`) |
| :--- | :--- | :--- |
| **Storage** | `local-path` (HostPath) | `gp2` / `do-block-storage` |
| **Ingress** | `nginx` (localhost/nip.io) | `nginx` + `cert-manager` (Let's Encrypt) |
| **Domain** | `*.127.0.0.1.nip.io` | `*.example.com` (Wildcard DNS) |
| **Database** | Lightweight settings | High-Availability / SSD Storage |

### Upgrade & Rollback
*   **Upgrade**: `helm upgrade <store-id> ./charts/store --set image.tag=v2`
*   **Rollback**: `helm rollback <store-id> <revision>`
*   **Strategy**: rolling updates ensure zero downtime for stores during platform upgrades.

### Deployment on VPS (e.g., K3s)
1.  **Install K3s**: `curl -sfL https://get.k3s.io | sh -`
2.  **Clone Repo**: `git clone ...`
3.  **Apply RBAC**: `kubectl apply -f infrastructure/provisioner-rbac.yaml`
4.  **Deploy Orchestrator**: `kubectl apply -f infrastructure/orchestrator-deployment.yaml`
5.  **Expose**: Use a LoadBalancer or NodePort for the dashboard.


*   **/api**: Node.js Orchestrator & API Server.
*   **/dashboard**: Frontend assets (served by API).
*   **/charts/store**: The Helm chart definition for a single store.
    *   `templates/plugin-install-cm.yaml`: Script for auto-installing plugins.
    *   `templates/network-policy.yaml`: Security rules.
    *   `templates/resource-quota.yaml`: Usage limits.
*   **/values**: Environment-specific configurations (`values-local.yaml`, `values-prod.yaml`).
*   **/infrastructure**: Manifests for deploying the orchestrator itself to K8s.

---

## 🛡️ Security & Scalability

*   **Network Isolation**: Stores cannot talk to each other or the control plane DB directly.
*   **Resource Limits**: Each store is capped at 2 CPU / 4Gi RAM (configurable).
*   **Secure Secrets**: Passwords are never hardcoded; they are generated dynamically and injected as K8s 