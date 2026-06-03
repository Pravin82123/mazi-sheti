import { initOfflineDB, saveOfflineRecord, loadPendingRecords, deletePendingRecord, getDieselEntries, saveDieselEntry, deleteDieselEntryById, clearDieselEntries, getPhotoHistory, savePhotoEntry, deletePhotoEntry, isLocalFileOrigin } from './db.js';
import { sendRecordToServer, syncRecordWithRetry, fetchSheetRecords, deleteRecordFromServer, getFriendlyNetworkMessage, isSuccessfulResponse } from './api.js';
import { ocrExtractedData, createImageFromFile, compressImage, compressImageFallback, openCamera, handleOCRImage, initCropper, rotateCropImage, resetCropImage, confirmCrop, skipCropping, processOCRImage, processOCRWithCroppedImage, extractAmountsFromText, displayOCRResults, autoFillFromOCR, extractProductName, clearOCRResults, initializeTesseractWorker } from './ocr.js';

window.ocrExtractedData = ocrExtractedData;
window.autoFillFromOCR = autoFillFromOCR;

const IMAGE_QUALITY = 0.75;
const PDF_PAGE_MARGIN = 10;
const PENDING_SYNC_INTERVAL_MS = 30000;

const DYNAMIC_LIBS = {
    jsPDF: {
        url: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
        fallback: './libs/jspdf.umd.min.js',
        global: 'jspdf'
    },
    html2canvas: {
        url: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
        fallback: './libs/html2canvas.min.js',
        global: 'html2canvas'
    },
    tesseract: {
        url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js',
        fallback: './libs/tesseract.min.js',
        global: 'Tesseract'
    },
    compressor: {
        url: 'https://cdnjs.cloudflare.com/ajax/libs/compressorjs/1.1.1/compressor.min.js',
        fallback: null,
        global: 'Compressor'
    }
};

const appState = {
    lists: { seed: [], fert: [], med: [], work: [], labour: [], income: [] },
    records: [],
    editingRecordId: null,
    expenseChartInstance: null,
    profitChartInstance: null,
    pendingRecords: [],
    photoHistory: [],
    dieselEntries: [],
    deferredInstallPrompt: null,
    pagination: {
        currentPage: 1,
        itemsPerPage: 30,
        currentFilter: ''
    }
};

// State management helpers
function setState(updates) {
    Object.assign(appState, updates);
}

function getState() {
    return appState;
}

/**
 * Centralized state update dispatcher
 * @param {string} action - Action type (e.g., 'SET_RECORDS', 'ADD_PENDING_RECORD', 'UPDATE_PAGINATION')
 * @param {any} payload - Data for the action
 */
function updateRecordState(action, payload) {
    try {
        switch (action) {
            case 'SET_RECORDS':
                appState.records = payload;
                renderHistory();
                renderCharts();
                generateInsights();
                break;
                
            case 'ADD_RECORD':
                appState.records.push(payload);
                renderHistory();
                renderCharts();
                generateInsights();
                break;
                
            case 'DELETE_RECORD':
                appState.records = appState.records.filter(r => r.id !== payload);
                renderHistory();
                renderCharts();
                generateInsights();
                break;
                
            case 'UPDATE_RECORD':
                const index = appState.records.findIndex(r => r.id === payload.id);
                if (index !== -1) {
                    appState.records[index] = payload;
                    renderHistory();
                    renderCharts();
                    generateInsights();
                }
                    else {
                        console.warn('UPDATE_RECORD failed: record id not found', payload.id);
                    }
                break;
                
            case 'SET_PENDING_RECORDS':
                appState.pendingRecords = payload;
                updateNetworkStatus();
                break;
                
            case 'ADD_PENDING_RECORD':
                appState.pendingRecords.push(payload);
                updateNetworkStatus();
                break;
                
            case 'DELETE_PENDING_RECORD':
                appState.pendingRecords = appState.pendingRecords.filter(r => r.id !== payload);
                updateNetworkStatus();
                break;
                
            case 'SET_PHOTO_HISTORY':
                appState.photoHistory = payload;
                break;
                
            case 'ADD_PHOTO_ENTRY':
                appState.photoHistory.push(payload);
                break;
                
            case 'DELETE_PHOTO_ENTRY':
                appState.photoHistory = appState.photoHistory.filter(p => p.id !== payload);
                break;
                
            case 'SET_DIESEL_ENTRIES':
                appState.dieselEntries = payload;
                break;
                
            case 'ADD_DIESEL_ENTRY':
                appState.dieselEntries.push(payload);
                break;
                
            case 'DELETE_DIESEL_ENTRY':
                appState.dieselEntries = appState.dieselEntries.filter(d => d.id !== payload);
                break;
                
            case 'UPDATE_PAGINATION':
                Object.assign(appState.pagination, payload);
                break;
                
            case 'SET_EDITING_RECORD':
                appState.editingRecordId = payload;
                break;
                
            case 'SET_LISTS':
                appState.lists = payload;
                break;
                
            case 'SET_CHART_INSTANCES':
                if (payload.expenseChart) appState.expenseChartInstance = payload.expenseChart;
                if (payload.profitChart) appState.profitChartInstance = payload.profitChart;
                break;
                
            default:
                console.warn('Unknown state action:', action);
        }
    } catch (error) {
        console.error('State update error:', action, payload, error);
        Swal.fire('स्थिति अपडेट त्रुटी', 'अपडेट प्रक्रियेमध्ये त्रुटी: ' + (error.message || error), 'error');
    }
}

// Convenience getters for accessing state
function getRecords() {
    return appState.records;
}

function getPendingRecords() {
    return appState.pendingRecords;
}

function getPaginationState() {
    return appState.pagination;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

function loadScriptElement(src, defer = true) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.defer = defer;
        script.crossOrigin = 'anonymous';
        script.onload = () => resolve(script);
        script.onerror = () => reject(new Error(`स्क्रिप्ट लोड करण्यात अयश: ${src}`));
        document.head.appendChild(script);
    });
}

async function loadExternalLibrary(libName) {
    const lib = DYNAMIC_LIBS[libName];
    if (!lib) {
        throw new Error(`अपरिचित लायब्ररी: ${libName}`);
    }
    if (window[lib.global]) {
        return window[lib.global];
    }
    try {
        await loadScriptElement(lib.url);
    } catch (error) {
        if (!lib.fallback || typeof lib.fallback !== 'string') {
            throw new Error(`CDN लोड अयशस्वी ${libName} आणि स्थानिक फॉलबॅक उपलब्ध नाही: ${error.message}`);
        }
        console.warn(`CDN लोड अयशस्वी ${libName}, स्थानिक फॉलबॅक वापरत आहे:`, error);
        await loadScriptElement(lib.fallback);
    }
    if (!window[lib.global]) {
        throw new Error(`${libName} लायब्ररी अद्याप उपलब्ध नाही: ${lib.global}`);
    }
    return window[lib.global];
}

async function ensurePdfLibs() {
    await loadExternalLibrary('jsPDF');
    await loadExternalLibrary('html2canvas');
}

async function ensureTesseractLib() {
    await loadExternalLibrary('tesseract');
}

async function ensureCompressorLib() {
    await loadExternalLibrary('compressor');
}

