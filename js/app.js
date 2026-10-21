import { APP_CONFIG } from './config.js';
import { MAX_ENTRIES, validateFile, validateEntry, getUploadUrl, isStoredResponse, formatFileSize, pendingEntries } from './validation.js?v=axv-lab-v1';

function selectionKey(file) {
  return JSON.stringify([file.name, file.size, file.type, file.lastModified]);
}

// A selection is atomic: never silently drop unsupported or excess files.
export function selectFilesForBatch(currentEntries, selectedFiles, maximum = MAX_ENTRIES) {
  const selected = Array.from(selectedFiles || []);
  const seen = new Set(currentEntries.map(entry => selectionKey(entry.file)));
  const files = [];
  let duplicates = 0;
  for (const file of selected) {
    const key = selectionKey(file);
    if (seen.has(key)) { duplicates += 1; continue; }
    const error = validateFile(file);
    if (error) return { files: [], duplicates: 0, error: `${file.name || 'File'}: ${error}` };
    seen.add(key);
    files.push(file);
  }
  if (currentEntries.length + files.length > maximum) {
    return { files: [], duplicates: 0, error: `Maksimal ${maximum} nota per sesi. Anda masih dapat menambahkan ${Math.max(0, maximum - currentEntries.length)} file. Pilih ulang file yang ingin ditambahkan.` };
  }
  return { files, duplicates, error: '' };
}

export function createUploadPayload(submissionId, entry, fileBase64) {
  return Object.freeze({
    schemaVersion: 2, uploadMode: 'original', submissionId, entryId: entry.id,
    originalFilename: entry.file.name, mimeType: entry.file.type,
    fileSize: entry.file.size, fileBase64,
  });
}

// One user action sends all pending files; each gets its own security token and
// verified acknowledgement. Confirmed files never enter a later retry batch.
export async function processUploadBatch(requestedEntries, uploadOne) {
  const batch = pendingEntries(requestedEntries);
  for (let index = 0; index < batch.length; index += 1) await uploadOne(batch[index], index, batch.length);
  return batch;
}

if (typeof document !== 'undefined') initializeReceiptForm();

