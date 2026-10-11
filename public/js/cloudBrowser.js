// A screenshot view of the official browser running on the school's host.
// Login text stays in memory only, and closing the view stops every frame request.
export function browserPoint(event, bounds, viewport) {
  const { width, height } = viewport || {};
  if (!(bounds?.width > 0 && bounds?.height > 0 && width > 0 && height > 0)) return null;
  const x = (event.clientX - bounds.left) * width / bounds.width;
  const y = (event.clientY - bounds.top) * height / bounds.height;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) return null;
  return { x: Math.min(width - 1, Math.floor(x)), y: Math.min(height - 1, Math.floor(y)) };
}

export function createBrowserPoller({ read, apply, onError, isVisible = () => true, interval = 1250, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const delay = Math.max(1000, interval);
  let epoch = 0, timer, controller;
  function stop() { epoch++; clearTimer(timer); controller?.abort(); controller = null; }
  function start() {
    stop();
    const current = epoch;
    controller = new AbortController();
    const signal = controller.signal;
    async function poll() {
      try {
        if (isVisible()) {
          const frame = await read(signal);
          if (current === epoch && !signal.aborted) apply(frame);
        }
      } catch (error) {
        if (current === epoch && !signal.aborted) onError(error);
      } finally {
        if (current === epoch && !signal.aborted) timer = setTimer(poll, delay);
      }
    }
    poll();
  }
  return { start, stop };
}

// A closed dialog cannot launch after validation or display a late login response.
export function createBrowserLogin({ prepare, start, close, onPending, onReady, onError }) {
  let epoch = 0, pending = null, closing = Promise.resolve(), dispatched = false;
  function begin() {
    if (pending) return pending;
    const current = ++epoch;
    onPending();
    pending = (async () => {
      try {
        await closing;
        if (current !== epoch) return;
        await prepare();
        if (current !== epoch) return;
        dispatched = true;
        await start();
        if (current === epoch) onReady();
      } catch (error) { if (current === epoch) onError(error); }
    })();
    const attempt = pending;
    attempt.finally(() => { if (pending === attempt) pending = null; });
    return attempt;
  }
  function end(notifyBackend = true) {
    epoch++;
    const attempt = pending;
    pending = null;
    const previous = closing;
    closing = (async () => {
      await previous;
      await attempt;
      if (dispatched) { dispatched = false; if (notifyBackend) await close().catch(() => {}); }
    })();
    return closing;
  }
  return { begin, end };
}

export function mountCloudBrowser({ request, beforeStart = async () => {}, onAuthRequired = () => {}, onClose = () => {} }) {
  const dialog = document.getElementById('cloud-browser');
  const image = document.getElementById('cloud-browser-image');
  const status = document.getElementById('cloud-browser-status');
  const origin = document.getElementById('cloud-browser-origin');
  const errorBox = document.getElementById('cloud-browser-error');
  const input = document.getElementById('cloud-browser-text');
  const form = document.getElementById('cloud-browser-form');
  const retry = document.getElementById('cloud-browser-retry');
  const controls = [...dialog.querySelectorAll('[data-browser-action], [data-browser-key], #cloud-browser-send')];
  let viewport, imageUrl, inputController, sending = false, opened = false;

  function showError(error) { errorBox.textContent = error.message || 'تعذر تحديث نافذة الوزارة. ستُعاد محاولة عرض الصفحة تلقائيًا.'; errorBox.hidden = false; }
  function revokeFrame() { if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; image.removeAttribute('src'); }
  function updateControls() { controls.forEach(button => { button.disabled = sending || !viewport; }); image.setAttribute('aria-busy', String(sending)); }

  const poller = createBrowserPoller({
    isVisible: () => opened && !document.hidden,
    async read(signal) {
      const state = await request('/auth/browser/state', { cache: 'no-store', signal });
      if (!state.available) return { state };
      const response = await fetch('/api/auth/browser/frame', { credentials: 'same-origin', cache: 'no-store', signal });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const error = new Error(data.error || 'تعذر عرض صفحة الوزارة.');
        error.status = response.status;
        throw error;
      }
      return { state, blob: await response.blob() };
    },
    apply({ state, blob }) {
      viewport = state.available ? { width: state.width, height: state.height } : null;
      origin.textContent = state.origin || (state.status === 'error' ? 'لم يكتمل الاتصال' : 'جارٍ فتح الموقع الرسمي…');
      status.textContent = state.status === 'error' ? 'لم يكتمل فتح صفحة الوزارة.' : state.available ? 'اضغط على الخانة داخل الصفحة، ثم اكتب بياناتك في الحقل أسفلها.' : ['opening', 'waiting'].includes(state.status) ? 'جارٍ فتح صفحة تسجيل الدخول الرسمية…' : 'صفحة الوزارة غير مفتوحة. يمكنك إعادة المحاولة.';
      if (blob) { const previous = imageUrl; imageUrl = URL.createObjectURL(blob); image.src = imageUrl; image.hidden = false; if (previous) URL.revokeObjectURL(previous); }
      else { image.hidden = true; revokeFrame(); }
      errorBox.hidden = state.status !== 'error';
      if (state.status === 'error') showError({ message: state.message });
      retry.hidden = state.available && state.status !== 'error';
      form.hidden = !state.available;
      updateControls();
    },
    onError(error) {
      viewport = null; updateControls(); showError(error);
      if (error.status === 401 || error.status === 403) { closeView(false); onAuthRequired(); }
    },
  });

  const login = createBrowserLogin({
    prepare: beforeStart,
    start: () => request('/auth/microsoft/start', { method: 'POST', body: '{}' }),
    close: () => request('/auth/browser/close', { method: 'POST', body: '{}' }),
    onPending() {
      poller.stop(); viewport = null; updateControls(); errorBox.hidden = true;
      retry.hidden = false; retry.disabled = true;
      image.hidden = true; revokeFrame(); form.hidden = true;
      origin.textContent = 'جارٍ الاتصال بالموقع الرسمي…';
      status.textContent = 'جارٍ تجهيز نافذة تسجيل الدخول… قد يستغرق الاتصال بضع ثوانٍ.';
    },
    onReady() { retry.disabled = false; form.hidden = false; poller.start(); },
    onError(error) {
      retry.disabled = false; status.textContent = 'تعذر فتح صفحة الوزارة.';
      origin.textContent = 'لم يكتمل الاتصال'; showError(error);
      if (error.status === 401 || error.status === 403) { closeView(); onAuthRequired(); }
    },
  });

  async function act(action) {
    if (!opened || sending || !viewport) return;
    sending = true; errorBox.hidden = true; updateControls();
    const controller = inputController;
    try { await request('/auth/browser/input', { method: 'POST', body: JSON.stringify(action), signal: controller.signal }); }
    catch (error) { if (opened && !controller.signal.aborted) { showError(error); if (error.status === 401 || error.status === 403) { closeView(false); onAuthRequired(); } } }
    finally { sending = false; if (opened) updateControls(); }
  }
  function closeView(notifyBackend = true) {
    if (!opened) return;
    opened = false; poller.stop(); inputController?.abort(); input.value = ''; viewport = null; revokeFrame();
    if (dialog.open) dialog.close();
    login.end(notifyBackend);
    onClose();
  }
  function open() {
    if (opened) return;
    opened = true; inputController = new AbortController(); viewport = null; sending = false;
    errorBox.hidden = true; image.hidden = true; input.value = ''; origin.textContent = 'جارٍ فتح الموقع الرسمي…'; status.textContent = 'جارٍ تحميل صفحة الوزارة…';
    updateControls(); dialog.showModal(); login.begin();
  }

  retry.addEventListener('click', () => login.begin());
  document.getElementById('cloud-browser-close').addEventListener('click', () => closeView());
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeView(); });
  dialog.addEventListener('close', () => { if (opened) closeView(); });
  image.addEventListener('click', event => {
    const point = browserPoint(event, image.getBoundingClientRect(), viewport);
    if (point) act({ action: 'click', ...point });
  });
  image.addEventListener('keydown', event => {
    if (['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      // Tab keeps navigating the local controls; its explicit button goes to the official page.
      if (event.key === 'Tab') return;
      event.preventDefault(); act({ action: 'press', key: event.key });
    }
  });
  dialog.querySelectorAll('[data-browser-action]').forEach(button => button.addEventListener('click', () => act({ action: button.dataset.browserAction, ...(button.dataset.browserAction === 'wheel' ? { deltaX: 0, deltaY: Number(button.dataset.browserScroll) } : {}) })));
  dialog.querySelectorAll('[data-browser-key]').forEach(button => button.addEventListener('click', () => act({ action: 'press', key: button.dataset.browserKey })));
  document.getElementById('cloud-browser-secret').addEventListener('change', event => { input.type = event.target.checked ? 'password' : 'text'; });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!input.value || sending || !viewport) return;
    const text = input.value; input.value = '';
    act({ action: 'text', text });
  });
  window.addEventListener('pagehide', () => closeView(false));
  return { open, close: (notifyBackend = true) => closeView(notifyBackend), get isOpen() { return opened; } };
}
