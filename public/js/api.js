const BASE_URL = '';

export const EXPORT_FORMATS = Object.freeze({
  word: Object.freeze({ label: 'Word', extension: 'docx', endpoint: '/api/export/word' }),
  excel: Object.freeze({ label: 'Excel', extension: 'xlsx', endpoint: '/api/export/excel' }),
  pdf: Object.freeze({ label: 'PDF', extension: 'pdf', endpoint: '/api/export/pdf' }),
});

export function exportFormatInfo(format = 'word') {
  if (!Object.hasOwn(EXPORT_FORMATS, format)) throw new Error('اختر صيغة Word أو Excel أو PDF.');
  return EXPORT_FORMATS[format];
}

// All formats receive the same custom table and employee selection.
export function createReportExport(config, format = 'word') {
  const info = exportFormatInfo(format);
  const title = config.modelId === 'hourly-contract-period-1'
    ? 'نموذج 2 بالحصة دون سن الستين الفترة الأولى'
    : config.title || 'كشف العاملين';
  return {
    url: info.endpoint,
    filename: `${String(title).replace(/[\\/:*?"<>|\u0000-\u001F]/g, '-').trim() || 'كشف العاملين'}.${info.extension}`,
    options: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) },
  };
}

async function fetchApi(endpoint, options = {}) {
  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP error! status: ${response.status}`);
    }
    
    // Check if the response is JSON
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
        return await response.json();
    }
    return await response.text();
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

export async function saveTokens(bearerToken, utToken) {
  return fetchApi('/api/auth/tokens', {
    method: 'POST',
    body: JSON.stringify({ bearerToken, utToken })
  });
}

export async function getTokens() {
  return fetchApi('/api/auth/tokens');
}

export function startSync(onProgress, onComplete, onError) {
  const es = new EventSource(`${BASE_URL}/api/sync/start`);
  es.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.step === 'done') {
        onComplete(data);
        es.close();
      } else if (data.step === 'error') {
        onError(data);
        es.close();
      } else {
        onProgress(data);
      }
    } catch (e) {
      console.error('Error parsing SSE message:', e);
    }
  };
  es.onerror = () => {
    onError({ message: 'انقطع الاتصال بالخادم. يرجى المحاولة مرة أخرى.' });
    es.close();
  };
  return es;
}

export async function getEmployees(staffType) {
  const params = staffType ? `?staffType=${staffType}` : '';
  return fetchApi(`/api/employees${params}`);
}

export async function getEmployeeCount() {
  return fetchApi('/api/employees/count');
}

export async function getReferenceValues(fieldKey) {
  return fetchApi(`/api/reference/${encodeURIComponent(fieldKey)}`);
}

export async function getAllReferenceFields() {
  return fetchApi('/api/reference');
}

export async function updateReferenceOrder(fieldKey, values) {
  return fetchApi(`/api/reference/${encodeURIComponent(fieldKey)}/order`, {
    method: 'PUT',
    body: JSON.stringify({ values })
  });
}

export async function saveTableConfig(config) {
  return fetchApi('/api/table-config', {
    method: 'POST',
    body: JSON.stringify(config)
  });
}

export async function getTableConfigs() {
  return fetchApi('/api/table-config');
}

export async function deleteTableConfig(id) {
  return fetchApi(`/api/table-config/${id}`, {
    method: 'DELETE'
  });
}

export async function exportReport(config, format = 'word') {
  try {
    const report = createReportExport(config, format);
    const response = await fetch(`${BASE_URL}${report.url}`, { credentials: 'same-origin', ...report.options });
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'فشل تصدير الملف');
    }
    
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = report.filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => window.URL.revokeObjectURL(url), 30_000);
  } catch (error) {
    console.error('Export Error:', error);
    throw error;
  }
}

export const exportWord = config => exportReport(config, 'word');
export const exportExcel = config => exportReport(config, 'excel');

export async function uploadLogo(file) {
  const formData = new FormData();
  formData.append('logo', file);
  
  const response = await fetch(`${BASE_URL}/api/upload-logo`, {
    method: 'POST',
    body: formData
  });
  
  if (!response.ok) {
    throw new Error('فشل رفع الشعار');
  }
  
  return await response.json();
}
