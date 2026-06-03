export let ocrExtractedData = {
    text: '',
    amounts: [],
    selectedAmount: null
};
export let cropperInstance = null;
export let currentImageData = null;

// Tesseract Worker Singleton Pattern
let tesseractWorker = null;
let tesseractInitialized = false;
let tesseractInitializing = false;

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

async function ensureTesseractLib() {
    if (window.Tesseract) return;
    await loadScriptElement('https://cdn.jsdelivr.net/npm/tesseract.js@5.0.4/dist/tesseract.min.js');
    if (!window.Tesseract) {
        throw new Error('Tesseract.js लायब्ररी लोड करण्यात अयश.');
    }
}

function isTesseractWorker(worker) {
    return worker && typeof worker.recognize === 'function' && typeof worker.terminate === 'function';
}

async function resetTesseractWorker() {
    if (tesseractWorker && isTesseractWorker(tesseractWorker)) {
        try {
            await tesseractWorker.terminate();
        } catch (terminatorError) {
            console.warn('Tesseract worker terminate error:', terminatorError);
        }
    }
    tesseractWorker = null;
    tesseractInitialized = false;
}

async function createSafeTesseractWorker() {
    if (typeof Tesseract === 'undefined') {
        await ensureTesseractLib();
    }
    if (typeof Tesseract === 'undefined' || typeof Tesseract.createWorker !== 'function') {
        throw new Error('Tesseract.createWorker उपलब्ध नाही.');
    }

    const worker = await Tesseract.createWorker();
    if (!isTesseractWorker(worker)) {
        if (worker && typeof worker.terminate === 'function') {
            await worker.terminate();
        }
        throw new Error('Tesseract worker अवैध ऑब्जेक्ट परतवतो.');
    }

    return worker;
}

/**
 * Initializes Tesseract Worker as Singleton (one-time initialization)
 * Call this once when app loads to prepare worker for background OCR scanning
 */
export async function initializeTesseractWorker() {
    if (tesseractInitialized || tesseractInitializing) return;
    
    tesseractInitializing = true;
    try {
        if (typeof Tesseract === 'undefined') {
            await ensureTesseractLib();
        }
        if (typeof Tesseract === 'undefined') {
            throw new Error('Tesseract.js लायब्ररी लोड होत नाही.');
        }

        if (tesseractWorker && !isTesseractWorker(tesseractWorker)) {
            await resetTesseractWorker();
        }

        tesseractWorker = await createSafeTesseractWorker();
        if (typeof tesseractWorker.load === 'function') {
            await tesseractWorker.load();
        }
        if (typeof tesseractWorker.loadLanguage === 'function') {
            await tesseractWorker.loadLanguage('mar+eng');
        }
        if (typeof tesseractWorker.initialize === 'function') {
            await tesseractWorker.initialize('mar+eng');
        }

        tesseractInitialized = true;
        console.log('✓ Tesseract Worker successfully initialized in background');
    } catch (error) {
        console.error('Failed to initialize Tesseract Worker:', error);
        await resetTesseractWorker();
    } finally {
        tesseractInitializing = false;
    }
}

export function createImageFromFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = reader.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

export async function compressImage(file, maxDimension = 1024, quality = 0.75) {
    if (window.Compressor) {
        return new Promise((resolve, reject) => {
            new Compressor(file, {
                quality: quality,
                maxWidth: maxDimension,
                maxHeight: maxDimension,
                convertSize: Infinity,
                checkOrientation: true,
                success(result) {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(result);
                },
                error(err) {
                    console.warn('CompressorJS failed, falling back to canvas resize:', err);
                    reject(err);
                }
            });
        }).catch(async () => {
            return await compressImageFallback(file, maxDimension, quality);
        });
    }
    return await compressImageFallback(file, maxDimension, quality);
}

export async function compressImageFallback(file, maxDimension = 1024, quality = 0.75) {
    const img = await createImageFromFile(file);
    let width = img.width;
    let height = img.height;

    if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);

    const compressedData = canvas.toDataURL('image/jpeg', quality);
    canvas.width = 0;
    canvas.height = 0;

    if (compressedData.length > file.size * 1.05) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }
    return compressedData;
}