function escapeHTML(str) {
    if (!str) return '';
    const map = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
    return str.replace(/[&<>"']/g, tag => map[tag]);
}

function announceLiveMessage(message) {
    const region = document.getElementById('ariaLiveRegion');
    if (!region) return;
    region.textContent = message;
}

function setCropToNA() {
    document.getElementById('cropName').value = 'लागू नाही';
}

function setupEventListeners() {
    const backupClose = document.getElementById('backupReminderClose');
    backupClose?.addEventListener('click', () => document.getElementById('backupReminder')?.classList.add('hidden'));

    document.getElementById('setCropNAButton')?.addEventListener('click', setCropToNA);
    document.getElementById('galleryButton')?.addEventListener('click', () => document.getElementById('photoUpload')?.click());
    document.getElementById('photoUpload')?.addEventListener('change', uploadPhotoFromGallery);
    document.getElementById('workType')?.addEventListener('change', toggleCustomWorkField);
    document.getElementById('addWorkBtn')?.addEventListener('click', () => addItem('work'));
    document.getElementById('addLabourBtn')?.addEventListener('click', () => addItem('labour'));
    document.getElementById('addSeedBtn')?.addEventListener('click', () => addItem('seed'));
    document.getElementById('addFertBtn')?.addEventListener('click', () => addItem('fert'));
    document.getElementById('addMedBtn')?.addEventListener('click', () => addItem('med'));
    document.getElementById('addIncomeBtn')?.addEventListener('click', () => addItem('income'));
    document.getElementById('addDieselBtn')?.addEventListener('click', addDieselEntry);
    document.getElementById('clearDieselBtn')?.addEventListener('click', clearDieselHistory);
    document.getElementById('totalIncome')?.addEventListener('input', updateCalculations);
    document.getElementById('transCost')?.addEventListener('input', updateCalculations);
    document.getElementById('saveBtn')?.addEventListener('click', saveRecord);
    document.getElementById('syncBtn')?.addEventListener('click', syncPendingRecords);
    document.getElementById('resetBtn')?.addEventListener('click', resetForm);
    document.getElementById('filterFarm')?.addEventListener('input', renderHistory);
    document.getElementById('exportCsvBtn')?.addEventListener('click', exportToCSV);
    document.getElementById('exportPdfBtn')?.addEventListener('click', exportToPDF);
    document.getElementById('printBtn')?.addEventListener('click', () => window.print());

    document.body.addEventListener('click', function(event) {
        const button = event.target.closest('[data-action]');
        if (!button) return;
        const action = button.dataset.action;
        switch (action) {
            case 'remove-item': {
                const type = button.dataset.type;
                const id = Number(button.dataset.id);
                if (!Number.isNaN(id)) removeItem(type, id);
                break;
            }
            case 'edit-record': editRecord(button.dataset.id); break;
            case 'delete-record': deleteRecord(event, button.dataset.id, button.dataset.date, button.dataset.farm); break;
            case 'view-photo': {
                const photoId = Number(button.dataset.photoId);
                if (!Number.isNaN(photoId)) viewPhotoDetails(photoId);
                break;
            }
            case 'delete-diesel': {
                const dieselId = Number(button.dataset.id);
                if (!Number.isNaN(dieselId)) deleteDieselEntry(dieselId);
                break;
            }
        }
    });

    document.getElementById('ocrScanButton')?.addEventListener('click', () => document.getElementById('ocrReceiptUpload')?.click());
    document.getElementById('ocrCameraButton')?.addEventListener('click', openCamera);
    document.getElementById('ocrReceiptUpload')?.addEventListener('change', handleOCRImage);
    document.getElementById('ocrAutoFillBtn')?.addEventListener('click', autoFillFromOCR);
    document.getElementById('ocrClearBtn')?.addEventListener('click', clearOCRResults);
    document.getElementById('ocrRotateBtn')?.addEventListener('click', () => rotateCropImage(90));
    document.getElementById('ocrResetCropBtn')?.addEventListener('click', resetCropImage);
    document.getElementById('ocrCropConfirmBtn')?.addEventListener('click', confirmCrop);
    document.getElementById('ocrSkipCropBtn')?.addEventListener('click', skipCropping);
}

function setupFormValidation() {
    const numericInputs = Array.from(document.querySelectorAll('input[type="number"], input[data-validate-number]'));
    numericInputs.forEach(input => {
        input.addEventListener('input', () => {
            const value = input.value.trim();
            const isValid = value === '' || !Number.isNaN(parseFloat(value));
            input.classList.toggle('invalid-input', !isValid);
        });
    });
}

async function onLoad() {
    setNow();
    updateClock();
    setInterval(updateClock, 5000);

    // Initialize Tesseract Worker in background for faster OCR scanning
    initializeTesseractWorker().catch(err => console.warn('Tesseract initialization warning:', err));

    await initOfflineDB();
    const initialPendingRecords = await loadPendingRecords();
    updateRecordState('SET_PENDING_RECORDS', initialPendingRecords);
    if (!isLocalFileOrigin() && navigator.onLine && appState.pendingRecords.length > 0) {
        await processPendingRecords(true);
    }

    await refreshSheetData();
    await initPhotoDB();
    await loadDieselHistory();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && !isLocalFileOrigin() && navigator.onLine && appState.pendingRecords.length > 0) {
            const updatedPending = await loadPendingRecords();
            updateRecordState('SET_PENDING_RECORDS', updatedPending);
            await processPendingRecords(true);
        }
    });

    setInterval(async () => {
        if (!isLocalFileOrigin() && navigator.onLine && appState.pendingRecords.length > 0) {
            const syncPending = await loadPendingRecords();
            updateRecordState('SET_PENDING_RECORDS', syncPending);
            await processPendingRecords(true);
        }
    }, 30000);

    setupEventListeners();
    setupFormValidation();
    updateNetworkStatus();
}

function setNow() {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60000;
    const localISOTime = (new Date(now - offset)).toISOString().slice(0, 16);
    const el = document.getElementById('manualDateTime');
    if (el) el.value = localISOTime;
}

function updateClock() {
    const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' };
    const el = document.getElementById('clockDisplay');
    if (el) el.innerText = new Date().toLocaleString('mr-IN', options);
}

async function refreshSheetData() {
    const loadingSpinner = document.getElementById('loadingSpinner');
    if (loadingSpinner) loadingSpinner.classList.remove('hidden');

    try {
        const rawData = await fetchSheetRecords();
        const processedRecords = rawData.map(row => ({
            id: row[7] || generateUUID(),
            date: row[0],
            farm: row[1],
            crop: row[2],
            exp: parseFloat(row[3]) || 0,
            inc: parseFloat(row[4]) || 0,
            pl: parseFloat(row[5]) || 0,
            details: row[6] || ''
        }));
        // Use centralized state update
        updateRecordState('SET_RECORDS', processedRecords);
        updateAutoSuggestions();
    } catch (e) {
        console.error('Load Error', e);
        const body = document.getElementById('historyBody');
        if (body) {
            body.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-red-500 font-bold">डेटा लोड करण्यात त्रुटी: ${escapeHTML(getFriendlyNetworkMessage(e))}</td></tr>`;
        }
    } finally {
        if (loadingSpinner) loadingSpinner.classList.add('hidden');
    }
}

function updateNetworkStatus() {
    const statusDiv = document.getElementById('networkStatus');
    const backupReminder = document.getElementById('backupReminder');
    const pendingCount = document.getElementById('pendingRecordsCount');

    if (backupReminder && pendingCount) {
        if (appState.pendingRecords.length > 0) {
            backupReminder.classList.remove('hidden');
            pendingCount.innerText = appState.pendingRecords.length;
        } else {
            backupReminder.classList.add('hidden');
        }
    }

    if (!statusDiv) return;
    if (navigator.onLine) {
        if (appState.pendingRecords.length > 0) {
            statusDiv.innerHTML = `<span class="text-xs bg-yellow-100 text-yellow-700 px-2 py-1 rounded-full font-bold"><i class="fa-solid fa-cloud-arrow-up mr-1"></i> ${appState.pendingRecords.length} नोंदी सिंक होण्यासाठी प्रतीक्षा करीत आहेत</span>`;
        } else {
            statusDiv.innerHTML = '<span class="text-xs bg-emerald-100 text-emerald-700 px-2 py-1 rounded-full font-bold"><i class="fa-solid fa-wifi mr-1"></i> ऑनलाइन</span>';
        }
        const syncBtn = document.getElementById('syncBtn');
        if (syncBtn) {
            syncBtn.disabled = appState.pendingRecords.length === 0;
            if (appState.pendingRecords.length > 0) {
                syncBtn.classList.remove('hidden');
            } else {
                syncBtn.classList.add('hidden');
            }
        }
    } else {
        statusDiv.innerHTML = `<span class="text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full font-bold animate-pulse"><i class="fa-solid fa-wifi-slash mr-1"></i> ऑफलाइन ${appState.pendingRecords.length > 0 ? `(${appState.pendingRecords.length})` : ''}</span>`;
        const syncBtn = document.getElementById('syncBtn');
        if (syncBtn) {
            syncBtn.disabled = true;
            syncBtn.classList.remove('hidden');
        }
    }
}

/**
 * Renders a single page of history records with pagination support
 * @param {number} pageNumber - The page to render (1-indexed)
 * @param {number} itemsPerPage - Number of items to show per page
 * @param {string} filter - Filter text (farm name or crop name)
 */
