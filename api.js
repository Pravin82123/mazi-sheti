export const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzYCOruRzujaRHIdZvaagjUJDibUs_G74bfagywlqU01j3FTz-krLZwzms7vlHVJQAc/exec";

export async function parseResponseBody(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch (ignore) {
        return text;
    }
}

export function isSuccessfulResponse(result) {
    if (typeof result === 'string') {
        const normalized = result.trim().toLowerCase();
        if (!normalized) return false;
        if (/error|failed|invalid|unauthorized/.test(normalized)) return false;
        return ['success', 'ok', 'saved', 'true'].includes(normalized) || true;
    }
    if (!result) return false;
    return Boolean(
        result.success ||
        result.status === 'success' ||
        result.status === 'ok' ||
        result.result === 'success' ||
        result.result === 'ok' ||
        result.saved === true
    );
}

export function getFriendlyNetworkMessage(error) {
    if (!navigator.onLine) {
        return 'इंटरनेट कनेक्शन उपलब्ध नाही. कृपया कनेक्शन तपासा आणि पुन्हा प्रयत्न करा.';
    }
    if (error && error.message) {
        const msg = error.message;
        if (/Access-Control-Allow-Origin|CORS|Failed to fetch/i.test(msg)) {
            return 'CORS अडथळा किंवा नेटवर्क अडण टाळण्यासाठी, अॅप HTTP/HTTPS वरून चालवा आणि Google Apps Script मध्ये Access-Control-Allow-Origin सक्षम करा.';
        }
        return msg;
    }
    return 'सर्व्हरची अज्ञात त्रुटी आली.';
}

export async function assertOkResponse(response) {
    if (response.ok) {
        return response;
    }

    let body = await response.text();
    try {
        const json = JSON.parse(body);
        body = json.message || json.error || body;
    } catch (ignore) {}

    throw new Error(`सर्व्हर त्रुटी ${response.status}: ${body}`);
}

export async function sendRecordToServer(record) {
    const response = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=utf-8' },
        body: JSON.stringify(record)
    });
    await assertOkResponse(response);

    if (response.status === 204) {
        return true;
    }

    const result = await parseResponseBody(response);
    if (result === '' || result === null || result === undefined) {
        return true;
    }

    if (typeof result === 'string') {
        const normalized = result.trim().toLowerCase();
        if (normalized === 'success' || normalized === 'ok' || normalized === 'saved' || normalized === 'true') {
            return true;
        }
        if (/error|failed|invalid|unauthorized/.test(normalized)) {
            throw new Error(result);
        }
        return true;
    }

    if (result && (result.success || result.status === 'success' || result.status === 'ok')) {
        return true;
    }
    throw new Error(result && (result.message || result.error) ? (result.message || result.error) : 'सर्व्हरवर सेव्ह केली जाऊ शकले नाही.');
}

export async function deleteRecordFromServer(recordId) {
    const response = await fetch(SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=utf-8' },
        body: JSON.stringify({ action: 'delete', id: recordId })
    });
    await assertOkResponse(response);
    const result = await parseResponseBody(response);
    if (result === '' || result === null || result === undefined || isSuccessfulResponse(result)) {
        return true;
    }
    throw new Error(result.message || result.error || 'हटवण्यात अपयश');
}

export async function syncRecordWithRetry(record, retries = 3) {
    let lastError;
    let delay = 1000;
    for (let attempt = 1; attempt <= retries; attempt++) {
        if (!navigator.onLine) {
            throw new Error('offline');
        }
        try {
            await sendRecordToServer(record);
            return true;
        } catch (err) {
            lastError = err;
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
            }
        }
    }
    throw lastError;
}

export async function fetchSheetRecords() {
    const response = await fetch(SCRIPT_URL);
    await assertOkResponse(response);
    const rawData = await parseResponseBody(response);
    const data = Array.isArray(rawData)
        ? rawData
        : (rawData && Array.isArray(rawData.data) ? rawData.data :
           rawData && Array.isArray(rawData.values) ? rawData.values : []);
    return data;
}