export async function openCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        Swal.fire('ब्राउझर समर्थन नाही', 'तुमच्या मोबाइल ब्राऊझरमध्ये कॅमेरा API ला समर्थन नाही. कृपया Chrome, Firefox किंवा Edge वापरा.', 'warning');
        return;
    }

    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        Swal.fire('सुरक्षित कनेक्शन आवश्यक', 'कॅमेरा ऍक्सेससाठी HTTPS किंवा स्थानिक सर्व्हर आवश्यक आहे. ही फाईल थेट "file://" वरून चालवल्यास कॅमेरा काम करणार नाही.', 'warning');
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        Swal.fire({
            title: 'कॅमेरा',
            html: `<video id="cameraVideo" style="width: 100%; max-width: 400px; border-radius: 8px;" playsinline muted autoplay></video>
                   <div style="margin-top: 10px; text-align: center;">
                       <button id="capturePhoto" class="swal2-confirm swal2-styled" style="background-color: #06b6d4;">📸 फोटो काढा</button>
                   </div>`,
            showConfirmButton: false,
            showCancelButton: true,
            cancelButtonText: 'रद्द करा',
            allowOutsideClick: false,
            didOpen: (modal) => {
                const cameraVideo = modal.querySelector('#cameraVideo');
                const captureBtn = modal.querySelector('#capturePhoto');
                cameraVideo.srcObject = stream;
                cameraVideo.play().catch(() => {});

                captureBtn.addEventListener('click', () => {
                    if (cameraVideo.videoWidth === 0 || cameraVideo.videoHeight === 0) {
                        Swal.showValidationMessage('कृपया कॅमेरासाठी प्रतीक्षा करा...');
                        return;
                    }
                    canvas.width = cameraVideo.videoWidth;
                    canvas.height = cameraVideo.videoHeight;
                    context.drawImage(cameraVideo, 0, 0, canvas.width, canvas.height);
                    const imageData = canvas.toDataURL('image/jpeg', 0.9);
                    canvas.width = 0;
                    canvas.height = 0;
                    stream.getTracks().forEach(track => track.stop());
                    Swal.close();
                    processOCRImage(imageData);
                });
            },
            willClose: () => {
                stream.getTracks().forEach(track => track.stop());
            }
        });
    } catch (error) {
        const message = (error && error.name === 'NotAllowedError')
            ? 'कॅमेरा वापरण्यास अनुमती देण्यात आली नाही. कृपया ब्राउझर सेटिंग्जमध्ये कॅमेरा परवानगी द्या.'
            : 'कॅमेरा अॅक्सेस करताना त्रुटी: ' + (error.message || error.name);
        Swal.fire('त्रुटी', message, 'error');
    }
}

export async function handleOCRImage(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
        const reader = new FileReader();
        reader.onload = async (event) => {
            const imageData = event.target.result;
            const compressedImage = await compressImage(file, 1200, 0.85);
            processOCRImage(compressedImage || imageData);
        };
        reader.readAsDataURL(file);
    } catch (error) {
        Swal.fire('त्रुटी', 'चित्र लोड करण्यात अडचण: ' + error.message, 'error');
    }
}

export function initCropper(imageData) {
    const ocrImage = document.getElementById('ocrImage');
    if (!ocrImage) return;
    if (cropperInstance) {
        cropperInstance.destroy();
        cropperInstance = null;
    }
    ocrImage.src = imageData;
    currentImageData = imageData;

    ocrImage.onload = () => {
        cropperInstance = new Cropper(ocrImage, {
            autoCropArea: 0.8,
            responsive: true,
            restore: true,
            guides: true,
            center: true,
            highlight: true,
            cropBoxMovable: true,
            cropBoxResizable: true,
            toggleDragModeOnDblclick: true,
            viewMode: 1,
            aspectRatio: NaN,
            minContainerHeight: 300,
            minCanvasHeight: 250,
            minCropBoxHeight: 100,
            minCropBoxWidth: 100,
            backgroundColor: '#f0f0f0',
            autoCrop: true,
            modal: true,
            background: true,
            checkImageOrientation: true
        });
    };
}