function initializeReceiptForm() {
const $ = (selector, root = document) => root.querySelector(selector);
const ui = {
  form: $('#receipt-form'), entries: $('#entries'), template: $('#entry-template'),
  picker: $('#file-input'), dropzone: $('#dropzone'), chooseLabel: $('#choose-label'),
  count: $('#entry-count'), submit: $('#submit-all'), submitText: $('#submit-text'),
  feedback: $('#submission-feedback'), selectionFeedback: $('#selection-feedback'),
  summary: $('#results-summary'), savedFiles: $('#saved-files'), resultsCount: $('#results-count'),
  verification: $('#verification-panel'), verificationLabel: $('#verification-label'), turnstile: $('#turnstile-container'),
};
const uploadUrl = getUploadUrl(APP_CONFIG);
const submissionId = newId();
const entries = [];
let running = false;
let turnstileLoader = null;

function newId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function announce(message, error = false) {
  ui.feedback.textContent = message;
  ui.feedback.classList.toggle('is-error', error);
}

function selectionFeedback(message) {
  ui.selectionFeedback.textContent = message;
  ui.selectionFeedback.hidden = !message;
}

function setStatus(entry, status, description, progress) {
  entry.status = status;
  entry.element.dataset.status = status;
  const badge = $('.status-badge', entry.element);
  badge.dataset.status = status;
  badge.textContent = { waiting: 'Siap diunggah', verifying: 'Memverifikasi', uploading: 'Mengunggah', success: 'Berhasil', error: 'Gagal' }[status];
  $('.status-description', entry.element).textContent = description;
  const progressBox = $('.entry-progress', entry.element);
  progressBox.hidden = !['verifying', 'uploading'].includes(status);
  const meter = $('progress', progressBox);
  if (typeof progress === 'number') meter.value = progress;
  else meter.removeAttribute('value');
  $('.progress-text', progressBox).textContent = status === 'verifying' ? 'Menunggu pemeriksaan keamanan…' : typeof progress === 'number' && progress < 100 ? `Mengirim file… ${progress}%` : 'Menyimpan dan memeriksa file serta data…';
  const saved = $('.saved-filename', entry.element);
  saved.hidden = status !== 'success';
  saved.textContent = entry.savedFilename ? `Tersimpan: ${entry.savedFilename}` : '';
  refreshControls();
}

function refreshControls() {
  entries.forEach(entry => {
    const remove = $('.remove-entry', entry.element);
    remove.setAttribute('aria-label', `Hapus ${entry.file.name} dari daftar`);
    // A sent file retains its identity, even if its acknowledgement was lost.
    remove.hidden = entry.attempted || entry.status === 'success';
    remove.disabled = running;
    $('.entry-lock-note', entry.element).hidden = !entry.attempted || entry.status === 'success';
    const retry = $('.retry-entry', entry.element);
    retry.hidden = entry.status !== 'error' || entry.retryable === false;
    retry.disabled = running || !uploadUrl;
    retry.setAttribute('aria-label', `Coba unggah ${entry.file.name} lagi`);
  });
  ui.count.textContent = `${entries.length} dari ${MAX_ENTRIES} nota`;
  ui.picker.disabled = running || entries.length >= MAX_ENTRIES;
  ui.dropzone.setAttribute('aria-disabled', String(ui.picker.disabled));
  ui.chooseLabel.textContent = entries.length >= MAX_ENTRIES ? 'Batas 10 nota tercapai' : entries.length ? 'Tambah file nota' : 'Pilih beberapa file nota';
  const pending = pendingEntries(entries);
  const onlyRetries = pending.length > 0 && pending.every(entry => entry.status === 'error');
  ui.submit.disabled = running || !uploadUrl || pending.length === 0;
  ui.submitText.textContent = running ? 'Sedang mengunggah…' : onlyRetries ? `Coba lagi ${pending.length} nota` : pending.length ? `Unggah semua nota (${pending.length})` : entries.some(entry => entry.status === 'error') ? 'Periksa nota yang gagal' : entries.length ? 'Semua nota berhasil diunggah' : 'Unggah semua nota (0)';
  ui.submit.setAttribute('aria-busy', String(running));
  ui.form.setAttribute('aria-busy', String(running));
}

function updateSummary() {
  const successful = entries.filter(entry => entry.status === 'success');
  const failed = entries.filter(entry => entry.status === 'error');
  ui.summary.hidden = successful.length === 0 && failed.length === 0;
  ui.resultsCount.textContent = `${successful.length} nota berhasil diunggah${failed.length ? `, ${failed.length} gagal` : ''}.`;
  ui.savedFiles.replaceChildren();
  successful.forEach(entry => {
    const item = document.createElement('li');
    item.textContent = entry.savedFilename;
    ui.savedFiles.append(item);
  });
}

function announceReady() {
  const ready = entries.filter(entry => entry.status === 'waiting').length;
  const success = entries.filter(entry => entry.status === 'success').length;
  const errors = entries.filter(entry => entry.status === 'error').length;
  announce(errors ? `${success} nota berhasil diunggah, ${errors} gagal.${ready ? ` ${ready} nota siap diunggah.` : ' Silakan coba lagi untuk nota yang gagal.'}` : ready ? `${ready} nota siap diunggah.` : success ? `${success} nota berhasil diunggah.` : 'Pilih file nota untuk mulai mengunggah.', errors > 0);
}

function addFile(file) {
  const fragment = ui.template.content.cloneNode(true);
  const element = $('.receipt-file', fragment);
  const entry = { id: newId(), uploadMode: 'original', element, file, previewUrl: null, status: 'waiting', attempted: false, frozenPayload: null, retryable: true };
  element.id = `entry-${entry.id}`;
  const name = $('.original-filename', element);
  name.id = `filename-${entry.id}`;
  name.textContent = file.name;
  element.setAttribute('aria-labelledby', name.id);
  $('.file-size', element).textContent = formatFileSize(file.size);
  const image = $('.preview-image', element);
  image.hidden = file.type === 'application/pdf';
  $('.pdf-preview', element).hidden = file.type !== 'application/pdf';
  if (file.type !== 'application/pdf') {
    entry.previewUrl = URL.createObjectURL(file);
    image.src = entry.previewUrl;
  }
  $('.remove-entry', element).addEventListener('click', () => {
    if (running || entry.attempted) return;
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    entries.splice(entries.indexOf(entry), 1);
    element.remove();
    refreshControls(); updateSummary(); announceReady();
    ui.picker.focus();
  });
  $('.retry-entry', element).addEventListener('click', () => startUpload([entry]));
  entries.push(entry);
  ui.entries.append(fragment);
  setStatus(entry, 'waiting', '');
}

function appendFiles(selectedFiles) {
  if (running) return;
  const selection = selectFilesForBatch(entries, selectedFiles);
  if (selection.error) { selectionFeedback(selection.error); return; }
  selection.files.forEach(addFile);
  selectionFeedback(selection.duplicates ? `${selection.duplicates} file yang sudah ada dalam daftar tidak ditambahkan ulang.` : '');
  refreshControls(); announceReady();
}

function loadTurnstile() {
  if (window.turnstile?.render) return Promise.resolve();
  if (turnstileLoader) return turnstileLoader;
  turnstileLoader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) { script.remove(); turnstileLoader = null; reject(error); }
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('Pemeriksaan keamanan tidak dapat dimuat. Periksa koneksi atau pemblokir konten, lalu coba lagi.')), 20000);
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.async = true;
    script.defer = true;
    script.onload = () => finish(window.turnstile?.render ? null : new Error('Pemeriksaan keamanan tidak tersedia. Muat ulang halaman setelah menyimpan informasi yang diperlukan.'));
    script.onerror = () => finish(new Error('Pemeriksaan keamanan gagal dimuat. Periksa koneksi atau pemblokir konten, lalu coba lagi.'));
    document.head.append(script);
  });
  return turnstileLoader;
}

