import { APP_CONFIG } from './config.js';
import { CATEGORIES, MAX_ENTRIES, validateFile, validateEntry, getUploadUrl, isStoredResponse, formatFileSize, pendingEntries } from './validation.js';

const $ = (selector, root = document) => root.querySelector(selector);
const ui = {
  form: $('#receipt-form'), entries: $('#entries'), template: $('#entry-template'),
  add: $('#add-entry'), count: $('#entry-count'), submit: $('#submit-all'),
  submitText: $('#submit-text'), feedback: $('#submission-feedback'),
  summary: $('#results-summary'), savedFiles: $('#saved-files'), resultsCount: $('#results-count'),
  verification: $('#verification-panel'), verificationLabel: $('#verification-label'),
  turnstile: $('#turnstile-container'),
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

function fieldError(entry, field, message) {
  const element = $(`.${field}-error`, entry.element);
  element.textContent = message;
  element.hidden = !message;
  const wrapper = $(`.${field === 'file' ? 'upload' : field}-field`, entry.element);
  wrapper.classList.toggle('has-error', Boolean(message));
  const targets = field === 'type' ? wrapper.querySelectorAll('input') : [$(field === 'category' ? 'select' : field === 'notes' ? 'textarea' : '.pick-file', wrapper)];
  targets.forEach(target => {
    if (message) target.setAttribute('aria-invalid', 'true');
    else target.removeAttribute('aria-invalid');
  });
}

function validateCard(entry) {
  const errors = validateEntry(entry);
  ['type', 'category', 'notes', 'file'].forEach(field => fieldError(entry, field, errors[field] || ''));
  return Object.keys(errors).length === 0;
}

function setStatus(entry, status, description, progress) {
  entry.status = status;
  entry.element.dataset.status = status;
  const badge = $('.status-badge', entry.element);
  badge.dataset.status = status;
  badge.textContent = { waiting: 'Menunggu', verifying: 'Memverifikasi', uploading: 'Mengunggah', success: 'Berhasil', error: 'Gagal' }[status];
  $('.status-description', entry.element).textContent = description;
  const progressBox = $('.entry-progress', entry.element);
  progressBox.hidden = !['verifying', 'uploading'].includes(status);
  const meter = $('progress', progressBox);
  if (typeof progress === 'number') meter.value = progress;
  else meter.removeAttribute('value');
  $('.progress-text', progressBox).textContent = status === 'verifying' ? 'Menunggu pemeriksaan keamanan…' : typeof progress === 'number' && progress < 100 ? `Mengirim file… ${progress}%` : 'Menyimpan dan memeriksa file serta data…';
  const saved = $('.saved-filename', entry.element);
  saved.hidden = status !== 'success';
  saved.textContent = entry.savedFilename || '';
  refreshControls();
}

function refreshControls() {
  entries.forEach((entry, index) => {
    const number = index + 1;
    $('h3', entry.element).textContent = `Nota ${number}`;
    $('.receipt-number', entry.element).textContent = String(number).padStart(2, '0');
    const remove = $('.remove-entry', entry.element);
    remove.setAttribute('aria-label', `Hapus Nota ${number}`);
    remove.disabled = running || entry.attempted || entries.length === 1;
    const locked = running || entry.attempted;
    entry.element.querySelectorAll('input, select, textarea, .pick-file, .camera-button, .replace-file, .clear-file').forEach(control => { control.disabled = locked; });
    $('.dropzone', entry.element).setAttribute('aria-disabled', String(locked));
    $('.entry-lock-note', entry.element).hidden = !entry.attempted || entry.status === 'success';
    const retry = $('.retry-entry', entry.element);
    retry.hidden = entry.status !== 'error' || entry.retryable === false;
    retry.disabled = running || !uploadUrl;
    retry.setAttribute('aria-label', `Coba unggah Nota ${number} lagi`);
  });
  ui.count.textContent = `${entries.length} dari ${MAX_ENTRIES}`;
  ui.add.disabled = running || entries.length >= MAX_ENTRIES;
  const pending = pendingEntries(entries);
  ui.submit.disabled = running || !uploadUrl || pending.length === 0;
  ui.submitText.textContent = running ? 'Sedang Mengirim…' : pending.length ? `Unggah ${pending.length} Nota` : entries.some(entry => entry.status === 'error') ? 'Periksa Nota yang Gagal' : 'Semua Nota Berhasil Diunggah';
  ui.submit.setAttribute('aria-busy', String(running));
}

function updateSummary() {
  const successful = entries.filter(entry => entry.status === 'success');
  ui.summary.hidden = successful.length === 0;
  ui.resultsCount.textContent = `${successful.length} dari ${entries.length} nota berhasil disimpan beserta datanya.`;
  ui.savedFiles.replaceChildren();
  successful.forEach(entry => {
    const item = document.createElement('li');
    item.textContent = entry.savedFilename;
    ui.savedFiles.append(item);
  });
}

function setFile(entry, file) {
  if (running || entry.attempted) return;
  const error = validateFile(file);
  if (error) {
    if (entry.file) clearFile(entry);
    fieldError(entry, 'file', error);
    return;
  }
  if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entry.file = file;
  entry.previewUrl = null;
  entry.frozenPayload = null;
  $('.dropzone', entry.element).hidden = true;
  $('.file-preview', entry.element).hidden = false;
  $('.original-filename', entry.element).textContent = file.name;
  $('.file-size', entry.element).textContent = formatFileSize(file.size);
  const image = $('.preview-image', entry.element);
  image.hidden = file.type === 'application/pdf';
  $('.pdf-preview', entry.element).hidden = file.type !== 'application/pdf';
  image.removeAttribute('src');
  if (file.type !== 'application/pdf') {
    entry.previewUrl = URL.createObjectURL(file);
    image.src = entry.previewUrl;
  }
  fieldError(entry, 'file', '');
  setStatus(entry, 'waiting', 'File siap. Lengkapi pilihan, lalu unggah nota.');
}

function clearFile(entry) {
  if (running || entry.attempted) return;
  if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entry.file = null;
  entry.previewUrl = null;
  entry.frozenPayload = null;
  $('.preview-image', entry.element).removeAttribute('src');
  $('.file-preview', entry.element).hidden = true;
  $('.dropzone', entry.element).hidden = false;
  $('.file-input', entry.element).value = '';
  $('.camera-input', entry.element).value = '';
  fieldError(entry, 'file', '');
  setStatus(entry, 'waiting', 'Pilih file nota Anda.');
  $('.pick-file', entry.element).focus();
}

function addEntry(focus = false) {
  if (running || entries.length >= MAX_ENTRIES) return;
  const fragment = ui.template.content.cloneNode(true);
  const element = $('.receipt-card', fragment);
  const id = newId();
  element.id = `entry-${id}`;
  const entry = { id, element, receiptType: '', receiptCategory: '', notes: '', file: null, previewUrl: null, status: 'waiting', attempted: false, frozenPayload: null, retryable: true, savedFilename: '' };
  $('h3', element).id = `heading-${id}`;
  element.setAttribute('aria-labelledby', `heading-${id}`);
  ['type', 'category', 'notes', 'file'].forEach(field => { $(`.${field}-error`, element).id = `${field}-error-${id}`; });
  element.querySelectorAll('.type-option input').forEach(input => {
    input.name = `type-${id}`;
    input.required = true;
    input.setAttribute('aria-describedby', `type-error-${id}`);
    input.addEventListener('change', () => { entry.receiptType = input.value; fieldError(entry, 'type', ''); });
  });
  const category = $('.category-select', element);
  category.id = `category-${id}`;
  category.setAttribute('aria-describedby', `category-error-${id}`);
  $('.category-label', element).htmlFor = category.id;
  CATEGORIES.forEach(([value, text]) => category.add(new Option(text, value)));
  category.addEventListener('change', () => {
    entry.receiptCategory = category.value;
    $('.notes-field', element).hidden = category.value !== 'nota_lain_lain';
    fieldError(entry, 'category', '');
  });
  const notes = $('.notes-input', element);
  notes.id = `notes-${id}`;
  notes.setAttribute('aria-describedby', `notes-error-${id}`);
  $('.notes-label', element).htmlFor = notes.id;
  notes.addEventListener('input', () => { entry.notes = notes.value; fieldError(entry, 'notes', ''); });
  const picker = $('.file-input', element);
  const camera = $('.camera-input', element);
  picker.setAttribute('aria-label', 'Pilih file nota');
  camera.setAttribute('aria-label', 'Ambil foto nota');
  $('.upload-label', element).id = `upload-label-${id}`;
  $('.pick-file', element).setAttribute('aria-describedby', `file-error-${id}`);
  $('.pick-file', element).setAttribute('aria-labelledby', `upload-label-${id}`);
  const openPicker = () => { picker.value = ''; picker.click(); };
  $('.pick-file', element).addEventListener('click', openPicker);
  $('.replace-file', element).addEventListener('click', openPicker);
  $('.camera-button', element).addEventListener('click', () => { camera.value = ''; camera.click(); });
  [picker, camera].forEach(input => input.addEventListener('change', () => { if (input.files?.length) setFile(entry, input.files[0]); }));
  $('.clear-file', element).addEventListener('click', () => clearFile(entry));
  const dropzone = $('.dropzone', element);
  ['dragenter', 'dragover'].forEach(event => dropzone.addEventListener(event, ev => {
    ev.preventDefault();
    if (!running && !entry.attempted) dropzone.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach(event => dropzone.addEventListener(event, ev => { ev.preventDefault(); dropzone.classList.remove('drag-over'); }));
  dropzone.addEventListener('drop', ev => {
    if (running || entry.attempted) return;
    if (ev.dataTransfer.files.length !== 1) { fieldError(entry, 'file', 'Pilih satu file untuk setiap kartu nota. Tambahkan kartu untuk file berikutnya.'); return; }
    setFile(entry, ev.dataTransfer.files[0]);
  });
  $('.remove-entry', element).addEventListener('click', () => {
    if (running || entry.attempted || entries.length <= 1) return;
    const index = entries.indexOf(entry);
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    entries.splice(index, 1);
    element.remove();
    refreshControls();
    updateSummary();
    $('.type-option input', entries[Math.min(index, entries.length - 1)].element).focus();
    announce(`Nota dihapus. ${entries.length} kartu nota tersedia.`);
  });
  $('.retry-entry', element).addEventListener('click', () => startUpload([entry]));
  entries.push(entry);
  ui.entries.append(fragment);
  refreshControls();
  updateSummary();
  if (focus) { $('.type-option input', element).focus(); announce(`Nota ${entries.length} ditambahkan.`); }
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
    xhr.timeout = 150000;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = event => {
      const progress = event.lengthComputable ? Math.min(100, Math.round(event.loaded / event.total * 100)) : undefined;
      setStatus(entry, 'uploading', progress === 100 ? 'File terkirim. Menunggu konfirmasi penyimpanan dan data…' : 'Mengirim file nota…', progress);
    };
    xhr.onload = () => {
      let response;
      try { response = JSON.parse(xhr.responseText); } catch {
        reject(new Error('Jawaban server tidak dapat dipastikan. Coba lagi dengan kartu ini agar file tidak tersimpan dua kali.'));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && isStoredResponse(response, payload)) { resolve(response); return; }
      if (response?.ok === false && response.error && typeof response.error.message === 'string') {
        const error = new Error(response.error.message.slice(0, 500));
        error.retryable = response.error.retryable !== false;
        reject(error);
      } else reject(new Error('Penyimpanan belum dapat dikonfirmasi. Coba lagi dengan kartu ini agar tidak membuat salinan.'));
    };
    xhr.onerror = () => reject(new Error('Koneksi terputus atau layanan tidak terjangkau. Coba lagi dengan kartu yang sama; file yang sudah tersimpan tidak akan digandakan.'));
    xhr.ontimeout = () => reject(new Error('Server belum memberi konfirmasi. Coba lagi dengan kartu yang sama untuk memeriksa atau melanjutkan penyimpanan.'));
    xhr.onabort = () => reject(new Error('Pengiriman terhenti. Coba lagi menggunakan kartu ini.'));
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
      entry.frozenPayload = Object.freeze({
        submissionId, entryId: entry.id,
        receiptType: entry.receiptType, receiptCategory: entry.receiptCategory,
        notes: entry.receiptCategory === 'nota_lain_lain' ? entry.notes.trim() : '',
        originalFilename: entry.file.name, mimeType: entry.file.type, fileSize: entry.file.size, fileBase64,
      });
    }
    const token = await getTurnstileToken(entry);
    ui.verification.hidden = true;
    setStatus(entry, 'uploading', 'Mengirim file nota…', 0);
    const result = await sendUpload(entry, { ...entry.frozenPayload, turnstileToken: token });
    entry.savedFilename = result.savedFilename;
    // Confirmed entries can never be resent; release their large base64 copy.
    entry.frozenPayload = null;
    setStatus(entry, 'success', result.replayed ? 'Penyimpanan sebelumnya telah dikonfirmasi. Tidak ada salinan baru.' : 'File dan data nota berhasil disimpan.');
  } catch (error) {
    entry.retryable = error.retryable !== false;
    if (!entry.attempted) entry.frozenPayload = null;
    const message = error.message || 'Unggahan gagal. Coba lagi.';
    setStatus(entry, 'error', entry.retryable ? message : `${message} Hubungi pengelola; kartu ini tidak dapat dikirim ulang.`);
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
  // Check every included card before a batch. Do not send a partial batch when
  // another included card is incomplete. Successful cards stay untouched.
  let firstInvalid = null;
  entries.filter(entry => entry.status !== 'success').forEach(entry => {
    if (!validateCard(entry) && !firstInvalid) firstInvalid = entry;
  });
  if (firstInvalid) {
    announce('Lengkapi jenis, kategori, dan file pada setiap kartu sebelum mengunggah.', true);
    $('[aria-invalid="true"]', firstInvalid.element)?.focus();
    return;
  }
  running = true;
  refreshControls();
  let completed = 0;
  for (const entry of batch) {
    announce(`Memproses Nota ${entries.indexOf(entry) + 1}. ${completed} dari ${batch.length} nota pada pengiriman ini selesai.`);
    await uploadEntry(entry);
    completed += 1;
  }
  running = false;
  refreshControls();
  updateSummary();
  const failed = entries.filter(entry => entry.status === 'error');
  const successes = entries.filter(entry => entry.status === 'success').length;
  if (failed.length) announce(`${successes} nota berhasil disimpan, ${failed.length} nota gagal. Periksa pesan pada kartu yang gagal dan gunakan Coba lagi jika tersedia.`, true);
  else announce(`Nota berhasil dikirim! ${successes} nota telah disimpan beserta datanya.`);
}

ui.add.addEventListener('click', () => addEntry(true));
ui.form.addEventListener('submit', event => { event.preventDefault(); startUpload(entries); });
window.addEventListener('beforeunload', event => {
  if (running || entries.some(entry => entry.status !== 'success' && (entry.file || entry.attempted))) {
    event.preventDefault();
    event.returnValue = '';
  }
});
// Prevent an accidental dropped file from navigating away from the form.
window.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
$('#config-notice').hidden = Boolean(uploadUrl);
addEntry();