export function rotateCropImage(degree = 90) {
    if (!cropperInstance) return;
    cropperInstance.rotate(degree);
}

export function resetCropImage() {
    if (!cropperInstance) return;
    cropperInstance.reset();
}

export async function confirmCrop() {
    if (!cropperInstance) {
        Swal.fire('त्रुटी', 'क्रॉपर इनिशियलाइझ नाही झाला.', 'error');
        return;
    }

    try {
        const canvas = cropperInstance.getCroppedCanvas({
            maxWidth: 1000,
            maxHeight: 1000,
            imageSmoothingEnabled: true,
            imageSmoothingQuality: 'high'
        });

        const croppedImageData = canvas.toDataURL('image/jpeg', 0.9);
        cropperInstance.destroy();
        cropperInstance = null;

        const preview = document.getElementById('ocrPreview');
        if (preview) preview.classList.add('hidden');

        processOCRWithCroppedImage(croppedImageData);
    } catch (error) {
        Swal.fire('त्रुटी', 'क्रॉप करताना अडचण: ' + error.message, 'error');
    }
}

export function skipCropping() {
    if (!currentImageData) {
        Swal.fire('त्रुटी', 'चित्र डेटा सापडला नाही.', 'error');
        return;
    }

    if (cropperInstance) {
        cropperInstance.destroy();
        cropperInstance = null;
    }

    const preview = document.getElementById('ocrPreview');
    if (preview) preview.classList.add('hidden');

    const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 1500 });
    Toast.fire({
        icon: 'info',
        title: 'संपूर्ण फोटो वापरत आहे...'
    });

    processOCRWithCroppedImage(currentImageData);
}

export function processOCRImage(imageData) {
    const preview = document.getElementById('ocrPreview');
    const results = document.getElementById('ocrResults');
    if (preview) preview.classList.remove('hidden');
    if (results) results.classList.add('hidden');
    initCropper(imageData);
}

export async function processOCRWithCroppedImage(croppedImageData) {
    const processing = document.getElementById('ocrProcessing');
    const results = document.getElementById('ocrResults');
    const statusElement = document.getElementById('ocrStatus');
    const progressElement = document.getElementById('ocrProgress');
    const ocrButtons = document.querySelectorAll('#ocrAutoFillBtn, #ocrClearBtn, #ocrCropConfirmBtn, #ocrSkipCropBtn, #ocrRotateBtn, #ocrResetCropBtn');

    if (processing) processing.classList.remove('hidden');
    if (results) results.classList.add('hidden');
    if (statusElement) statusElement.innerText = 'OCR प्रक्रिया चालू आहे... कृपया पेज बंद करू नका.';
    if (progressElement) progressElement.style.width = '0%';

    ocrButtons.forEach(btn => { if (btn) btn.disabled = true; });

    try {
        // Ensure Tesseract library is available
        if (typeof Tesseract === 'undefined') {
            await ensureTesseractLib();
        }
        if (typeof Tesseract === 'undefined') {
            throw new Error('Tesseract.js लायब्ररी लोड होत नाही. कृपया इंटरनेट कनेक्शन तपासा.');
        }

        // Use singleton worker or safely create a new one if not initialized
        let worker = tesseractWorker;
        if (!worker || !tesseractInitialized || !isTesseractWorker(worker)) {
            if (worker) {
                await resetTesseractWorker();
            }
            if (statusElement) statusElement.innerText = 'Tesseract Worker तयार होत आहे...';
            worker = await createSafeTesseractWorker();

            if (typeof worker.load === 'function') {
                await worker.load();
            }
            if (typeof worker.loadLanguage === 'function') {
                await worker.loadLanguage('mar+eng');
            }
            if (typeof worker.initialize === 'function') {
                await worker.initialize('mar+eng');
            }

            tesseractWorker = worker;
            tesseractInitialized = true;
        } else {
            // Reusing singleton worker - much faster!
            if (statusElement) statusElement.innerText = 'मजकूर वाचत आहे... कृपया पेज बंद ठेव.';
            if (progressElement) progressElement.style.width = '30%';
        }

        const { data } = await worker.recognize(croppedImageData);
        const recognizedText = data.text;

        const amounts = extractAmountsFromText(recognizedText);
        ocrExtractedData.text = recognizedText;
        ocrExtractedData.amounts = amounts;
        ocrExtractedData.selectedAmount = amounts.length > 0 ? amounts[0].value : null;

        displayOCRResults(recognizedText, amounts);
        if (processing) processing.classList.add('hidden');
        if (results) results.classList.remove('hidden');

        const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
        Toast.fire({ icon: 'success', title: `यशस्वी!`, text: `${amounts.length} रक्कम सापडल्या!` });
    } catch (error) {
        console.error('OCR Error:', error);
        Swal.fire('OCR त्रुटी', error.message || 'मजकूर वाचताना अडचण आली.', 'error');
    } finally {
        if (processing) processing.classList.add('hidden');
        ocrButtons.forEach(btn => { if (btn) btn.disabled = false; });
    }
}

