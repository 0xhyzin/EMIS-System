import { exportWord, uploadLogo } from './api.js';

let currentColumns = [];
let currentSorting = [];
let currentFilters = [];

export function initExport(container) {
  container.innerHTML = `
    <div class="export-layout">
      <div class="card export-settings">
        <h3 style="margin-bottom:1rem;">📄 إعدادات قالب الصفحة</h3>

        <div class="form-group">
          <label>عنوان الكشف</label>
          <input type="text" id="export-title" class="form-control" value="أسماء العاملين بالمدرسة">
        </div>

        <div class="row">
          <div class="col-6">
            <div class="form-group">
              <label>اتجاه الصفحة</label>
              <div class="direction-toggle">
                <label class="radio-container">
                  <input type="radio" name="orientation" value="portrait" checked>
                  <span class="radio-mark"></span>
                  طولي
                </label>
                <label class="radio-container">
                  <input type="radio" name="orientation" value="landscape">
                  <span class="radio-mark"></span>
                  عرضي
                </label>
              </div>
            </div>
          </div>
          <div class="col-6">
            <div class="form-group">
              <label>شكل الأرقام</label>
              <div class="direction-toggle">
                <label class="radio-container">
                  <input type="radio" name="numerals" value="western" checked>
                  <span class="radio-mark"></span>
                  إنجليزي (1,2,3)
                </label>
                <label class="radio-container">
                  <input type="radio" name="numerals" value="arabic">
                  <span class="radio-mark"></span>
                  عربي (١,٢,٣)
                </label>
              </div>
            </div>
          </div>
        </div>

        <div class="row">
          <div class="col-12">
            <div class="form-group">
              <label>شعار المدرسة (اختياري)</label>
              <div class="file-upload-wrapper">
                <input type="file" id="logo-upload" accept="image/*" class="d-none">
                <button class="btn btn-outline w-100" id="btn-upload-logo">
                  <span class="icon">🖼️</span> اختر صورة
                </button>
                <div id="logo-preview" class="mt-2 text-center text-success small"></div>
              </div>
            </div>
          </div>
        </div>

        <hr style="border-color: var(--glass-border); margin: 1rem 0;">

        <h4 style="margin-bottom: 0.75rem;">✍️ التوقيعات (تظهر في ذيل كل صفحة)</h4>
        <p class="text-muted small mb-3">الترتيب من اليمين: إحصاء ← تقويم ← مدير المدرسة</p>
        <div class="signatures-grid">
          <div class="sig-field">
            <label>إحصاء (يمين)</label>
            <input type="text" id="footer-1" class="form-control" placeholder="اسم موظف الإحصاء">
          </div>
          <div class="sig-field">
            <label>تقويم (وسط)</label>
            <input type="text" id="footer-2" class="form-control" placeholder="اسم موظف التقويم">
          </div>
          <div class="sig-field">
            <label>مدير المدرسة (يسار)</label>
            <input type="text" id="footer-3" class="form-control" placeholder="اسم المدير/ة">
          </div>
        </div>

        <div class="mt-4">
          <button class="btn btn-primary w-100 btn-lg pulse-effect" id="btn-export-word">
            <span class="icon">📄</span> تصدير إلى Word
          </button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btn-upload-logo').addEventListener('click', () => {
    document.getElementById('logo-upload').click();
  });

  document.getElementById('logo-upload').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) {
      try {
        const preview = document.getElementById('logo-preview');
        preview.innerHTML = '<span class="spinner-small"></span> جاري الرفع...';
        await uploadLogo(file);
        preview.textContent = '✅ ' + file.name;
        window.app.showToast('تم رفع الشعار بنجاح', 'success');
      } catch (err) {
        document.getElementById('logo-preview').textContent = '❌ فشل الرفع';
        window.app.showToast(err.message, 'error');
      }
    }
  });

  document.getElementById('btn-export-word').addEventListener('click', handleExport);
}

let currentStaffType = 'all';

export function updateExportContext(columns, sorting, filters, staffType) {
  currentColumns = columns;
  currentSorting = sorting;
  currentFilters = filters || [];
  currentStaffType = staffType || 'all';
}

function getExportConfig() {
  return {
    title: document.getElementById('export-title')?.value || '',
    orientation: document.querySelector('input[name="orientation"]:checked')?.value || 'portrait',
    useArabicNumerals: document.querySelector('input[name="numerals"]:checked')?.value === 'arabic',
    footer: [
      document.getElementById('footer-1')?.value || '',
      document.getElementById('footer-2')?.value || '',
      document.getElementById('footer-3')?.value || '',
    ],
    columns: currentColumns,
    sorting: currentSorting,
    filters: currentFilters,
    staffType: currentStaffType === 'all' ? undefined : currentStaffType
  };
}

async function handleExport() {
  if (!currentColumns || currentColumns.length === 0) {
    window.app.showToast('يجب اختيار أعمدة للجدول أولاً', 'error');
    return;
  }

  const btn = document.getElementById('btn-export-word');
  const originalHtml = btn.innerHTML;
  
  try {
    btn.innerHTML = '<span class="spinner-small"></span> جاري التصدير...';
    btn.disabled = true;
    
    const config = getExportConfig();
    await exportWord(config);
    
    window.app.showToast('تم تصدير الملف بنجاح! ✅', 'success');
  } catch (error) {
    window.app.showToast('فشل التصدير: ' + error.message, 'error');
  } finally {
    btn.innerHTML = originalHtml;
    btn.disabled = false;
  }
}
