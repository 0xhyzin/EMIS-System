const STORAGE_KEY = 'school-register.assistant.history.v1';
const MAX_SAVED_MESSAGES = 30;
const MAX_API_HISTORY = 12;
const MAX_IMAGE_BYTES = 900 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const byId = id => document.getElementById(id);

function storedHistory() {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(item => item && ['user', 'assistant'].includes(item.role) && typeof item.content === 'string')
      .slice(-MAX_SAVED_MESSAGES).map(item => ({ role: item.role, content: item.content.slice(0, 1500) }));
  } catch { return []; }
}

function saveHistory(messages) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(messages.slice(-MAX_SAVED_MESSAGES))); }
  catch { /* Keep the chat usable when browser storage is unavailable. */ }
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('تعذر قراءة الصورة. اختاري صورة أخرى.')); };
    image.src = url;
  });
}

function toBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('تعذر تجهيز الصورة للإرسال.'));
    reader.readAsDataURL(blob);
  });
}

async function prepareImage(file) {
  if (!ALLOWED_IMAGE_TYPES.has(file?.type)) throw new Error('اختاري صورة PNG أو JPG أو WebP.');
  if (file.size > 18 * 1024 * 1024) throw new Error('الصورة كبيرة جدًا. اختاري صورة أصغر من 18 ميجابايت.');
  const image = await loadImage(file);
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('المتصفح لا يستطيع تجهيز الصورة.');
  let blob;
  for (const edge of [1280, 1100, 900, 720]) {
    const scale = Math.min(1, edge / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.72, 0.58]) {
      blob = await toBlob(canvas, quality);
      if (blob && blob.size <= MAX_IMAGE_BYTES) break;
    }
    if (blob && blob.size <= MAX_IMAGE_BYTES) break;
  }
  if (!blob || blob.size > MAX_IMAGE_BYTES) throw new Error('تعذر تصغير الصورة بما يكفي. جرّبي صورة أصغر.');
  return { name: file.name || 'صورة مرفقة', mimeType: 'image/jpeg', dataBase64: await toBase64(blob), url: URL.createObjectURL(blob) };
}