export function extractAmountsFromText(text) {
    const amounts = [];
    const patterns = [
        /₹\s*([0-9]{1,}(?:[0-9,]*[0-9])?(?:\.[0-9]{1,2})?)/g,
        /rs\.?\s*([0-9]{1,}(?:[0-9,]*[0-9])?(?:\.[0-9]{1,2})?)/gi,
        /रु\s*([0-9]{1,}(?:[0-9,]*[0-9])?(?:\.[0-9]{1,2})?)/g,
        /रुपये?\s*([0-9]{1,}(?:[0-9,]*[0-9])?(?:\.[0-9]{1,2})?)/gi,
        /\b([0-9]{3,}(?:[0-9,]*[0-9])?(?:\.[0-9]{1,2})?)\b/g
    ];

    const foundAmounts = new Set();

    patterns.forEach(pattern => {
        let match;
        while ((match = pattern.exec(text)) !== null) {
            let numStr = match[1].replace(/,/g, '');
            const num = parseFloat(numStr);
            if (num >= 10 && num <= 1000000) {
                foundAmounts.add(num);
            }
        }
    });

    return Array.from(foundAmounts)
        .map(value => ({
            value: value,
            display: '₹' + value.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
        }))
        .sort((a, b) => b.value - a.value);
}

export function displayOCRResults(text, amounts) {
    const ocrText = document.getElementById('ocrText');
    const ocrAmounts = document.getElementById('ocrAmounts');
    if (ocrText) ocrText.innerText = text.substring(0, 500) + (text.length > 500 ? '...' : '');

    if (!ocrAmounts) return;
    ocrAmounts.innerHTML = amounts.slice(0, 5).map((amount, index) => `
        <label class="flex items-center p-2 bg-white border border-blue-100 rounded-lg cursor-pointer hover:bg-blue-50 transition">
            <input type="radio" name="ocrAmount" value="${amount.value}" ${index === 0 ? 'checked' : ''} class="mr-2">
            <span class="font-bold text-lg text-blue-600">${amount.display}</span>
        </label>
    `).join('');

    ocrAmounts.innerHTML += `
        <div class="p-2 bg-white border border-gray-200 rounded-lg">
            <label class="text-xs font-bold text-gray-700 block mb-1">किंवा हाताने टाइप करा:</label>
            <div class="flex gap-2">
                <span class="text-lg font-bold text-gray-400">₹</span>
                <input type="number" id="ocrManualAmount" min="0" step="0.01" class="flex-1 input-field text-sm h-8" placeholder="0.00">
            </div>
        </div>
    `;
}

