const API_URL = ''; // Relative path since we are serving from the API

const provisionBtn = document.getElementById('provision-btn');
const storesList = document.getElementById('stores-list');

// State
let stores = [];

// Format date
function formatDate(dateString) {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
}

// Get status class
function getStatusClass(status) {
    switch (status.toLowerCase()) {
        case 'ready': return 'status-ready';
        case 'provisioning': return 'status-provisioning';
        case 'failed': return 'status-failed';
        case 'deleting': return 'status-deleting';
        case 'deleted': return 'status-deleting';
        default: return 'status-provisioning';
    }
}

// Render Stores
function renderStores() {
    if (stores.length === 0) {
        storesList.innerHTML = '<div class="loading-state">No stores found. Provision one to get started.</div>';
        return;
    }

    storesList.innerHTML = stores.map(store => `
        <div class="store-card">
            <div class="store-header">
                <div>
                    <div class="store-id">${store.id}</div>
                    <a href="http://${store.host}" target="_blank" class="store-host">${store.host} ↗</a>
                </div>
                <span class="status-badge ${getStatusClass(store.status)}">${store.status}</span>
            </div>
            
            <div class="store-details">
                <div class="detail-row">
                    <span>Admin URL:</span>
                    <a href="http://${store.host}/wp-admin" target="_blank">/wp-admin</a>
                </div>
                <div class="detail-row">
                    <span>Credentials:</span>
                    <span title="Default credentials">admin / admin123</span>
                </div>
                <div class="detail-row">
                    <span>Created:</span>
                    <span>${formatDate(store.created_at)}</span>
                </div>
                ${store.ready_at ? `
                <div class="detail-row">
                    <span>Ready:</span>
                    <span>${formatDate(store.ready_at)}</span>
                </div>
                ` : ''}
                ${store.failure_reason ? `
                <div class="detail-row" style="color: var(--color-error)">
                    <span>Error:</span>
                    <span>${store.failure_reason}</span>
                </div>
                ` : ''}
            </div>

            <div class="store-actions">
                ${store.status === 'Ready' ? `
                    <a href="http://${store.host}/wp-admin" target="_blank" class="btn btn-primary" style="margin-right: 10px; text-decoration: none;">
                        Manage Store
                    </a>
                ` : ''}
                ${store.status !== 'Deleted' && store.status !== 'Deleting' ? `
                    <button class="btn btn-danger" onclick="deleteStore('${store.id}')">
                        Delete Store
                    </button>
                ` : ''}
            </div>
        </div>
    `).join('');
}

// Fetch Stores
async function fetchStores() {
    try {
        const res = await fetch(`${API_URL}/stores`);
        if (!res.ok) throw new Error('Failed to fetch stores');
        stores = await res.json();
        renderStores();
    } catch (error) {
        console.error(error);
        if (stores.length === 0) {
            storesList.innerHTML = `<div class="loading-state" style="color: var(--color-error)">Failed to load stores: ${error.message}</div>`;
        }
    }
}

// Provision Store
async function provisionStore() {
    try {
        provisionBtn.disabled = true;
        provisionBtn.textContent = 'Provisioning...';

        const res = await fetch(`${API_URL}/stores`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Idempotency-Key': crypto.randomUUID()
            },
            body: JSON.stringify({}) // Add extra options here if needed
        });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to provision store');
        }

        const newStore = await res.json();
        showToast(`Store ${newStore.id} provisioning started`);
        fetchStores(); // Refresh list immediately

    } catch (error) {
        console.error(error);
        showToast(error.message, true);
    } finally {
        provisionBtn.disabled = false;
        provisionBtn.textContent = 'Provision New Store';
    }
}

// Delete Store
async function deleteStore(storeId) {
    if (!confirm(`Are you sure you want to delete ${storeId}? This action cannot be undone.`)) {
        return;
    }

    try {
        const res = await fetch(`${API_URL}/stores/${storeId}`, {
            method: 'DELETE'
        });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || 'Failed to delete store');
        }

        showToast(`Store ${storeId} deletion started`);
        fetchStores();

    } catch (error) {
        console.error(error);
        showToast(error.message, true);
    }
}

// Toast Notification
function showToast(message, isError = false) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.style.backgroundColor = isError ? '#EF4444' : '#333';
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// Event Listeners
provisionBtn.addEventListener('click', provisionStore);

// Initial Load
fetchStores();

// Poll for updates every 5 seconds
setInterval(fetchStores, 5000);

// Global scope for onclick handlers
window.deleteStore = deleteStore;