function appendText(parent, tag, value, className = '') {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function timeLabel() {
  return new Intl.DateTimeFormat('ar-EG', { hour: 'numeric', minute: '2-digit' }).format(new Date());
}

export function mountAssistantChat({ request, send, isLocalAccess, getExportFormat = () => 'word', onDataChanged, toast }) {
  const view = byId('view-assistant');
  const chat = view.querySelector('.assistant-chat');
  const messages = byId('assistant-messages');
  const form = byId('assistant-form');
  const input = byId('assistant-input');
  const imageInput = byId('assistant-image');
  const sendButton = byId('assistant-send');
  const newChatButton = byId('assistant-new-chat');
  const keyPanel = byId('assistant-key-panel');
  const keyInput = byId('assistant-key');
  const keyForm = byId('assistant-key-form');
  const manageKey = byId('assistant-manage-key');
  const removeKey = byId('assistant-remove-key');
  const inlineError = byId('assistant-inline-error');
  const preview = byId('assistant-image-preview');
  let history = storedHistory();
  let attachment = null;
  let busy = false;
  let available = false;
  let configured = false;
  let everChecked = false;
  let chatEpoch = 0;
  const usedImageUrls = new Set();

  function showError(message) {
    inlineError.textContent = message;
    inlineError.hidden = false;
  }
  function clearError() { inlineError.hidden = true; inlineError.textContent = ''; }
  function scrollDown() { messages.scrollTop = messages.scrollHeight; }
  function updateSend() { sendButton.disabled = busy || !available; newChatButton.disabled = busy; }

  function addMessage(role, content, { imageUrl = null, loading = false } = {}) {
    messages.querySelector('.assistant-welcome')?.remove();
    const row = document.createElement('div');
    row.className = `assistant-message ${role}`;
    const avatar = appendText(row, 'span', role === 'assistant' ? '✦' : 'م', 'assistant-message-avatar');
    avatar.setAttribute('aria-hidden', 'true');
    const bubble = document.createElement('div');
    bubble.className = 'assistant-bubble';
    if (imageUrl) {
      const image = document.createElement('img');
      image.className = 'assistant-message-image';
      image.src = imageUrl;
      image.alt = 'الصورة المرفقة';
      bubble.append(image);
    }
    if (loading) {
      const dots = document.createElement('span');
      dots.className = 'assistant-typing';
      dots.setAttribute('aria-label', 'المساعد يكتب');
      for (let i = 0; i < 3; i++) dots.append(document.createElement('i'));
      bubble.append(dots);
    } else {
      appendText(bubble, 'span', content);
      appendText(bubble, 'small', timeLabel(), 'assistant-message-time');
    }
    row.append(bubble);
    messages.append(row);
    scrollDown();
    return row;
  }

  function remember(role, content) {
    history.push({ role, content: String(content).slice(0, 1500) });
    history = history.slice(-MAX_SAVED_MESSAGES);
    saveHistory(history);
  }

  function renderHistory() {
    for (const item of history) addMessage(item.role, item.content);
  }

  function setAttachment(value) {
    if (attachment && attachment.url !== value?.url && !usedImageUrls.has(attachment.url)) URL.revokeObjectURL(attachment.url);
    attachment = value;
    preview.hidden = !value;
    if (value) {
      byId('assistant-preview-image').src = value.url;
      byId('assistant-preview-name').textContent = value.name;
    } else {
      byId('assistant-preview-image').removeAttribute('src');
      imageInput.value = '';
    }
  }

  async function attachFile(file) {
    if (!file) return;
    clearError();
    try {
      const next = await prepareImage(file);
      setAttachment(next);
    } catch (error) { showError(error.message); imageInput.value = ''; }
  }

  function addAction(action, download) {
    if (action?.type === 'navigate' && ['employees', 'reports', 'settings'].includes(action.section)) {
      const card = document.createElement('div');
      card.className = 'assistant-action';
      appendText(card, 'strong', 'الخطوة التالية');
      const labels = { employees: 'افتحي سجل العاملين', reports: 'افتحي الكشوف والتصدير', settings: 'افتحي الربط والإعدادات' };
      const button = appendText(card, 'button', labels[action.section], 'button secondary small');
      button.type = 'button';
      button.addEventListener('click', () => { location.hash = action.section; });
      messages.append(card);
    }
    if (download && typeof download.url === 'string') {
      try {
        const url = new URL(download.url, location.origin);
        if (url.origin !== location.origin || !/^\/api\/assistant\/download\/[\w-]{32}$/.test(url.pathname)) return;
        const card = document.createElement('div');
        card.className = 'assistant-action';
        appendText(card, 'strong', 'الملف جاهز');
        const format = String(download.filename || '').toLowerCase().endsWith('.pdf') ? 'PDF' : String(download.filename || '').toLowerCase().endsWith('.xlsx') ? 'Excel' : 'Word';
        const anchor = appendText(card, 'a', `تحميل ملف ${format}`, 'button primary small');
        anchor.href = url.href;
        anchor.download = String(download.filename || 'كشف المدرسة.docx');
        messages.append(card);
      } catch { /* Ignore an invalid download URL. */ }
    }
    scrollDown();
  }

  function addConfirmation(pendingAction) {
    if (!pendingAction || typeof pendingAction.token !== 'string') return;
    const card = document.createElement('div');
    card.className = 'assistant-action needs-confirmation';
    appendText(card, 'strong', pendingAction.label || 'تأكيد إجراء');
    appendText(card, 'p', pendingAction.details || 'راجعي الإجراء قبل تنفيذه.');
    const actions = document.createElement('div');
    actions.className = 'assistant-action-buttons';
    const confirm = appendText(actions, 'button', 'تأكيد التنفيذ', 'button primary small');
    confirm.type = 'button';
    const cancel = appendText(actions, 'button', 'إلغاء', 'button secondary small');
    cancel.type = 'button';
    card.append(actions);
    messages.append(card);
    scrollDown();
    cancel.addEventListener('click', () => {
      actions.remove();
      appendText(card, 'small', 'أُلغي الإجراء، ولم يتغير شيء.', 'assistant-action-note');
    });
    confirm.addEventListener('click', async () => {
      if (busy) return;
      const epoch = chatEpoch;
      busy = true; updateSend(); clearError();
      confirm.disabled = true; cancel.disabled = true;
      confirm.textContent = 'جارٍ التنفيذ…';
      try {
        const result = await send('/assistant/confirm', 'POST', { token: pendingAction.token });
        if (epoch !== chatEpoch) return;
        actions.remove();
        appendText(card, 'small', 'تم تنفيذ الإجراء بعد تأكيدك.', 'assistant-action-note');
        if (typeof result.reply === 'string' && result.reply.trim()) {
          addMessage('assistant', result.reply);
          remember('assistant', result.reply);
        }
        try { await onDataChanged?.(); }
        catch { showError('تم تنفيذ الإجراء، لكن تعذر تحديث البيانات المعروضة. حدّثي الصفحة لرؤية النتيجة.'); }
      } catch (error) {
        if (epoch !== chatEpoch) return;
        confirm.disabled = false; cancel.disabled = false;
        confirm.textContent = 'إعادة المحاولة';
        showError(error.message || 'تعذر تنفيذ الإجراء.');
      } finally { busy = false; updateSend(); }
    });
  }

  async function refreshStatus() {
    const badge = byId('assistant-status');
    badge.textContent = 'جارٍ فحص المساعد…';
    badge.classList.remove('unavailable');
    try {
      const status = await request('/assistant/status', { cache: 'no-store' });
      available = Boolean(status.available);
      configured = Boolean(status.configured);
      view.classList.toggle('needs-setup', !configured);
      everChecked = true;
      badge.textContent = available ? 'المساعد جاهز' : (configured ? 'المساعد غير متاح مؤقتًا' : 'المساعد يحتاج ربطًا');
      badge.classList.toggle('unavailable', !available);
      byId('assistant-capability').textContent = status.message || (available ? 'مستعد للمساعدة في سجل المدرسة' : 'احفظي مفتاح الخدمة من إعدادات المساعد');
      const local = Boolean(isLocalAccess?.());
      keyPanel.hidden = !local || configured;
      manageKey.hidden = !local || !configured;
      removeKey.hidden = !configured;
      if (configured) keyInput.placeholder = 'أدخلي مفتاحًا جديدًا للاستبدال';
      if (!available && !configured && !local) showError('يلزم أن يحفظ مدير البرنامج مفتاح المساعد مرة واحدة قبل استخدامه على الأجهزة الأخرى.');
      else if (available) clearError();
      updateSend();
      return status;
    } catch (error) {
      available = false;
      view.classList.add('needs-setup');
      badge.textContent = 'تعذر الاتصال بالمساعد';
      badge.classList.add('unavailable');
      byId('assistant-capability').textContent = 'راجعي اتصال البرنامج وحاولي إعادة الفحص.';
      showError(error.message || 'تعذر التحقق من المساعد.');
      updateSend();
      return null;
    }
  }

  async function sendMessage() {
    if (busy) return;
    clearError();
    if (!available) { showError('المساعد غير جاهز الآن. افحصي حالة الربط أو احفظي مفتاح الخدمة.'); return; }
    const raw = input.value.trim();
    if (!raw && !attachment) { input.focus(); return; }
    if (raw.length > 2000) { showError('الرسالة طويلة جدًا. اختصريها إلى ٢٠٠٠ حرف.'); return; }
    const displayMessage = raw || 'صورة مرفقة';
    const image = attachment;
    const epoch = chatEpoch;
    const context = history.slice(-MAX_API_HISTORY).map(({ role, content }) => ({ role, content: content.slice(0, 1500) }));
    const outgoing = addMessage('user', displayMessage, { imageUrl: image?.url });
    const loading = addMessage('assistant', '', { loading: true });
    busy = true; updateSend();
    try {
      const selection = getExportFormat();
      const exportFormat = ['word', 'excel', 'pdf'].includes(selection) ? selection : 'word';
      const result = await send('/assistant/chat', 'POST', { message: raw, history: context, exportFormat, ...(image ? { image: { mimeType: image.mimeType, dataBase64: image.dataBase64 } } : {}) });
      if (epoch !== chatEpoch) return;
      loading.remove();
      remember('user', displayMessage);
      if (image) usedImageUrls.add(image.url);
      input.value = '';
      setAttachment(null);
      const reply = result.clientAction?.type === 'navigate'
        ? 'تقدري تفتحي القسم المطلوب من الزر اللي تحت.'
        : (typeof result.reply === 'string' && result.reply.trim() ? result.reply : 'تمت معالجة طلبك.');
      addMessage('assistant', reply);
      remember('assistant', reply);
      addConfirmation(result.pendingAction);
      addAction(result.clientAction, result.download);
      if (image) appendText(messages, 'p', 'لو هتسألي بعد كده عن نفس الصورة، ارفقيها تاني؛ الصورة مش محفوظة مع المحادثة.', 'assistant-image-hint');
      scrollDown();
    } catch (error) {
      if (epoch !== chatEpoch) return;
      loading.remove(); outgoing.remove();
      showError(error.message || 'تعذر إرسال الرسالة. حاولي مرة أخرى.');
      if (!history.length && !messages.children.length) showWelcome();
    } finally { busy = false; updateSend(); }
  }

  function showWelcome() {
    const welcome = document.createElement('div');
    welcome.className = 'assistant-welcome';
    const icon = appendText(welcome, 'div', '✦', 'assistant-welcome-icon');
    icon.setAttribute('aria-hidden', 'true');
    appendText(welcome, 'h2', 'أهلاً بيكِ');
    appendText(welcome, 'p', 'قوليلي عايزة تعملي إيه في سجل المدرسة. ممكن تكتبي طلبك أو تبعتي صورة للتوضيح.');
    messages.replaceChildren(welcome);
  }

  function clearHistory() {
    chatEpoch++;
    history = [];
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* Session storage may be disabled. */ }
    for (const url of usedImageUrls) URL.revokeObjectURL(url);
    usedImageUrls.clear();
    setAttachment(null);
    input.value = '';
    clearError();
    showWelcome();
  }

  form.addEventListener('submit', event => { event.preventDefault(); sendMessage(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMessage(); } });
  imageInput.addEventListener('change', event => attachFile(event.target.files?.[0]));
  byId('assistant-remove-image').addEventListener('click', () => setAttachment(null));
  newChatButton.addEventListener('click', clearHistory);
  byId('assistant-check-status').addEventListener('click', refreshStatus);
  manageKey.addEventListener('click', () => { keyPanel.hidden = !keyPanel.hidden; if (!keyPanel.hidden) keyInput.focus(); });
  keyForm.addEventListener('submit', async event => {
    event.preventDefault();
    const apiKey = keyInput.value.trim();
    if (!apiKey) { showError('اكتبي مفتاح Groq API أولًا.'); return; }
    const button = keyForm.querySelector('button[type="submit"]');
    button.disabled = true;
    clearError();
    try {
      await send('/assistant/settings', 'PUT', { apiKey });
      keyInput.value = '';
      toast('تم حفظ مفتاح المساعد.');
      await refreshStatus();
    } catch (error) { showError(error.message || 'تعذر حفظ المفتاح.'); }
    finally { button.disabled = false; }
  });
  removeKey.addEventListener('click', async () => {
    removeKey.disabled = true;
    try {
      await send('/assistant/settings', 'DELETE');
      keyInput.value = '';
      toast('تم حذف مفتاح المساعد.');
      await refreshStatus();
    } catch (error) { showError(error.message || 'تعذر حذف المفتاح.'); }
    finally { removeKey.disabled = false; }
  });
  document.querySelectorAll('[data-assistant-example]').forEach(button => button.addEventListener('click', () => {
    input.value = button.dataset.assistantExample;
    input.focus();
  }));
  input.addEventListener('paste', event => {
    const file = [...(event.clipboardData?.files || [])].find(item => ALLOWED_IMAGE_TYPES.has(item.type));
    if (file) { event.preventDefault(); attachFile(file); }
  });
  chat.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types || [])].includes('Files')) { event.preventDefault(); chat.classList.add('assistant-dragover'); } });
  chat.addEventListener('dragleave', event => { if (!chat.contains(event.relatedTarget)) chat.classList.remove('assistant-dragover'); });
  chat.addEventListener('drop', event => {
    event.preventDefault(); chat.classList.remove('assistant-dragover');
    const file = [...(event.dataTransfer?.files || [])].find(item => ALLOWED_IMAGE_TYPES.has(item.type));
    if (file) attachFile(file);
  });
  window.addEventListener('pagehide', () => {
    for (const url of usedImageUrls) URL.revokeObjectURL(url);
    if (attachment && !usedImageUrls.has(attachment.url)) URL.revokeObjectURL(attachment.url);
  });

  renderHistory();
  updateSend();
  return { refreshStatus, clearHistory, get checked() { return everChecked; } };
}