export function autoFillFromOCR() {
    const fieldSelect = document.getElementById('ocrFieldSelect');
    if (!fieldSelect) return;
    const selectedField = fieldSelect.value;

    if (!selectedField) {
        Swal.fire('निवड आवश्यक', 'कृपया क्षेत्र निवडा.', 'warning');
        return;
    }

    let amountToFill = parseFloat(document.getElementById('ocrManualAmount')?.value) || ocrExtractedData.selectedAmount;
    if (!amountToFill || amountToFill <= 0) {
        Swal.fire('रक्कम आवश्यक', 'कृपया रक्कम निवडा किंवा टाइप करा.', 'warning');
        return;
    }

    try {
        if (selectedField === 'manual') {
            document.getElementById('sName')?.focus();
            const Toast = Swal.mixin({ toast: true, position: 'top-end', showConfirmButton: false, timer: 2000 });
            Toast.fire({ icon: 'info', title: 'OCR मजकूर तपासा', text: ocrExtractedData.text.substring(0, 100) + '...' });
        } else if (['seed', 'fert', 'med'].includes(selectedField)) {
            const pre = selectedField === 'seed' ? 's' : (selectedField === 'fert' ? 'f' : 'm');
            const productName = extractProductName(ocrExtractedData.text, selectedField);
            document.getElementById(pre + 'Name').value = productName || 'पावतीवरून ओळखलेले';
            document.getElementById(pre + 'Qty').value = '1';
            document.getElementById(pre + 'Unit').value = 'बॅग';
            document.getElementById(pre + 'Rate').value = Math.round(amountToFill);
            document.getElementById(pre + 'Name').focus();
            Swal.fire('भरले!', `${selectedField === 'seed' ? 'बियाणे' : selectedField === 'fert' ? 'खते' : 'औषधे'} क्षेत्र दर ₹${Math.round(amountToFill)} सह भरले गेले.`, 'success');
        } else if (selectedField === 'labour' || selectedField === 'work') {
            if (selectedField === 'labour') {
                document.getElementById('labourRate').value = Math.round(amountToFill);
                document.getElementById('labourTask').focus();
                Swal.fire('भरले!', `मजुरी दर ₹${Math.round(amountToFill)}/दिवस सह भरले गेले.`, 'success');
            } else {
                document.getElementById('workRate').value = Math.round(amountToFill);
                document.getElementById('workQty').focus();
                document.getElementById('workUnit').value = 'पांड';
                Swal.fire('भरले!', `यंत्र दर ₹${Math.round(amountToFill)}/एकक सह भरले गेले.`, 'success');
            }
        }
        updateCalculations();
    } catch (error) {
        Swal.fire('त्रुटी', 'डेटा भरताना अडचण: ' + error.message, 'error');
    }
}

export function extractProductName(text, type) {
    const lines = text.split('\n').filter(l => l.trim().length > 2);
    const keywords = {
        seed: ['बियाणे', 'बीज', 'seed', 'बीजांची'],
        fert: ['खत', 'खाद', 'fertilizer', 'खतीचे', 'खाद्य', 'NPK', 'DAP', 'यूरिया'],
        med: ['औषधे', 'दवा', 'pesticide', 'स्प्रे', 'fungicide', 'insecticide']
    };
    const keywords_list = keywords[type] || [];
    for (let line of lines) {
        for (let keyword of keywords_list) {
            if (line.toLowerCase().includes(keyword.toLowerCase())) {
                return line.substring(0, 30).trim();
            }
        }
    }
    for (let line of lines) {
        if (!/^\d+/.test(line) && line.length > 3) {
            return line.substring(0, 30).trim();
        }
    }
    return null;
}

export function clearOCRResults() {
    document.getElementById('ocrResults')?.classList.add('hidden');
    document.getElementById('ocrPreview')?.classList.add('hidden');
    const upload = document.getElementById('ocrReceiptUpload');
    if (upload) upload.value = '';
    if (cropperInstance) {
        cropperInstance.destroy();
        cropperInstance = null;
    }
    ocrExtractedData.text = '';
    ocrExtractedData.amounts = [];
    ocrExtractedData.selectedAmount = null;
}