function renderHistoryPage(pageNumber = 1, itemsPerPage = 30, filter = '') {
    try {
        const body = document.getElementById('historyBody');
        const cardContainer = document.getElementById('historyCardContainer');
        const paginationContainer = document.getElementById('paginationControls');
        
        if (!body || !cardContainer) return;

        // Filter records based on farm/crop
        const filteredRecords = appState.records.slice().reverse().filter(r => {
            if (!filter) return true;
            const filterLower = filter.toLowerCase();
            const farmText = (r.farm || '').toLowerCase();
            const cropText = (r.crop || '').toLowerCase();
            return farmText.includes(filterLower) || cropText.includes(filterLower);
        });

        // Calculate pagination
        const totalPages = Math.ceil(filteredRecords.length / itemsPerPage);
        const validPage = Math.max(1, Math.min(pageNumber, totalPages || 1));
        const startIndex = (validPage - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const pageRecords = filteredRecords.slice(startIndex, endIndex);

        // Update pagination state
        appState.pagination.currentPage = validPage;
        appState.pagination.currentFilter = filter;

        // Render table and cards
        let bodyHtml = '';
        let cardHtml = '';
        let tInc = 0;
        let tExp = 0;

        if (pageRecords.length === 0) {
            const emptyMessage = filter 
                ? '<div class="p-8 text-center text-gray-500">तुमच्या शोधाशी मिळतीजुळती कोणतीही नोंद सापडली नाही.</div>'
                : '<div class="p-8 text-center text-gray-500">कोणताही डेटा उपलब्ध नाही. नवीन नोंद तयार करा.</div>';
            body.innerHTML = `<tr><td colspan="6" class="p-8 text-center text-gray-500">${filter ? 'तुमच्या शोधाशी मिळतीजुळती नोंद नाही.' : 'कोणताही डेटा उपलब्ध नाही.'}</td></tr>`;
            cardContainer.innerHTML = emptyMessage;
            document.getElementById('totalAllIncome').innerText = '0';
            document.getElementById('totalAllExp').innerText = '0';
            document.getElementById('totalAllProfit').innerText = '0';
            if (paginationContainer) paginationContainer.innerHTML = '';
            return;
        }

        // Calculate totals for current page
        pageRecords.forEach(r => {
            tInc += r.inc;
            tExp += r.exp;
            const formattedDate = new Date(r.date).toLocaleDateString('mr-IN', { day: '2-digit', month: 'short', year: 'numeric' });
            const escapedCrop = escapeHTML(r.crop || 'अज्ञात');
            const escapedFarm = escapeHTML(r.farm || 'अज्ञात');
            const escapedDetails = escapeHTML(r.details || 'कोणताही तपशील नाही');
            const safeId = escapeHTML(r.id);
            const safeDate = escapeHTML(r.date);

            bodyHtml += `<tr class="hover:bg-slate-50 transition-colors">
                <td class="p-4 align-top">
                    <span class="font-bold text-slate-800 text-sm block mb-1">${escapedCrop}</span>
                    <span class="inline-block bg-slate-100 text-slate-600 text-[10px] px-2 py-1 rounded font-bold mr-1">${escapedFarm}</span>
                    <span class="inline-block text-slate-400 text-[10px]"><i class="fa-regular fa-calendar mr-1"></i>${formattedDate}</span>
                </td>
                <td class="p-4 text-xs text-slate-600 max-w-xs break-words leading-relaxed">${escapedDetails}</td>
                <td class="p-4 text-right text-red-500 font-bold bg-red-50/30">₹${(r.exp || 0).toLocaleString('en-IN')}</td>
                <td class="p-4 text-right text-emerald-600 font-bold bg-emerald-50/30">₹${(r.inc || 0).toLocaleString('en-IN')}</td>
                <td class="p-4 text-right font-black text-lg ${(r.pl || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}">₹${(r.pl || 0).toLocaleString('en-IN')}</td>
                <td class="p-4 text-center no-print align-middle flex justify-center items-center gap-2">
                    <button data-action="edit-record" data-id="${safeId}" class="bg-amber-50 text-amber-600 hover:bg-amber-100 hover:text-amber-800 p-2 rounded-lg transition-all shadow-sm" title="एडिट करा" aria-label="नोंद एडिट करा"><i class="fa-solid fa-pen-to-square" aria-hidden="true"></i></button>
                    <button data-action="delete-record" data-id="${safeId}" data-date="${safeDate}" data-farm="${escapedFarm.replace(/"/g, '&quot;')}" class="bg-red-50 text-red-500 hover:bg-red-500 hover:text-white p-2 rounded-lg transition-all shadow-sm" title="डिलीट करा" aria-label="नोंद हटवा"><i class="fa-solid fa-trash-can" aria-hidden="true"></i></button>
                </td>
            </tr>`;

            cardHtml += `
                <div class="bg-white p-4 rounded-3xl border border-gray-200 shadow-sm">
                    <div class="flex items-start justify-between gap-4 mb-3">
                        <div>
                            <div class="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">${formattedDate}</div>
                            <h3 class="text-base font-bold text-slate-900 mb-1">${escapedCrop}</h3>
                            <div class="text-sm text-slate-600">${escapedFarm}</div>
                        </div>
                        <div class="text-right">
                            <div class="mt-2 text-lg font-black ${(r.pl || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}">₹${(r.pl || 0).toLocaleString('en-IN')}</div>
                        </div>
                    </div>
                    <div class="text-sm text-slate-600 mb-4 break-words">${escapedDetails}</div>
                    <div class="grid grid-cols-4 gap-2 text-[11px]">
                        <span class="bg-red-50 text-red-600 px-2 py-2 rounded-xl text-center">खर्च ₹${(r.exp || 0).toLocaleString('en-IN')}</span>
                        <span class="bg-emerald-50 text-emerald-600 px-2 py-2 rounded-xl text-center">उत्पन्न ₹${(r.inc || 0).toLocaleString('en-IN')}</span>
                        <button data-action="edit-record" data-id="${safeId}" class="bg-amber-50 hover:bg-amber-100 text-amber-600 px-2 py-2 rounded-xl transition" title="नोंद एडिट करा">एडिट</button>
                        <button data-action="delete-record" data-id="${safeId}" data-date="${safeDate}" data-farm="${escapedFarm.replace(/"/g, '&quot;')}" class="bg-red-50 hover:bg-red-100 text-red-600 px-2 py-2 rounded-xl transition" title="नोंद हटवा">डिलीट</button>
                    </div>
                </div>`;
        });

        // Render pagination controls
        let paginationHtml = '';
        if (totalPages > 1) {
            paginationHtml = `
                <div class="flex items-center justify-center gap-2 py-4">
                    <button id="prevPageBtn" class="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition" ${validPage === 1 ? 'disabled' : ''}>← मागील</button>
                    <span class="px-4 py-2 text-slate-700 font-semibold">पृष्ठ ${validPage} / ${totalPages}</span>
                    <button id="nextPageBtn" class="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition" ${validPage === totalPages ? 'disabled' : ''}>पुढील →</button>
                    <span class="text-sm text-slate-600 ml-4">${filteredRecords.length} नोंदी एकूण</span>
                </div>`;
        }

        body.innerHTML = bodyHtml;
        cardContainer.innerHTML = cardHtml;
        if (paginationContainer) {
            paginationContainer.innerHTML = paginationHtml;
            // Add pagination event listeners
            const prevBtn = document.getElementById('prevPageBtn');
            const nextBtn = document.getElementById('nextPageBtn');
            if (prevBtn) {
                prevBtn.addEventListener('click', () => {
                    renderHistoryPage(validPage - 1, itemsPerPage, filter);
                    document.querySelector('table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            }
            if (nextBtn) {
                nextBtn.addEventListener('click', () => {
                    renderHistoryPage(validPage + 1, itemsPerPage, filter);
                    document.querySelector('table')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                });
            }
        }

        document.getElementById('totalAllIncome').innerText = tInc.toLocaleString('en-IN');
        document.getElementById('totalAllExp').innerText = tExp.toLocaleString('en-IN');
        document.getElementById('totalAllProfit').innerText = (tInc - tExp).toLocaleString('en-IN');

    } catch (error) {
        console.error('Error rendering history page:', error);
        Swal.fire('त्रुटी', 'इतिहास प्रदर्शित करताना अडचण: ' + (error.message || error), 'error');
    }
}

async function processPendingRecords(autoSync = false) {
    if (appState.pendingRecords.length === 0) return { success: 0, failed: 0 };
    if (isLocalFileOrigin()) {
        if (!autoSync) Swal.fire('स्थानीय फाइल मोड', 'हे पेज file:// वरून चालू आहे. कृपया HTTP/HTTPS सर्व्हर (उदा. http://localhost) वापरा.', 'warning');
        return { success: 0, failed: appState.pendingRecords.length };
    }
    if (!navigator.onLine) {
        if (!autoSync) Swal.fire('नेटवर्क कनेक्शन आवश्यक', 'कृपया इंटरनेट कनेक्शन तपासा.', 'error');
        return { success: 0, failed: appState.pendingRecords.length };
    }

    const toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
    if (autoSync) toast.fire({ icon: 'info', title: `${appState.pendingRecords.length} नोंदी सिंक होत आहेत...` });

    let successCount = 0;
    let failedCount = 0;

    for (const record of [...appState.pendingRecords]) {
        try {
            await syncRecordWithRetry(record);
            await deletePendingRecord(record.id);
            successCount++;
        } catch (error) {
            failedCount++;
            console.warn('Sync failed for record:', record.id, error);
            if (!navigator.onLine) break;
        }
        await new Promise(r => setTimeout(r, 100));
    }

    const updatedPending = await loadPendingRecords();
    updateRecordState('SET_PENDING_RECORDS', updatedPending);
    updateNetworkStatus();

    if (successCount > 0) toast.fire({ icon: 'success', title: `${successCount} नोंदी सिंक झाल्या` });
    if (failedCount > 0 && !autoSync) toast.fire({ icon: 'warning', title: `${failedCount} नोंदी प्रलंबित आहेत` });
    return { success: successCount, failed: failedCount };
}

async function handleOnline() {
    console.log('Network connection restored');
    const freshPending = await loadPendingRecords();
    updateRecordState('SET_PENDING_RECORDS', freshPending);
    updateNetworkStatus();
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
    Toast.fire({ icon: 'success', title: 'नेटवर्क कनेक्ट झाले!' });
    if (!isLocalFileOrigin() && appState.pendingRecords.length > 0) {
        await processPendingRecords(true);
    }
}

async function handleOffline() {
    console.log('Network connection lost');
    updateNetworkStatus();
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
    Toast.fire({ icon: 'warning', title: 'नेटवर्क डिस्कनेक्ट झाला!' });
}

async function syncPendingRecords() {
    if (appState.pendingRecords.length === 0) {
        Swal.fire('कोणतीही नोंद नाही', 'ऑफलाइन सिंक करण्यासाठी कोणतीही अप्रकाशित नोंद नाही.', 'info');
        return;
    }
    const syncBtn = document.getElementById('syncBtn');
    const syncBtnText = document.getElementById('syncBtnText');
    const originalText = syncBtnText?.innerText || 'सिंक करा';
    syncBtn.disabled = true;
    if (syncBtnText) syncBtnText.innerText = 'सिंक होत आहे...';
    await processPendingRecords(false);
    syncBtn.disabled = false;
    if (syncBtnText) syncBtnText.innerText = originalText;
    if (appState.pendingRecords.length === 0) syncBtn?.classList.add('hidden');
}

function parseNumberField(id) {
    const element = document.getElementById(id);
    if (!element) return NaN;
    const number = parseFloat(String(element.value).trim());
    return Number.isFinite(number) ? number : NaN;
}

function addItem(type) {
    let name = '';
    let qty = 1;
    let rate = 0;
    let total = 0;
    let display = '';

    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });

    if (type === 'work') {
        qty = parseNumberField('workQty');
        rate = parseNumberField('workRate');
        const unit = document.getElementById('workUnit')?.value || 'एकक';

        if (isNaN(qty) || isNaN(rate)) {
            Swal.fire('अवैध मूल्य', 'कृपया प्रमाण आणि दर संख्यात्मक स्वरूपात टाका.', 'warning');
            return;
        }
        if (qty <= 0 || rate <= 0) {
            Swal.fire('अवैध मूल्य', 'प्रमाण आणि दर शून्य किंवा ऋणात्मक असू शकत नाही.', 'warning');
            return;
        }
        const selectedWorkType = document.getElementById('workType')?.value;
        if (selectedWorkType === 'इतर') {
            const customWork = document.getElementById('customWorkType')?.value.trim();
            if (!customWork) { Swal.fire('माहिती आवश्यक', 'कृपया इतर कामाचे नाव भरा.', 'warning'); return; }
            name = customWork;
        } else {
            name = selectedWorkType || 'कार्य';
        }
        total = qty * rate;
        display = `${name} (${qty} ${unit} x ₹${rate})`;
        document.getElementById('workQty').value = '';
    } else if (type === 'labour') {
        name = document.getElementById('labourTask')?.value || 'मजुरी';
        qty = parseNumberField('labourCount');
        rate = parseNumberField('labourRate');
        if (isNaN(qty) || isNaN(rate)) {
            Swal.fire('अवैध मूल्य', 'कृपया मजूर संख्या आणि दर संख्यात्मक स्वरूपात टाका.', 'warning'); return; }
        if (qty <= 0 || rate <= 0) { Swal.fire('अवैध मूल्य', 'मजूर संख्या आणि दर शून्य किंवा ऋणात्मक असू शकत नाही.', 'warning'); return; }
        total = qty * rate;
        display = `${name} (${qty} मजूर)`;
    } else if (type === 'income') {
        name = document.getElementById('iName')?.value;
        qty = parseNumberField('iQty');
        rate = parseNumberField('iRate');
        if (isNaN(qty) || isNaN(rate)) {
            Swal.fire('अवैध मूल्य', 'कृपया प्रमाण आणि दर संख्यात्मक स्वरूपात टाका.', 'warning'); return; }
        if (!name || qty <= 0 || rate <= 0) { Swal.fire('अवैध मूल्य', 'प्रमाण आणि दर शून्य किंवा ऋणात्मक असू शकत नाही.', 'warning'); return; }
        total = qty * rate;
        display = `${name} (${qty} x ₹${rate})`;
    } else {
        const pre = type === 'seed' ? 's' : (type === 'fert' ? 'f' : 'm');
        name = document.getElementById(pre + 'Name')?.value;
        qty = parseNumberField(pre + 'Qty');
        const unit = document.getElementById(pre + 'Unit')?.value || 'एकक';
        rate = parseNumberField(pre + 'Rate');
        if (isNaN(qty) || isNaN(rate)) {
            Swal.fire('अवैध मूल्य', 'कृपया प्रमाण आणि दर संख्यात्मक स्वरूपात टाका.', 'warning'); return; }
        if (!name || qty <= 0 || rate <= 0) { Swal.fire('अवैध मूल्य', 'प्रमाण आणि दर शून्य किंवा ऋणात्मक असू शकत नाही.', 'warning'); return; }
        total = qty * rate;
        display = `${name} (${qty} ${unit} x ₹${rate})`;
    }

    if (!display || total === 0) { Swal.fire('माहिती अपूर्ण', 'माहिती पूर्ण भरा!', 'warning'); return; }
    // update centralized lists state
    appState.lists[type].push({ id: Date.now(), name: display, total, qty });
    renderList(type);
    updateCalculations();
    Toast.fire({ icon: 'success', title: 'नोंद जोडली' });
}

function renderList(type) {
    const container = document.getElementById(type + 'List');
    if (!container) return;
    let sum = 0;
    let htmlContent = '';
    appState.lists[type].forEach(item => {
        sum += item.total;
        htmlContent += `
        <div class="flex justify-between items-center bg-white p-2.5 mb-1.5 rounded-lg border border-gray-100 shadow-sm border-l-4 border-l-emerald-500 group transition hover:bg-gray-50">
            <span class="text-gray-700 font-medium truncate pr-2">${escapeHTML(item.name)}</span>
            <span class="font-bold flex items-center whitespace-nowrap">₹${item.total.toLocaleString('en-IN')} 
                <button data-action="remove-item" data-type="${type}" data-id="${item.id}" class="ml-3 text-gray-300 hover:text-red-500 focus:outline-none transition-colors"><i class="fa-solid fa-circle-xmark text-lg"></i></button>
            </span>
        </div>`;
    });
    container.innerHTML = htmlContent;
    const totalEl = document.getElementById(type + 'GrantTotal');
    if (totalEl) totalEl.innerText = '₹ ' + sum.toLocaleString('en-IN');
}

function removeItem(type, id) {
    appState.lists[type] = appState.lists[type].filter(i => i.id !== id);
    renderList(type);
    updateCalculations();
}

async function initDieselDB() {
    const entries = await getDieselEntries();
    updateRecordState('SET_DIESEL_ENTRIES', entries);
    renderDieselList();
    updateDieselStats();
}

async function loadDieselHistory() {
    const entries = await getDieselEntries();
    updateRecordState('SET_DIESEL_ENTRIES', entries);
    renderDieselList();
    updateDieselStats();
}

async function addDieselEntry() {
    const litersInput = document.getElementById('dieselLiters')?.value.trim();
    const rateInput = document.getElementById('dieselRate')?.value.trim();
    const startHRInput = document.getElementById('dieselStartHR')?.value.trim();
    const endHRInput = document.getElementById('dieselEndHR')?.value.trim();

    if (litersInput === '' || rateInput === '' || startHRInput === '' || endHRInput === '') {
        Swal.fire('माहिती अपूर्ण', 'कृपया सर्व फील्ड भरा (लिटर, दर, स्टार्ट HR, एन्ड HR).', 'warning');
        return;
    }

    const liters = parseFloat(litersInput);
    const rate = parseFloat(rateInput);
    const startHR = parseFloat(startHRInput);
    const endHR = parseFloat(endHRInput);

    if (isNaN(liters) || isNaN(rate) || isNaN(startHR) || isNaN(endHR)) {
        Swal.fire('अवैध मूल्य', 'कृपया संख्यात्मक मूल्य टाका.', 'warning');
        return;
    }
    if (liters <= 0 || rate <= 0) {
        Swal.fire('अवैध मूल्य', 'लिटर आणि दर शून्य पेक्षा अधिक असावेत.', 'warning');
        return;
    }
    if (endHR < startHR) {
        Swal.fire('अवैध मूल्य', 'एन्ड HR (अंतिम तास) हा स्टार्ट HR पेक्षा कमी असू शकत नाही.', 'warning');
        return;
    }

    const hoursRun = endHR - startHR;
    const totalCost = liters * rate;
    const entry = {
        id: Date.now(),
        liters,
        rate,
        totalCost,
        startHR,
        endHR,
        hoursRun,
        timestamp: new Date().toLocaleString('mr-IN')
    };

    await saveDieselEntry(entry);
    await loadDieselHistory();

    document.getElementById('dieselLiters').value = '';
    document.getElementById('dieselRate').value = '';
    document.getElementById('dieselStartHR').value = endHR;
    document.getElementById('dieselEndHR').value = '';

    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
    Toast.fire({ icon: 'success', title: 'डिझेल नोंद जोडली!' });
}

function renderDieselList() {
    const container = document.getElementById('dieselList');
    if (!container) return;
    let htmlContent = '';
    appState.dieselEntries.slice(0, 10).forEach(entry => {
        htmlContent += `
        <div class="flex justify-between items-center bg-orange-50 p-2 rounded-lg border border-orange-100 text-xs">
            <span class="text-orange-800">${escapeHTML(entry.liters.toString())}लि @ ₹${escapeHTML(entry.rate.toString())} | ${escapeHTML(entry.hoursRun.toFixed(2))}तास</span>
            <span class="font-bold text-orange-700">₹${escapeHTML(entry.totalCost.toLocaleString('en-IN'))}
                <button data-action="delete-diesel" data-id="${entry.id}" class="ml-2 text-orange-400 hover:text-red-500"><i class="fa-solid fa-circle-xmark"></i></button>
            </span>
        </div>`;
    });
    container.innerHTML = htmlContent;
}

function updateDieselStats() {
    const totalLiters = appState.dieselEntries.reduce((s, e) => s + e.liters, 0);
    const totalHours = appState.dieselEntries.reduce((s, e) => s + e.hoursRun, 0);
    const totalCost = appState.dieselEntries.reduce((s, e) => s + e.totalCost, 0);
    document.getElementById('totalDieselLiters').innerText = totalLiters.toFixed(2);
    document.getElementById('totalDieselHours').innerText = totalHours.toFixed(2);
    document.getElementById('totalDieselCost').innerText = totalCost.toLocaleString('en-IN');
    document.getElementById('dieselTotal').innerText = '₹' + totalCost.toLocaleString('en-IN');
    const efficiency = totalHours > 0 ? (totalLiters / totalHours).toFixed(2) + ' लि/तास' : '--';
    document.getElementById('avgFuelConsumption').innerText = efficiency;
    document.getElementById('efficiencyDisplay').innerText = efficiency;
}

async function deleteDieselEntry(id) {
    await deleteDieselEntryById(id);
    await loadDieselHistory();
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
    Toast.fire({ icon: 'success', title: 'डिझेल नोंद हटवली' });
}

async function clearDieselHistory() {
    const result = await Swal.fire({
        title: 'डिझेल इतिहास क्लिअर करायचा?',
        text: 'सर्व डिझेल नोंदी हटवल्या जातील!',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#f97316',
        cancelButtonColor: '#64748b',
        confirmButtonText: 'होय, क्लिअर करा',
        cancelButtonText: 'रद्द करा'
    });

    if (!result.isConfirmed) return;
    await clearDieselEntries();
    await loadDieselHistory();
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
    Toast.fire({ icon: 'success', title: 'इतिहास क्लिअर झाला!' });
}

function clearFormFields() {
    document.querySelectorAll('input[type="text"], input[type="number"], input[type="date"], input[type="datetime-local"], select').forEach(input => {
        if (input.id === 'workType') {
            input.value = 'नांगरणी';
        } else if (['text', 'number', 'date', 'datetime-local'].includes(input.type)) {
            input.value = '';
        }
    });
    document.getElementById('customWorkWrapper')?.classList.add('hidden');
    const emptyLists = { seed: [], fert: [], med: [], work: [], labour: [], income: [] };
    updateRecordState('SET_LISTS', emptyLists);
    Object.keys(emptyLists).forEach(type => renderList(type));
    updateRecordState('SET_EDITING_RECORD', null);
    document.getElementById('saveBtnText').innerText = 'डेटा सेव्ह करा';
    updateCalculations();
    setNow();
    document.getElementById('photoPreview').innerHTML = '';
}

function toggleCustomWorkField() {
    const workType = document.getElementById('workType')?.value;
    const wrapper = document.getElementById('customWorkWrapper');
    const customInput = document.getElementById('customWorkType');
    if (workType === 'इतर') {
        wrapper?.classList.remove('hidden');
        customInput?.focus();
    } else {
        wrapper?.classList.add('hidden');
        if (customInput) customInput.value = '';
    }
}

function updateCalculations() {
    let expTotal = 0;
    let incListTotal = 0;
    const currentLists = appState.lists || {};
    Object.keys(currentLists).forEach(key => {
        const sum = (currentLists[key] || []).reduce((s, i) => s + i.total, 0);
        if (key === 'income') incListTotal += sum;
        else expTotal += sum;
    });

    const trans = parseFloat(document.getElementById('transCost')?.value) || 0;
    expTotal += trans;
    const incTotal = parseFloat(document.getElementById('totalIncome')?.value) || 0;
    document.getElementById('finalExp').innerText = expTotal.toLocaleString('en-IN');
    document.getElementById('finalIncTotal').innerText = incTotal.toLocaleString('en-IN');
    const pl = incTotal - expTotal;
    const disp = document.getElementById('finalPLDisplay');
    if (disp) {
        disp.innerText = '₹ ' + pl.toLocaleString('en-IN');
        disp.className = pl >= 0 ? 'text-3xl font-black tracking-tight text-emerald-400' : 'text-3xl font-black tracking-tight text-red-400';
    }
}

window.updateCalculations = updateCalculations;

function getDetailSegment(details, label) {
    if (!details || !details.includes(label)) return '';
    return details.split(label)[1].split('|')[0].trim();
}

function parseDetailItems(segment, type) {
    if (!segment) return [];
    return segment.split(',').map(item => item.trim()).filter(Boolean).map((raw, index) => {
        let display = raw;
        let total = 0;
        let qty = 0;
        const totalMatch = raw.match(/=\s*₹\s*([0-9,]+(?:\.[0-9]+)?)/);
        if (totalMatch) {
            total = parseFloat(totalMatch[1].replace(/,/g, '')) || 0;
            display = raw.split(/=\s*₹\s*/)[0].trim();
        }
        if (!total) {
            const amountMatch = raw.match(/([0-9.,]+)\s*x\s*₹\s*([0-9.,]+)/);
            if (amountMatch) {
                qty = parseFloat(amountMatch[1].replace(/,/g, '')) || 0;
                const rate = parseFloat(amountMatch[2].replace(/,/g, '')) || 0;
                total = qty * rate;
            }
        }
        if (!qty) {
            const qtyMatch = raw.match(/([0-9.,]+)\s*(?:तास|मजूर|kg|किलो|लिटर|एकक|x)/);
            if (qtyMatch) qty = parseFloat(qtyMatch[1].replace(/,/g, '')) || 0;
        }
        if (!total && type === 'income') {
            const amountMatch = raw.match(/\(\s*([0-9.,]+)\s*x\s*₹\s*([0-9.,]+)\s*\)/);
            if (amountMatch) {
                qty = parseFloat(amountMatch[1].replace(/,/g, '')) || 0;
                const rate = parseFloat(amountMatch[2].replace(/,/g, '')) || 0;
                total = qty * rate;
            }
        }
        return { id: Date.now() + index, name: display, total, qty };
    });
}

function parseDetailsToLists(details) {
    return {
        seed: parseDetailItems(getDetailSegment(details, 'बियाणे:'), 'seed'),
        fert: parseDetailItems(getDetailSegment(details, 'खत:'), 'fert'),
        med: parseDetailItems(getDetailSegment(details, 'औषधे:'), 'med'),
        work: parseDetailItems(getDetailSegment(details, 'यंत्र:'), 'work'),
        labour: parseDetailItems(getDetailSegment(details, 'मजुरी:'), 'labour'),
        income: parseDetailItems(getDetailSegment(details, 'उत्पन्न:'), 'income')
    };
}

function editRecord(recordId) {
    const record = appState.records.find(item => item.id === recordId);
    if (!record) {
        Swal.fire('माहिती सापडली नाही', 'निवडलेल्या नोंदीची माहिती सापडली नाही.', 'error');
        return;
    }

    document.getElementById('farmName').value = record.farm || '';
    document.getElementById('cropName').value = record.crop || '';
    if (record.date) {
        const dateObj = new Date(record.date);
        if (!isNaN(dateObj)) {
            const offset = dateObj.getTimezoneOffset() * 60000;
            document.getElementById('manualDateTime').value = new Date(dateObj - offset).toISOString().slice(0, 16);
        }
    }
    document.getElementById('totalIncome').value = record.inc || '';
    document.getElementById('transCost').value = (record.details.match(/इतर खर्च:\s*₹\s*([0-9]+(?:\.[0-9]+)?)/) || [])[1] || '';

    const parsedLists = parseDetailsToLists(record.details || '');
    updateRecordState('SET_LISTS', parsedLists);
    Object.keys(parsedLists).forEach(type => renderList(type));
    updateRecordState('SET_EDITING_RECORD', recordId);
    document.getElementById('saveBtnText').innerText = 'अपडेट करा';
    updateCalculations();
    Swal.fire({ icon: 'info', title: 'नोंद फॉर्ममध्ये भरली', text: 'ही नोंद आता फॉर्ममध्ये उपलब्ध आहे. तुम्ही आवश्यक बदल करून सेव्ह करू शकता.', timer: 2200, showConfirmButton: false });
}

async function saveRecord() {
    const farm = document.getElementById('farmName')?.value.trim();
    const crop = document.getElementById('cropName')?.value.trim() || 'लागू नाही';
    if (!farm) { Swal.fire('माहिती आवश्यक', 'शेतकरी / शेताचे नाव आवश्यक आहे!', 'error'); return; }

    const exp = parseFloat(document.getElementById('finalExp')?.innerText.replace(/,/g, '')) || 0;
    const inc = parseFloat(document.getElementById('finalIncTotal')?.innerText.replace(/,/g, '')) || 0;
    if (exp === 0 && inc === 0) { Swal.fire('रक्कम आवश्यक', 'कोणतीही नोंद केलेली नाही. कृपया खर्च किंवा उत्पन्न टाका.', 'warning'); return; }

    const listsState = appState.lists || { seed: [], fert: [], med: [], work: [], labour: [], income: [] };
    const details = [];
    if (listsState.seed && listsState.seed.length) details.push('बियाणे: ' + listsState.seed.map(i => `${i.name} = ₹${i.total.toLocaleString('en-IN')}`).join(', '));
    if (listsState.fert && listsState.fert.length) details.push('खत: ' + listsState.fert.map(i => `${i.name} = ₹${i.total.toLocaleString('en-IN')}`).join(', '));
    if (listsState.med && listsState.med.length) details.push('औषधे: ' + listsState.med.map(i => `${i.name} = ₹${i.total.toLocaleString('en-IN')}`).join(', '));
    if (listsState.work && listsState.work.length) details.push('यंत्र: ' + listsState.work.map(i => `${i.name} = ₹${i.total.toLocaleString('en-IN')}`).join(', '));
    if (listsState.labour && listsState.labour.length) details.push('मजुरी: ' + listsState.labour.map(i => `${i.name} = ₹${i.total.toLocaleString('en-IN')}`).join(', '));
    if (listsState.income && listsState.income.length) details.push('उत्पन्न: ' + listsState.income.map(i => `${i.name} = ₹${i.total.toLocaleString('en-IN')}`).join(', '));
    if (document.getElementById('transCost')?.value) details.push('इतर खर्च: ₹' + document.getElementById('transCost').value);

    const recordId = appState.editingRecordId || generateUUID();
    const newRecord = {
        action: appState.editingRecordId ? 'update' : 'add',
        id: recordId,
        farm,
        crop,
        date: document.getElementById('manualDateTime')?.value,
        exp,
        inc,
        pl: inc - exp,
        details: details.join(' | ') || 'कोणताही तपशील नाही',
        timestamp: new Date().toISOString()
    };

    const btn = document.getElementById('saveBtn');
    const btnText = document.getElementById('saveBtnText');
    const originalText = btnText?.innerText || 'सेव्ह';
    try {
        if (btnText) btnText.innerText = 'सेव्ह होत आहे...';
        if (btn) { btn.disabled = true; btn.classList.add('opacity-70', 'cursor-not-allowed'); }

        if (navigator.onLine) {
            await sendRecordToServer(newRecord);
            const updatedRecord = { id: recordId, date: newRecord.date, farm, crop, exp, inc, pl: newRecord.pl, details: newRecord.details };
            if (appState.editingRecordId) updateRecordState('UPDATE_RECORD', updatedRecord); else updateRecordState('ADD_RECORD', updatedRecord);
            await Swal.fire({ icon: 'success', title: appState.editingRecordId ? 'अपडेट पूर्ण झाले!' : 'यशस्वी!', text: appState.editingRecordId ? 'नोंद यशस्वीरित्या अपडेट झाली.' : 'नोंद डेटाबेसमध्ये यशस्वीरित्या सेव्ह झाली.', timer: 2000, showConfirmButton: false });
        } else {
            await saveOfflineRecord(newRecord);
            const updatedRecord = { id: recordId, date: newRecord.date, farm, crop, exp, inc, pl: newRecord.pl, details: newRecord.details };
            if (appState.editingRecordId) updateRecordState('UPDATE_RECORD', updatedRecord); else updateRecordState('ADD_RECORD', updatedRecord);
            await Swal.fire({ icon: 'info', title: 'ऑफलाइन मोड', html: '<div class="text-left text-sm"><p class="mb-2">🌐 इंटरनेट कनेक्शन नाही!</p><p>नोंद स्थानिक संचयनमध्ये सेव्ह झाली आहे.</p><p class="text-xs text-slate-500 mt-2">नेटवर्क नंतर मिळताच ती अपलोड होईल.</p></div>', timer: 3000, showConfirmButton: false });
        }

        clearFormFields();
        renderHistory();
        renderCharts();
        generateInsights();
        updateAutoSuggestions();
    } catch (e) {
        await saveOfflineRecord(newRecord);
        Swal.fire({ icon: 'info', title: 'ऑफलाइन संचयन', html: `<div class="text-left text-sm"><p class="mb-2">नोंद स्थानिक संचयनात जतन झाली आहे.</p><p>नेटवर्क नंतर मिळताच ती अपलोड होईल.</p><p class="mt-2 text-xs text-slate-500">${escapeHTML(getFriendlyNetworkMessage(e))}</p></div>`, timer: 4000, showConfirmButton: false });
    } finally {
        updateRecordState('SET_EDITING_RECORD', null);
        if (btn) { btn.disabled = false; btn.classList.remove('opacity-70', 'cursor-not-allowed'); }
        if (btnText) btnText.innerText = originalText;
        document.getElementById('saveBtnText').innerText = 'डेटा सेव्ह करा';
    }
}

async function deleteRecord(event, recordId, date, farm) {
    const btn = event.target.closest('button');
    const origHtml = btn?.innerHTML || '';
    const result = await Swal.fire({
        title: 'खात्री आहे का?',
        html: `तारीख: <b>${new Date(date).toLocaleDateString('mr-IN')}</b><br>शेतकरी: <b>${escapeHTML(farm)}</b><br><br>ही नोंद कायमची हटवायची आहे का?`,
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#ef4444',
        cancelButtonColor: '#64748b',
        confirmButtonText: '<i class="fa-solid fa-trash"></i> होय, हटवा!',
        cancelButtonText: 'रद्द करा'
    });
    if (!result.isConfirmed) return;
    try {
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>'; btn.disabled = true; }
        await deleteRecordFromServer(recordId);
        // Use centralized state update instead of direct filter
        updateRecordState('DELETE_RECORD', recordId);
        await Swal.fire({ icon: 'success', title: 'हटवले!', text: 'नोंद कायमची हटवण्यात आली आहे.', timer: 1500, showConfirmButton: false });
    } catch (e) {
        Swal.fire('त्रुटी', 'हटवताना अडचण: ' + (e.message || e), 'error');
        if (btn) { btn.innerHTML = origHtml; btn.disabled = false; }
    }
}

async function initPhotoDB() {
    try {
        const photos = await getPhotoHistory();
        updateRecordState('SET_PHOTO_HISTORY', photos);
        renderPhotoHistory();
    } catch (error) {
        console.error('Photo DB error:', error);
        Swal.fire('त्रुटी', 'फोटो संग्रहण सुरू करताना अडचण आली: ' + (error.message || error), 'error');
    }
}

async function savePhotoToHistory(imageData, source) {
    const timestamp = new Date().toLocaleString('mr-IN');
    const farm = document.getElementById('farmName')?.value || 'अज्ञात';
    const crop = document.getElementById('cropName')?.value || 'अज्ञात';
    const photoEntry = { id: Date.now(), image: imageData, source, farm, crop, timestamp };
    try {
        await savePhotoEntry(photoEntry);
        await initPhotoDB();
    } catch (error) {
        console.error('Save photo failed:', error);
        Swal.fire('त्रुटी', 'फोटो सेव्ह करताना अडचण: ' + (error.message || error), 'error');
    }
}

function renderPhotoHistory() {
    const container = document.getElementById('photoHistoryContainer');
    const previewContainer = document.getElementById('photoPreview');
    if (!container) return;
    if (appState.photoHistory.length === 0) {
        container.innerHTML = '<p class="col-span-2 text-center text-slate-500 text-sm">अद्याप कोणताही फोटो नाही</p>';
        if (previewContainer) previewContainer.innerHTML = '';
        return;
    }
    container.innerHTML = '';
    if (previewContainer) previewContainer.innerHTML = '';
    appState.photoHistory.slice(0, 6).forEach(photo => {
        const thumbDiv = document.createElement('div');
        thumbDiv.className = 'relative group cursor-pointer rounded-lg overflow-hidden border-2 border-pink-200 hover:border-pink-500 transition-all';
        thumbDiv.innerHTML = `
            <img src="${photo.image}" class="w-full h-20 object-cover" alt="Photo">
            <div class="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-all flex items-center justify-center">
                <button data-action="view-photo" data-photo-id="${photo.id}" class="text-white text-xs bg-pink-600 px-2 py-1 rounded hover:bg-pink-700">
                    <i class="fa-solid fa-eye"></i>
                </button>
            </div>`;
        container.appendChild(thumbDiv);
    });
}

function viewPhotoDetails(photoId) {
    const photo = appState.photoHistory.find(p => p.id === photoId);
    if (!photo) return;
    Swal.fire({
        title: 'फोटो तपशील',
        html: `
            <img src="${photo.image}" style="max-width: 100%; border-radius: 8px; margin-bottom: 10px;">
            <div style="text-align: left; font-size: 13px;">
                <p><strong>स्रोत:</strong> ${escapeHTML(photo.source)}</p>
                <p><strong>शेतकरी:</strong> ${escapeHTML(photo.farm)}</p>
                <p><strong>पीक:</strong> ${escapeHTML(photo.crop)}</p>
                <p><strong>वेळ:</strong> ${escapeHTML(photo.timestamp)}</p>
            </div>`,
        showDenyButton: true,
        confirmButtonText: 'डाउनलोड',
        denyButtonText: 'डिलीट करा',
        cancelButtonText: 'बंद करा',
        showCancelButton: true
    }).then((result) => {
        if (result.isConfirmed) downloadPhoto(photo);
        else if (result.isDenied) deletePhoto(photoId);
    });
}

function downloadPhoto(photo) {
    const link = document.createElement('a');
    link.href = photo.image;
    link.download = `sheti_photo_${photo.id}_${new Date().toISOString().slice(0,10)}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
    Toast.fire({ icon: 'success', title: 'फोटो डाउनलोड झाला!' });
}

async function deletePhoto(photoId) {
    try {
        await deletePhotoEntry(photoId);
        await initPhotoDB();
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
        Toast.fire({ icon: 'success', title: 'फोटो डिलीट झाला!' });
    } catch (error) {
        console.error('Delete photo failed:', error);
        Swal.fire('त्रुटी', 'फोटो हटवताना अडचण: ' + (error.message || error), 'error');
    }
}

async function uploadPhotoFromGallery(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        Swal.fire('त्रुटी', 'कृपया फक्त इमेज फाईल निवडा!', 'error');
        return;
    }
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
    Toast.fire({ icon: 'info', title: 'फोटो कॉम्प्रेस केला जात आहे...' });
    try {
        const imageData = await compressImage(file);
        await savePhotoToHistory(imageData, 'गॅलरी');
        Toast.fire({ icon: 'success', title: 'फोटो गॅलरीतून जोडला!' });
    } catch (error) {
        console.error('Image compression failed:', error);
        Swal.fire('त्रुटी', 'फोटो प्रोसेस करताना अडचण आली. कृपया पुन्हा प्रयत्न करा.', 'error');
    }
    event.target.value = '';
}

function updateAutoSuggestions() {
    const recs = appState.records || [];
    const farms = [...new Set(recs.map(r => r.farm))].filter(Boolean);
    const crops = [...new Set(recs.map(r => r.crop))].filter(Boolean);
    const seeds = new Set();
    const ferts = new Set();
    const meds = new Set();
    recs.forEach(r => {
        const details = r.details || '';
        if (details.includes('बियाणे:')) {
            details.split('बियाणे:')[1].split('|')[0].split(',').forEach(s => { const name = s.trim().split(' (')[0]; if (name) seeds.add(name); });
        }
        if (details.includes('खत:')) {
            details.split('खत:')[1].split('|')[0].split(',').forEach(f => { const name = f.trim().split(' (')[0]; if (name) ferts.add(name); });
        }
        if (details.includes('औषधे:')) {
            details.split('औषधे:')[1].split('|')[0].split(',').forEach(m => { const name = m.trim().split(' (')[0]; if (name) meds.add(name); });
        }
    });
    const farmEl = document.getElementById('farmSuggestions'); if (farmEl) farmEl.innerHTML = farms.map(f => `<option value="${escapeHTML(f)}">`).join('');
    const cropEl = document.getElementById('cropSuggestions'); if (cropEl) cropEl.innerHTML = crops.map(c => `<option value="${escapeHTML(c)}">`).join('');
    const seedEl = document.getElementById('seedSuggestions'); if (seedEl) seedEl.innerHTML = [...seeds].map(s => `<option value="${escapeHTML(s)}">`).join('');
    const fertEl = document.getElementById('fertSuggestions'); if (fertEl) fertEl.innerHTML = [...ferts].map(f => `<option value="${escapeHTML(f)}">`).join('');
    const medEl = document.getElementById('medSuggestions'); if (medEl) medEl.innerHTML = [...meds].map(m => `<option value="${escapeHTML(m)}">`).join('');
    const filterEl = document.getElementById('filterSuggestions'); if (filterEl) filterEl.innerHTML = farms.map(f => `<option value="${escapeHTML(f)}">`).join('') + crops.map(c => `<option value="${escapeHTML(c)}">`).join('');
}

function renderHistory() {
    try {
        const filter = (document.getElementById('filterFarm')?.value || '').toLowerCase();
        // Reset to page 1 when filter changes
        if (filter !== appState.pagination.currentFilter) {
            appState.pagination.currentPage = 1;
        }
        // Render using pagination (30 items per page)
        renderHistoryPage(appState.pagination.currentPage, appState.pagination.itemsPerPage, filter);
    } catch (error) {
        console.error('Error rendering history:', error);
        Swal.fire('त्रुटी', 'इतिहास प्रदर्शित करताना अडचण: ' + (error.message || error), 'error');
    }
}

async function resetForm() {
    const result = await Swal.fire({
        title: 'फॉर्म क्लिअर करायचा?',
        text: 'तुमची भरलेली सर्व तात्पुरती माहिती नष्ट होईल.',
        icon: 'question',
        showCancelButton: true,
        confirmButtonColor: '#10b981',
        cancelButtonColor: '#64748b',
        confirmButtonText: 'होय, क्लिअर करा',
        cancelButtonText: 'रद्द करा'
    });
    if (!result.isConfirmed) return;
    clearFormFields();
    const emptyLists = { seed: [], fert: [], med: [], work: [], labour: [], income: [] };
    updateRecordState('SET_LISTS', emptyLists);
    Object.keys(emptyLists).forEach(type => renderList(type));
    updateCalculations();
    setNow();
    document.getElementById('photoPreview').innerHTML = '';
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
    Toast.fire({ icon: 'success', title: 'फॉर्म साफ झाला!' });
}

function exportToCSV() {
    const recs = appState.records || [];
    if (recs.length === 0) {
        Swal.fire('माहिती नाही', 'डाउनलोड करण्यासाठी कोणतीही नोंद उपलब्ध नाही.', 'info');
        return;
    }
    const safeCsvValue = (value) => {
        const str = value !== undefined && value !== null ? String(value) : '';
        const escaped = str.replace(/"/g, '""');
        return escaped.search(/[",\n]/) >= 0 ? `"${escaped}"` : escaped;
    };

    let csvContent = 'तारीख,शेतकरी,पीक,एकूण खर्च (Rs),एकूण उत्पन्न (Rs),निव्वळ नफा/तोटा (Rs),तपशील\n';
    recs.forEach(r => {
        const dateStr = new Date(r.date).toLocaleDateString('mr-IN');
        csvContent += [
            safeCsvValue(dateStr),
            safeCsvValue(r.farm),
            safeCsvValue(r.crop),
            safeCsvValue(r.exp),
            safeCsvValue(r.inc),
            safeCsvValue(r.pl),
            safeCsvValue(r.details)
        ].join(',') + '\n';
    });
    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Sheti_Diary_Pro_${new Date().toISOString().slice(0,10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
    Toast.fire({ icon: 'success', title: 'CSV फाईल डाउनलोड झाली!' });
}

const NOTO_SANS_MARATHI_TTF_BASE64 = '';

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

async function loadBase64FontData(fontPath) {
    const response = await fetch(fontPath);
    if (!response.ok) throw new Error(`Font फाईल लोड करण्यात अयश: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return arrayBufferToBase64(arrayBuffer);
}

async function ensureNotoSansMarathiFont(doc) {
    const fontName = 'NotoSansMarathi';
    try {
        if (typeof doc.addFileToVFS === 'function' && typeof doc.addFont === 'function') {
            if (NOTO_SANS_MARATHI_TTF_BASE64) {
                doc.addFileToVFS('NotoSansMarathi-Regular.ttf', NOTO_SANS_MARATHI_TTF_BASE64);
                doc.addFont('NotoSansMarathi-Regular.ttf', fontName, 'normal');
                doc.setFont(fontName);
                return;
            }
            if (typeof NOTO_SANS_MARATHI_TTF_BASE64 !== 'undefined' && NOTO_SANS_MARATHI_TTF_BASE64) {
                doc.addFileToVFS('NotoSansMarathi-Regular.ttf', NOTO_SANS_MARATHI_TTF_BASE64);
                doc.addFont('NotoSansMarathi-Regular.ttf', fontName, 'normal');
                doc.setFont(fontName);
            } else {
                // Local font not available; rely on default fonts.
                console.warn('Local Noto Sans Marathi font not available; using default PDF font.');
            }
        }
    } catch (error) {
        console.warn('Noto Sans Marathi jsPDF फॉन्ट लोड करू शकत नाही:', error);
    }
}

async function exportToPDF() {
    const recs = appState.records || [];
    if (recs.length === 0) {
        Swal.fire('माहिती नाही', 'PDF तयार करण्यासाठी कोणतीही नोंद उपलब्ध नाही.', 'info');
        return;
    }
    const tableWrapper = document.getElementById('historyTableWrapper');
    if (!tableWrapper) {
        Swal.fire('त्रुटी', 'PDF तयार करण्यासाठी टेबल विभाग सापडला नाही.', 'error');
        return;
    }
    await ensurePdfLibs();
    const { jsPDF } = window.jspdf;
    if (!jsPDF) {
        Swal.fire('त्रुटी', 'PDF लायब्ररी लोड करण्यात अडचण आली.', 'error');
        return;
    }
    const doc = new jsPDF('p', 'mm', 'a4');
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 10;
    await ensureNotoSansMarathiFont(doc);
    const loadingToast = Swal.fire({ title: 'PDF तयार करत आहे...', html: 'कृपया थोडावेळ प्रतीक्षा करा.', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); } });
    const originalStyles = {
        display: tableWrapper.style.display,
        position: tableWrapper.style.position,
        left: tableWrapper.style.left,
        top: tableWrapper.style.top,
        visibility: tableWrapper.style.visibility
    };
    const hadHiddenClass = tableWrapper.classList.contains('hidden');
    try {
        if (hadHiddenClass) tableWrapper.classList.remove('hidden');
        tableWrapper.style.position = 'absolute';
        tableWrapper.style.left = '-9999px';
        tableWrapper.style.top = '-9999px';
        tableWrapper.style.display = 'block';
        tableWrapper.style.visibility = 'visible';
        const canvas = await html2canvas(tableWrapper, { scale: 2, useCORS: true, backgroundColor: '#ffffff' });
        const imgData = canvas.toDataURL('image/png');
        const imgProps = doc.getImageProperties(imgData);
        const pdfWidth = pageWidth - margin * 2;
        const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
        const headerHeight = 15;
        const usableHeight = pageHeight - margin - headerHeight;
        doc.text('माझी शेती डायरी प्रो - रिपोर्ट', margin, margin + 5);
        doc.addImage(imgData, 'PNG', margin, margin + headerHeight, pdfWidth, pdfHeight);
        let heightLeft = pdfHeight - usableHeight;
        while (heightLeft > 0) {
            doc.addPage();
            const positionY = margin - (pdfHeight - heightLeft) + headerHeight;
            doc.addImage(imgData, 'PNG', margin, positionY, pdfWidth, pdfHeight);
            heightLeft -= usableHeight;
        }
        doc.save(`Sheti_Diary_Pro_${new Date().toISOString().slice(0,10)}.pdf`);
        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
        Toast.fire({ icon: 'success', title: 'PDF रिपोर्ट डाउनलोड झाला!' });
    } catch (error) {
        Swal.fire('त्रुटी', 'PDF तयार करण्यात अडचण: ' + (error.message || error), 'error');
    } finally {
        if (hadHiddenClass) tableWrapper.classList.add('hidden');
        tableWrapper.style.display = originalStyles.display;
        tableWrapper.style.position = originalStyles.position;
        tableWrapper.style.left = originalStyles.left;
        tableWrapper.style.top = originalStyles.top;
        tableWrapper.style.visibility = originalStyles.visibility;
        Swal.close();
    }
}

function renderCharts() {
    try {
        appState.expenseChartInstance?.destroy();
        appState.profitChartInstance?.destroy();
        if (!appState.records || appState.records.length === 0) return;
        const ctx1 = document.getElementById('expenseChart');
        if (!ctx1) return;
        const expenseData = appState.records.reduce((acc, r) => {
            const details = (r.details || '').toLowerCase();
            if (details.includes('बियाणे')) acc.seed += (r.exp || 0);
            if (details.includes('खत')) acc.fert += (r.exp || 0);
            if (details.includes('औषधे')) acc.med += (r.exp || 0);
            if (details.includes('यंत्र')) acc.work += (r.exp || 0);
            if (details.includes('मजुरी')) acc.labour += (r.exp || 0);
            if (!details.includes('बियाणे') && !details.includes('खत') && !details.includes('औषधे') && !details.includes('यंत्र') && !details.includes('मजुरी')) acc.other += (r.exp || 0);
            return acc;
        }, { seed: 0, fert: 0, med: 0, work: 0, labour: 0, other: 0 });
        const ctx1Context = ctx1.getContext('2d');
        appState.expenseChartInstance = new Chart(ctx1Context, {
            type: 'pie',
            data: {
                labels: ['बियाणे', 'खते', 'औषधे', 'यंत्र काम', 'मजुरी', 'इतर'],
                datasets: [{ data: [expenseData.seed, expenseData.fert, expenseData.med, expenseData.work, expenseData.labour, expenseData.other], backgroundColor: ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#6b7280'] }]
            },
            options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
        });
        const ctx2 = document.getElementById('profitChart');
        if (!ctx2) return;
        const sortedRecords = appState.records.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
        const labels = sortedRecords.map(r => new Date(r.date).toLocaleDateString('mr-IN', { month: 'short', day: 'numeric' }));
        const profits = sortedRecords.map(r => r.pl || 0);
        const ctx2Context = ctx2.getContext('2d');
        appState.profitChartInstance = new Chart(ctx2Context, {
            type: 'line',
            data: { labels, datasets: [{ label: 'निव्वळ नफा/तोटा (₹)', data: profits, borderColor: '#10b981', backgroundColor: 'rgba(16, 185, 129, 0.1)', fill: true }] },
            options: { responsive: true, scales: { y: { beginAtZero: true } } }
        });
    } catch (error) {
        console.error('Error rendering charts:', error);
    }
}

function generateInsights() {
    try {
        const insightsEl = document.getElementById('insights');
        if (!appState.records || appState.records.length === 0) {
            if (insightsEl) insightsEl.innerText = 'पुरेशा नोंदी नसल्याने सूचना उपलब्ध नाहीत.';
            return;
        }
        const totalExp = appState.records.reduce((s, r) => s + (r.exp || 0), 0);
        const totalInc = appState.records.reduce((s, r) => s + (r.inc || 0), 0);
        const avgProfit = appState.records.reduce((s, r) => s + (r.pl || 0), 0) / appState.records.length;
        const insights = [];
        if (avgProfit > 0) insights.push('तुमचा सरासरी नफा चांगला आहे. उत्पादन वाढवण्यासाठी गुंतवणूक वाढवण्याचा विचार करा.');
        else insights.push('तुम्हाला तोटा होत आहे. खर्च कमी करण्यासाठी किंवा उत्पन्न वाढवण्यासाठी धोरणे वापरा.');
        const recentRecords = appState.records.slice(-5);
        const recentAvgExp = recentRecords.reduce((s, r) => s + (r.exp || 0), 0) / recentRecords.length;
        if (recentAvgExp > totalExp / appState.records.length) insights.push('तुमचे अलीकडचे खर्च वाढले आहेत. बजेट नियंत्रण करा.');
        if (insightsEl) insightsEl.innerText = insights.join(' ');
    } catch (error) {
        console.error('Error generating insights:', error);
        const insightsEl = document.getElementById('insights');
        if (insightsEl) insightsEl.innerText = 'सूचना तयार करताना अडचण आली.';
    }
}

window.addEventListener('load', onLoad);

function promptForServiceWorkerUpdate(registration) {
    if (!registration || !registration.waiting) return;
    Swal.fire({
        title: 'नवीन अपडेट उपलब्ध आहे',
        text: 'अपडेट स्थापित करण्यासाठी कृपया पेज रिफ्रेश करा.',
        icon: 'info',
        showCancelButton: true,
        confirmButtonText: 'रीफ्रेश करा',
        cancelButtonText: 'नंतर',
        allowOutsideClick: false
    }).then(result => {
        if (result.isConfirmed) {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
    });
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js')
            .then(registration => {
                console.log('Service Worker यशस्वीरित्या रजिस्टर झाला! Scope:', registration.scope);
                if (registration.waiting) {
                    promptForServiceWorkerUpdate(registration);
                }
                registration.addEventListener('updatefound', () => {
                    if (registration.installing) {
                        registration.installing.addEventListener('statechange', () => {
                            if (registration.waiting) {
                                promptForServiceWorkerUpdate(registration);
                            }
                        });
                    }
                });
            })
            .catch(error => console.error('Service Worker रजिस्ट्रेशन फेल झाले:', error));
    });

    navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
    });
}