async function getTurnstileToken(entry) {
  ui.verification.hidden = false;
  ui.verificationLabel.textContent = `Pemeriksaan keamanan untuk Nota ${entries.indexOf(entry) + 1}. Ikuti petunjuk jika diminta.`;
  await loadTurnstile();
  return new Promise((resolve, reject) => {
    let widgetId;
    let settled = false;
    const finish = (error, token) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { if (widgetId !== undefined) window.turnstile.remove(widgetId); } catch { /* A failed widget cleanup must not trap this upload. */ }
      ui.turnstile.replaceChildren();
      if (error) reject(error);
      else resolve(token);
    };
    const timeout = setTimeout(() => finish(new Error('Pemeriksaan keamanan terlalu lama. Coba lagi dan selesaikan pemeriksaan yang ditampilkan.')), 120000);
    try {
      widgetId = window.turnstile.render(ui.turnstile, {
        sitekey: APP_CONFIG.turnstileSiteKey,
        action: 'receipt_upload', cData: entry.id,
        size: window.innerWidth < 380 ? 'compact' : 'normal',
        execution: 'execute', appearance: 'interaction-only', retry: 'never',
        'refresh-expired': 'manual',
        callback: token => finish(null, token),
        'error-callback': () => { finish(new Error('Pemeriksaan keamanan gagal. Periksa koneksi, lalu coba lagi.')); return true; },
        'expired-callback': () => finish(new Error('Pemeriksaan keamanan kedaluwarsa. Coba unggah nota lagi.')),
        'timeout-callback': () => finish(new Error('Waktu pemeriksaan keamanan habis. Coba lagi.')),
        'unsupported-callback': () => finish(new Error('Browser ini tidak mendukung pemeriksaan keamanan. Gunakan browser terbaru.')),
      });
      window.turnstile.execute(widgetId);
    } catch { finish(new Error('Pemeriksaan keamanan tidak dapat dimulai. Coba lagi.')); }
  });
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      if (comma < 0) { reject(new Error('File tidak dapat dibaca. Pilih file kembali.')); return; }
      resolve(result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error('File tidak dapat dibaca. Pastikan file masih tersedia, lalu coba lagi.'));
    reader.onabort = () => reject(new Error('Pembacaan file terhenti. Coba lagi.'));
    // Read bytes directly. Do not draw to canvas, recompress, or convert formats.
    reader.readAsDataURL(file);
  });
}

