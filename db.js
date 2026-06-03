const idbLib = () => {
    if (!window.idb || !window.idb.openDB) {
        throw new Error('idb library is not available.');
    }
    return window.idb;
};

export const DB_NAME = 'shetiDiaryDB';
export const DB_VERSION = 1;
export const PENDING_STORE = 'pendingRecords';
export const DIESEL_STORE = 'diesel';
export let dbPromise = null;
let photoDbPromise = null;

export function isLocalFileOrigin() {
    return window.location.protocol === 'file:';
}

export async function initOfflineDB() {
    if (!('indexedDB' in window)) {
        console.warn('IndexedDB is not supported');
        return null;
    }

    try {
        dbPromise = idbLib().openDB(DB_NAME, DB_VERSION, {
            upgrade(db) {
                if (!db.objectStoreNames.contains(PENDING_STORE)) {
                    db.createObjectStore(PENDING_STORE, { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains(DIESEL_STORE)) {
                    db.createObjectStore(DIESEL_STORE, { keyPath: 'id' });
                }
            }
        });

        await dbPromise;
        return dbPromise;
    } catch (error) {
        console.warn('Offline DB initialization failed:', error);
        dbPromise = null;
        return null;
    }
}

export async function saveOfflineRecord(record) {
    if (!dbPromise) {
        throw new Error('Offline database is not initialized');
    }
    const db = await dbPromise;
    await db.put(PENDING_STORE, record);
    return record;
}

export async function loadPendingRecords() {
    if (!dbPromise) {
        await initOfflineDB();
        if (!dbPromise) return [];
    }
    const db = await dbPromise;
    return await db.getAll(PENDING_STORE) || [];
}

export async function deletePendingRecord(recordId) {
    if (!dbPromise) {
        await initOfflineDB();
        if (!dbPromise) return;
    }
    const db = await dbPromise;
    await db.delete(PENDING_STORE, recordId);
}

export async function openPhotoDB() {
    if (!('indexedDB' in window)) {
        throw new Error('IndexedDB is not supported in this browser.');
    }

    if (photoDbPromise) {
        return photoDbPromise;
    }

    photoDbPromise = idbLib().openDB('shetiDiaryPhotos', 1, {
        upgrade(db) {
            if (!db.objectStoreNames.contains('photos')) {
                db.createObjectStore('photos', { keyPath: 'id' });
            }
        }
    });

    return photoDbPromise;
}

export async function getPhotoHistory() {
    const db = await openPhotoDB();
    return (await db.getAll('photos') || []).sort((a, b) => b.id - a.id);
}

export async function savePhotoEntry(photoEntry) {
    const db = await openPhotoDB();
    await db.put('photos', photoEntry);
    return photoEntry;
}

export async function deletePhotoEntry(photoId) {
    const db = await openPhotoDB();
    await db.delete('photos', photoId);
}

export async function getDieselEntries() {
    if (!dbPromise) {
        await initOfflineDB();
        if (!dbPromise) return [];
    }
    const db = await dbPromise;
    return (await db.getAll(DIESEL_STORE) || []).sort((a, b) => b.id - a.id);
}

export async function saveDieselEntry(entry) {
    if (!dbPromise) {
        await initOfflineDB();
        if (!dbPromise) throw new Error('Offline database is not initialized');
    }
    const db = await dbPromise;
    await db.put(DIESEL_STORE, entry);
    return entry;
}

export async function deleteDieselEntryById(id) {
    if (!dbPromise) {
        await initOfflineDB();
        if (!dbPromise) return;
    }
    const db = await dbPromise;
    await db.delete(DIESEL_STORE, id);
}

export async function clearDieselEntries() {
    if (!dbPromise) {
        await initOfflineDB();
        if (!dbPromise) return;
    }
    const db = await dbPromise;
    await db.clear(DIESEL_STORE);
}