const installBtn = document.getElementById('installBtn');
window.addEventListener('beforeinstallprompt', function(event) {
    event.preventDefault();
    setState({ deferredInstallPrompt: event });
    installBtn?.classList.remove('hidden');
    installBtn?.setAttribute('aria-hidden', 'false');
    announceLiveMessage('अॅप इन्स्टॉल करण्याचा पर्याय उपलब्ध झाला आहे. कृपया इंस्टॉल करा बटणावर क्लिक करा.');
    console.log('PWA install prompt available');
});
installBtn?.addEventListener('click', async () => {
    const promptEvent = appState.deferredInstallPrompt;
    if (!promptEvent) {
        console.warn('Install prompt not available yet');
        return;
    }
    installBtn.disabled = true;
    promptEvent.prompt();
    try {
        const choiceResult = await promptEvent.userChoice;
        if (choiceResult.outcome === 'accepted') {
            console.log('User accepted the PWA install prompt');
        } else {
            console.log('User dismissed the PWA install prompt');
        }
    } catch (error) {
        console.error('PWA install prompt failed:', error);
    } finally {
        setState({ deferredInstallPrompt: null });
        installBtn?.classList.add('hidden');
        installBtn?.setAttribute('aria-hidden', 'true');
        installBtn.disabled = false;
    }
});
window.addEventListener('appinstalled', function () {
    console.log('PWA installed successfully');
    installBtn?.classList.add('hidden');
    installBtn?.setAttribute('aria-hidden', 'true');
});

(function(){
    const logo = document.getElementById('logoImg');
    if (!logo) return;
    const status = document.createElement('div');
    status.id = 'logoStatus';
    status.style.cssText = 'font-size:12px;font-weight:700;margin-top:6px';
    logo.parentNode.appendChild(status);
    let logoStatusChecked = false;
    function show(msg, color) {
        status.textContent = msg;
        status.style.color = color || '#fff';
        console.log('Logo status:', msg);
    }
    logo.addEventListener('load', function() { logoStatusChecked = true; show('Logo loaded: ' + logo.src, '#9AE6B4'); });
    logo.addEventListener('error', function() { logoStatusChecked = true; show('Logo failed to load: ' + logo.src, '#FCA5A5'); });
    if (logo.complete && logo.naturalWidth) { logoStatusChecked = true; show('Logo already loaded (cached): ' + logo.src, '#9AE6B4'); }
    setTimeout(function() {
        if (!logoStatusChecked && (!logo.complete || !logo.naturalWidth)) {
            show('Logo not loaded — check path/network and press Ctrl+F5', '#FEEBC8');
        }
    }, 5000);
})();