function sendUpload(entry, payload) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', uploadUrl);
    xhr.timeout = 240000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = event => {
      const progress = event.lengthComputable ? Math.min(100, Math.round(event.loaded / event.total * 100)) : undefined;
      setStatus(entry, 'uploading', progress === 100 ? 'File terkirim. Menunggu konfirmasi penyimpanan dan data…' : 'Mengirim file nota…', progress);
    };
    xhr.onload = () => {
      let response;
      try { response = JSON.parse(xhr.responseText); } catch {
        reject(new Error('Jawaban server tidak dapat dipastikan. Coba lagi dengan file ini agar file tidak tersimpan dua kali.'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && isStoredResponse(response, payload)) { resolve(response); return; }
      if (response?.ok === false && response.error && typeof response.error.message === 'string') {
        const error = new Error(response.error.message.slice(0, 500));
        error.retryable = response.error.retryable !== false;
        reject(error);
      } else reject(new Error('Penyimpanan belum dapat dikonfirmasi. Coba lagi dengan file ini agar tidak membuat salinan.'));
    };
    xhr.onerror = () => reject(new Error('Koneksi terputus atau layanan tidak terjangkau. Coba lagi dengan file yang sama; file yang sudah tersimpan tidak akan digandakan.'));
    xhr.ontimeout = () => reject(new Error('Server belum memberi konfirmasi. Coba lagi dengan file yang sama untuk memeriksa atau melanjutkan penyimpanan.'));
    xhr.onabort = () => reject(new Error('Pengiriman terhenti. Coba lagi menggunakan file ini.'));
    // From this point onward, always retain the exact same entry ID and payload.
    entry.attempted = true;
    refreshControls();
    xhr.send(JSON.stringify(payload));
  });
}

async function uploadEntry(entry) {
  try {
    entry.retryable = true;
    setStatus(entry, 'verifying', 'Menyiapkan file dan memeriksa keamanan…');
    if (!entry.frozenPayload) {
      const fileBase64 = await readFileBase64(entry.file);
      entry.frozenPayload = createUploadPayload(submissionId, entry, fileBase64);
    }
    const token = await getTurnstileToken(entry);
    ui.verification.hidden = true;
    setStatus(entry, 'uploading', 'Mengirim file nota…', 0);
    const result = await sendUpload(entry, { ...entry.frozenPayload, turnstileToken: token });
    entry.savedFilename = result.savedFilename;
    entry.frozenPayload = null;
    setStatus(entry, 'success', result.replayed ? 'Penyimpanan sebelumnya telah dikonfirmasi. Tidak ada salinan baru.' : 'File dan data nota berhasil disimpan.');
  } catch (error) {
    entry.retryable = error.retryable !== false;
    if (!entry.attempted) entry.frozenPayload = null;
    const message = error.message || 'Unggahan gagal. Coba lagi.';
    setStatus(entry, 'error', entry.retryable ? message : `${message} Hubungi pengelola; file ini tidak dapat dikirim ulang.`);
  } finally {
    ui.verification.hidden = true;
    updateSummary();
  }
}

async function startUpload(requestedEntries) {
  if (running) return;
  if (!uploadUrl) { announce('Pengunggahan belum aktif. Hubungi pengelola formulir.', true); return; }
  const batch = pendingEntries(requestedEntries);
  if (!batch.length) return;
  for (const entry of batch) {
    const errors = validateEntry(entry);
    if (Object.keys(errors).length) {
      announce(errors.file || 'File tidak dapat diunggah. Pilih file nota yang valid.', true);
      return;
    }
  }
  running = true;
  selectionFeedback('');
  refreshControls();
  try {
    await processUploadBatch(batch, async (entry, index, count) => {
      announce(`Mengunggah ${entry.file.name}. ${index} dari ${count} nota pada pengiriman ini selesai.`);
      await uploadEntry(entry);
    });
  } finally {
    running = false;
    refreshControls(); updateSummary(); announceReady();
  }
}

ui.picker.addEventListener('click', () => { ui.picker.value = ''; });
ui.picker.addEventListener('change', () => appendFiles(ui.picker.files));
['dragenter', 'dragover'].forEach(name => ui.dropzone.addEventListener(name, event => {
  event.preventDefault();
  if (!running && entries.length < MAX_ENTRIES) ui.dropzone.classList.add('drag-over');
}));
['dragleave', 'drop'].forEach(name => ui.dropzone.addEventListener(name, event => {
  event.preventDefault(); ui.dropzone.classList.remove('drag-over');
}));
ui.dropzone.addEventListener('drop', event => appendFiles(event.dataTransfer?.files));
ui.form.addEventListener('submit', event => { event.preventDefault(); startUpload(entries); });
window.addEventListener('beforeunload', event => {
  if (running || entries.some(entry => entry.status !== 'success')) {
    event.preventDefault(); event.returnValue = '';
  }
});
// Prevent accidental file drops from navigating away from this form.
window.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
$('#config-notice').hidden = Boolean(uploadUrl);
refreshControls();
}
