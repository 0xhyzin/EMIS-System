const BASE_URL = '';

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

export async function exportWord(config) {
  try {
    const response = await fetch(`${BASE_URL}/api/export/word`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(config)
    });
    
    if (!response.ok) {
      throw new Error('فشل تصدير الملف');
    }
    
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${config.title || 'بيانات_الموظفين'}.docx`;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    a.remove();
  } catch (error) {
    console.error('Export Error:', error);
    throw error;
  }
}

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
